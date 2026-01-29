/**
 * OpenAI-powered product ranking for EditMuse
 * 
 * Safety features:
 * - Timeout protection (30s)
 * - JSON schema validation
 * - Fallback to non-AI sorting
 * - No PII in prompts
 * - Error handling
 * - Caching layer (30-50% cost savings)
 */

// NOTE: Billing is handled separately after final results are computed

import crypto from "crypto";
import prisma from "~/db.server";

interface ProductCandidate {
  handle: string;
  title: string;
  tags: string[];
  productType: string | null;
  vendor: string | null;
  price: string | null;
  description: string | null;
  available: boolean;
  sizes?: string[];
  colors?: string[];
  materials?: string[];
  optionValues?: Record<string, string[]>;
}

interface RankingResult {
  ranked_handles: string[];
  reasoning: string;
}

interface HardConstraints {
  hardTerms: string[];
  hardFacets?: {
    size?: string[];
    color?: string[];
    material?: string[];
  };
  avoidTerms: string[];
  trustFallback: boolean;
  isBundle?: boolean;
  bundleItems?: Array<{ hardTerms: string[]; quantity: number; budgetMax?: number }>;
}

interface Evidence {
  matchedHardTerms: string[];
  matchedFacets?: {
    size?: string[];
    color?: string[];
    material?: string[];
  };
  fieldsUsed: string[];
}

interface SelectedItem {
  handle: string;
  label: "exact" | "alternative";
  score: number;
  evidence: Evidence;
  reason: string;
}

interface RejectedCandidate {
  handle: string;
  why: string;
}

interface StructuredRankingResult {
  trustFallback: boolean;
  selected: SelectedItem[];
  rejected_candidates?: RejectedCandidate[];
}

interface BundleSelectedItem extends SelectedItem {
  itemIndex: number;
}

interface StructuredBundleResult {
  trustFallback: boolean;
  selected_by_item: BundleSelectedItem[];
  selected?: SelectedItem[]; // Optional fallback for backward compatibility
  rejected_candidates?: RejectedCandidate[];
}

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? "20000"); // Configurable timeout, default 20 seconds
const TIMEOUT_MS_BUNDLE = Number(process.env.OPENAI_TIMEOUT_MS_BUNDLE ?? "12000"); // Stricter timeout for bundle mode, default 12 seconds
const MAX_RETRIES = 1; // Max 1 retry, so at most 2 attempts total (initial attempt + 1 retry)
const CACHE_DURATION_HOURS = 0; // Cache disabled - always use fresh AI ranking
const MAX_DESCRIPTION_LENGTH = 1000; // Increased from 200 to allow full description analysis

// Service tier configuration for Responses API
const SERVICE_TIER_VALUES = ["auto", "default", "priority", "flex"] as const;
type ServiceTier = typeof SERVICE_TIER_VALUES[number];
const getServiceTier = (): ServiceTier => {
  const envTier = process.env.OPENAI_SERVICE_TIER?.toLowerCase();
  if (envTier && SERVICE_TIER_VALUES.includes(envTier as ServiceTier)) {
    return envTier as ServiceTier;
  }
  return "auto"; // Default value
};

// Prompt cache configuration
const SCHEMA_VERSION = "1.0"; // Schema version for prompt cache key stability
const getPromptCacheRetention = (): string => {
  return process.env.OPENAI_PROMPT_CACHE_RETENTION ?? "24h";
};

// Generate stable prompt cache key (industry-agnostic)
function generatePromptCacheKey(
  schemaVersion: string,
  experienceId: string | null | undefined,
  mode: "single" | "bundle",
  candidateCount: number
): string {
  // Bucket candidate count for stability (0-20, 21-40, 41-60, etc.)
  const candidateCountBucket = Math.floor(candidateCount / 20) * 20;
  
  // Create stable cache key components
  const keyData = {
    schemaVersion,
    experienceId: experienceId || "default",
    mode,
    candidateCountBucket,
  };
  
  // Hash the key data for stable cache key
  // Using a simple hash since we want deterministic keys
  const keyString = JSON.stringify(keyData);
  let hash = 0;
  for (let i = 0; i < keyString.length; i++) {
    const char = keyString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Return positive hash as hex string
  return `editmuse_${Math.abs(hash).toString(16)}`;
}

// Models that support JSON mode (response_format: { type: "json_object" })
const JSON_MODE_SUPPORTED_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4-turbo-preview",
  "gpt-3.5-turbo",
  "o1-preview",
  "o1-mini",
]);

// Models that support JSON schema (response_format: { type: "json_schema", json_schema: {...} })
const JSON_SCHEMA_SUPPORTED_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4-turbo-preview",
]);

/**
 * Strips HTML tags and cleans product description
 * Removes HTML entities, preserves text content
 */
function cleanDescription(description: string | null | undefined): string {
  if (!description) return "";
  
  // Remove HTML tags while preserving text content
  let cleaned = description
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "") // Remove script tags
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "") // Remove style tags
    .replace(/<[^>]+>/g, " ") // Remove all HTML tags
    .replace(/&nbsp;/g, " ") // Replace non-breaking spaces
    .replace(/&amp;/g, "&") // Decode HTML entities
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
  
  return cleaned;
}

/**
 * Enhances and normalizes user intent for better AI understanding
 * Expands abbreviations, normalizes language, adds context
 */
function enhanceUserIntent(userIntent: string): string {
  if (!userIntent || userIntent.trim().length === 0) {
    return "No specific intent provided";
  }
  
  let enhanced = userIntent.trim();
  
  // Common abbreviation expansions
  const abbreviations: Record<string, string> = {
    "w/": "with",
    "w/o": "without",
    "vs": "versus",
    "e.g.": "for example",
    "etc.": "and so on",
    "approx": "approximately",
    "min": "minimum",
    "max": "maximum",
  };
  
  for (const [abbrev, expansion] of Object.entries(abbreviations)) {
    const regex = new RegExp(`\\b${abbrev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    enhanced = enhanced.replace(regex, expansion);
  }
  
  // Normalize common shopping intent patterns
  enhanced = enhanced
    .replace(/\bi'm looking for\b/gi, "I need")
    .replace(/\bi want\b/gi, "I need")
    .replace(/\bi need\b/gi, "I need")
    .replace(/\bsomething\b/gi, "a product")
    .replace(/\bstuff\b/gi, "items")
    .replace(/\bthings\b/gi, "products");
  
  return enhanced;
}

/**
 * Typed error for JSON parsing failures
 */
class JSONParseError extends Error {
  constructor(message: string, public readonly originalContent: string) {
    super(message);
    this.name = "JSONParseError";
  }
}

/**
 * Parses structured ranking JSON from OpenAI response content
 * Handles markdown fences, extracts JSON object, removes trailing commas, and parses
 * @throws {JSONParseError} if parsing fails
 */
function parseStructuredRanking(content: string): StructuredRankingResult | StructuredBundleResult {
  if (!content || typeof content !== "string") {
    throw new JSONParseError("Content is empty or not a string", content || "");
  }
  
  let cleaned = content.trim();
  
  // 1) Strip markdown fences
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }
  
  // 2) Find first '{' and last '}' and extract that slice
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new JSONParseError("Could not find valid JSON object boundaries", content);
  }
  
  let jsonSlice = cleaned.substring(firstBrace, lastBrace + 1);
  
  // 3) Remove trailing commas before ']' or '}'
  // This regex matches a comma followed by optional whitespace and then ']' or '}'
  // Apply multiple times to handle nested cases (e.g., "], }")
  let prevLength = 0;
  while (jsonSlice.length !== prevLength) {
    prevLength = jsonSlice.length;
    jsonSlice = jsonSlice.replace(/,(\s*[}\]])/g, "$1");
  }
  
  // 4) Fix missing commas more intelligently
  // We need to be careful not to break valid JSON, so we'll use a more targeted approach
  
  // Fix: missing comma between closing brace/bracket and opening brace/bracket
  // Pattern: "}" or "]" followed by "{" or "["
  jsonSlice = jsonSlice.replace(/([}\]"])\s*([{[])/g, '$1, $2');
  
  // Fix: missing comma between closing brace/bracket and property name
  // Pattern: "}" or "]" followed by a quoted string (property name)
  jsonSlice = jsonSlice.replace(/([}\]"])\s*"([^"]+)":/g, '$1, "$2":');
  
  // Fix: missing comma after string value before another value
  // Pattern: closing quote followed by opening quote (array/object element)
  // But be careful: only if not already followed by comma
  jsonSlice = jsonSlice.replace(/([^\\]")"([^,\s}\]])/g, (match, p1, p2) => {
    // Check if p2 looks like the start of a new property or array element
    if (p2 === '"' || p2 === '{' || p2 === '[' || /^\d/.test(p2) || p2 === 't' || p2 === 'f' || p2 === 'n') {
      return p1 + '", ' + p2;
    }
    return match;
  });
  
  // Fix: missing comma after number before another value
  // Pattern: digit followed by quote, brace, or bracket (but not already comma)
  jsonSlice = jsonSlice.replace(/(\d)\s+(["{[])/g, '$1, $2');
  
  // Fix: missing comma after boolean/null before another value
  jsonSlice = jsonSlice.replace(/(true|false|null)\s+(["{[])/g, '$1, $2');
  
  // 7) Attempt JSON.parse with retry on failure
  let parsed: any;
  let lastParseError: string | null = null;
  
  // First attempt: try as-is
  try {
    parsed = JSON.parse(jsonSlice);
    return parsed as StructuredRankingResult;
  } catch (err) {
    lastParseError = err instanceof Error ? err.message : String(err);
    
    // Second attempt: try to fix common issues
    let fixed = jsonSlice;
    
    // Fix: missing comma between array elements (e.g., "]" "{" should be "], {")
    fixed = fixed.replace(/([}\]"])\s*([{["])/g, '$1, $2');
    
    // Fix: missing comma after closing brace/bracket before property name
    fixed = fixed.replace(/([}\]"])\s*"([^"]+)":/g, '$1, "$2":');
    
    // Fix: missing comma after closing brace/bracket before opening brace/bracket
    fixed = fixed.replace(/([}\]"])\s*([{[])/g, '$1, $2');
    
    // Remove any double commas that might have been created
    fixed = fixed.replace(/,+/g, ',');
    fixed = fixed.replace(/,\s*,/g, ',');
    
    try {
      parsed = JSON.parse(fixed);
      console.log("[AI Ranking] Fixed JSON syntax errors and successfully parsed");
      return parsed as StructuredRankingResult;
    } catch (retryErr) {
      // Third attempt: More aggressive array repair (handles "Expected ',' or ']' after array element")
      // Use a more comprehensive approach to fix array syntax
      let repaired = fixed;
      
      // Fix missing commas in arrays - more aggressive patterns
      // Pattern 1: Value followed by value without comma (any type)
      repaired = repaired.replace(/([^,\s\]}])\s+(["{[\d])/g, '$1, $2'); // Any value before bracket/brace/quote/digit
      repaired = repaired.replace(/([^,\s\]}]")\s*"([^,\s\]}])/g, '$1, "$2'); // String before string
      repaired = repaired.replace(/(\d+)\s+(["{[\d])/g, '$1, $2'); // Number before value
      repaired = repaired.replace(/(true|false|null)\s+(["{[\d])/g, '$1, $2'); // Boolean/null before value
      repaired = repaired.replace(/([}\]"])\s*([{["\d])/g, '$1, $2'); // Closing bracket/brace/quote before opening
      
      // Fix missing commas in nested structures
      repaired = repaired.replace(/([}\]"])\s*"([^"]+)":/g, '$1, "$2":'); // Missing comma before property
      repaired = repaired.replace(/([}\]"])\s*([{[])/g, '$1, $2'); // Missing comma between structures
      
      // Remove double commas and clean up
      repaired = repaired.replace(/,+/g, ',');
      repaired = repaired.replace(/,\s*,/g, ',');
      repaired = repaired.replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas
      
      try {
        parsed = JSON.parse(repaired);
        console.log("[AI Ranking] Fixed JSON syntax errors (aggressive repair) and successfully parsed");
        return parsed as StructuredRankingResult;
      } catch (finalErr) {
        // Fourth attempt: Try to extract valid JSON using balanced bracket matching
        const balancedJson = extractBalancedJSON(content);
        if (balancedJson) {
          try {
            // Clean the extracted JSON
            let cleaned = balancedJson.replace(/,+/g, ',').replace(/,\s*,/g, ',').replace(/,\s*([}\]])/g, '$1');
            parsed = JSON.parse(cleaned);
            console.log("[AI Ranking] Extracted and parsed balanced JSON");
            return parsed as StructuredRankingResult;
          } catch (extractErr) {
            // Extraction failed too
          }
        }
        
        // All attempts failed
        const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const finalError = finalErr instanceof Error ? finalErr.message : String(finalErr);
        throw new JSONParseError(`JSON.parse failed: ${lastParseError}. Retry after fixes also failed: ${retryError}. Aggressive repair failed: ${finalError}`, content);
      }
    }
  }
}

/**
 * Extracts the first balanced JSON object from text, stripping leading/trailing text
 */
function extractBalancedJSON(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  
  let trimmed = text.trim();
  
  // Remove markdown code blocks if present
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (codeBlockMatch) {
    trimmed = codeBlockMatch[1].trim();
  }
  
  // Find the first opening brace
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace === -1) return null;
  
  // Extract from first brace and find balanced closing brace
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = firstBrace; i < trimmed.length; i++) {
    const char = trimmed[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          // Found balanced JSON object
          return trimmed.substring(firstBrace, i + 1);
        }
      }
    }
  }
  
  return null; // Unbalanced braces
}

/**
 * Validates that the parsed JSON matches the expected schema
 */
function validateRankingSchema(
  parsed: any,
  trustFallback: boolean,
  candidateHandles: Set<string>,
  hardTermsCount: number
): { valid: boolean; reason?: string } {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, reason: "Not an object" };
  }
  
  if (typeof parsed.trustFallback !== "boolean") {
    return { valid: false, reason: "Missing or invalid trustFallback field" };
  }
  
  if (!Array.isArray(parsed.selected)) {
    return { valid: false, reason: "Missing or invalid selected array" };
  }
  
  // Validate each selected item
  for (const item of parsed.selected) {
    if (!item || typeof item !== "object") {
      return { valid: false, reason: "Invalid selected item (not an object)" };
    }
    
    if (typeof item.handle !== "string" || !item.handle.trim()) {
      return { valid: false, reason: "Invalid handle in selected item" };
    }
    
    if (!candidateHandles.has(item.handle.trim())) {
      return { valid: false, reason: `Handle ${item.handle} not in candidates` };
    }
    
    if (item.label !== "exact" && item.label !== "alternative") {
      return { valid: false, reason: `Invalid label: ${item.label}` };
    }
    
    if (typeof item.score !== "number" || item.score < 0 || item.score > 100) {
      return { valid: false, reason: `Invalid score: ${item.score}` };
    }
    
    if (!item.evidence || typeof item.evidence !== "object") {
      return { valid: false, reason: "Missing or invalid evidence" };
    }
    
    if (!Array.isArray(item.evidence.matchedHardTerms)) {
      return { valid: false, reason: "Invalid matchedHardTerms array" };
    }
    
    // If trustFallback=false AND hardTerms exist, require at least one matchedHardTerm
    // If hardTerms.length===0, allow matchedHardTerms to be empty
    const allowEmptyMatchedHardTerms = hardTermsCount === 0;
    if (!trustFallback && !allowEmptyMatchedHardTerms && item.evidence.matchedHardTerms.length === 0) {
      return { valid: false, reason: "No matchedHardTerms when trustFallback=false and hardTerms exist" };
    }
    
    if (typeof item.reason !== "string") {
      return { valid: false, reason: "Missing or invalid reason" };
    }
  }
  
  return { valid: true };
}

/**
 * Checks if AI ranking is enabled
 */
export function isAIRankingEnabled(): boolean {
  const featureFlag = process.env.FEATURE_AI_RANKING;
  const apiKey = process.env.OPENAI_API_KEY;
  const hasApiKey = !!apiKey;
  
  console.log("[AI Ranking] Checking AI ranking status:");
  console.log("[AI Ranking]   FEATURE_AI_RANKING:", featureFlag || "(not set, default: enabled)");
  console.log("[AI Ranking]   OPENAI_API_KEY:", hasApiKey ? "SET" : "NOT SET");
  
  if (featureFlag === "false" || featureFlag === "0") {
    console.log("[AI Ranking] ❌ DISABLED via FEATURE_AI_RANKING flag");
    return false;
  }
  
  if (!hasApiKey) {
    console.log("[AI Ranking] ❌ DISABLED - OPENAI_API_KEY not set in environment");
    return false;
  }
  
  console.log("[AI Ranking] ✅ ENABLED - AI ranking will be used");
  return true;
}

/**
 * Gets the OpenAI model to use
 */
export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

/**
 * Deterministic ranking: uses preferenceScore if available, otherwise simple sorting
 */
function deterministicRanking(
  candidates: ProductCandidate[],
  resultCount: number,
  variantPreferences?: Record<string, string>,
  parseFailReason?: string | null
): { 
  selectedHandles: string[];
  reasoning?: string | null;
  trustFallback: boolean;
  source: "ai" | "fallback";
  parseFailReason?: string | null;
} {
  // Helper to compute preference score if variantPreferences are provided
  function getCandidateOptionValues(candidate: ProductCandidate, prefKey: string): string[] {
    const ov = candidate?.optionValues ?? {};
    const wanted = prefKey.toLowerCase();

    for (const [k, arr] of Object.entries(ov)) {
      if (k.toLowerCase() === wanted && Array.isArray(arr)) return arr as string[];
    }
    return [];
  }

  function valueMatches(list: string[], desired: string): boolean {
    const d = desired.trim().toLowerCase();
    return list.some(v => {
      const vv = String(v).trim().toLowerCase();
      return vv === d || vv.includes(d) || d.includes(vv);
    });
  }

  function preferenceScore(candidate: ProductCandidate, prefs: Record<string, string>): number {
    let score = 0;
    if (candidate.available) score += 10;

    // +6 per matched preference, cap to avoid over-biasing
    let matched = 0;
    for (const [k, v] of Object.entries(prefs)) {
      if (!v) continue;
      const list = getCandidateOptionValues(candidate, k);
      if (list.length && valueMatches(list, v)) {
        matched++;
        score += 6;
      }
    }
    if (matched >= 3) score += 2; // small bonus for meeting many prefs

    return score;
  }

  // Enhanced deterministic ranking with better scoring
  // Sort candidates
  const sorted = [...candidates].sort((a, b) => {
    // 1) available desc (in-stock first)
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    
    // 2) preferenceScore desc (if variantPreferences provided)
    if (variantPreferences && Object.keys(variantPreferences).length > 0) {
      const sa = preferenceScore(a, variantPreferences);
      const sb = preferenceScore(b, variantPreferences);
      if (sa !== sb) return sb - sa;
    }
    
    // 3) Prefer products with more tags (indicates more metadata/attributes)
    const aTagCount = (a.tags || []).length;
    const bTagCount = (b.tags || []).length;
    if (aTagCount !== bTagCount) {
      return bTagCount - aTagCount;
    }
    
    // 4) Prefer products with descriptions (more information available)
    const aHasDesc = a.description && a.description.trim().length > 0;
    const bHasDesc = b.description && b.description.trim().length > 0;
    if (aHasDesc !== bHasDesc) {
      return bHasDesc ? 1 : -1;
    }
    
    // 5) Use handle as final tiebreaker for consistency
    return a.handle.localeCompare(b.handle);
  });

  const selectedHandles = sorted.slice(0, resultCount).map(p => p.handle);
  
  return {
    selectedHandles,
    reasoning: "Selected the best matches based on your preferences and product quality.",
    trustFallback: true,
    source: "fallback",
    parseFailReason: parseFailReason || null,
  };
}

/**
 * Generates a cache key from user intent and product catalog
 */
function generateCacheKey(
  userIntent: string,
  candidates: ProductCandidate[],
  resultCount: number,
  variantConstraints?: { size: string | null; color: string | null; material: string | null },
  variantPreferences?: Record<string, string>,
  includeTerms?: string[],
  avoidTerms?: string[]
): string {
  // Normalize user intent (trim, lowercase for better cache hits)
  const normalizedIntent = (userIntent || "").trim().toLowerCase();
  
  // Create product hash (just handles, sorted for consistency)
  const productHandles = candidates.map(c => c.handle).sort().join(",");
  
  // Create variant hash
  const variantHash = JSON.stringify({
    constraints: variantConstraints || {},
    preferences: variantPreferences || {},
    includeTerms: (includeTerms || []).sort(),
    avoidTerms: (avoidTerms || []).sort(),
  });
  
  // Combine all inputs
  const cacheInput = `${normalizedIntent}|${productHandles}|${resultCount}|${variantHash}`;
  
  // Generate SHA256 hash
  return crypto.createHash("sha256").update(cacheInput).digest("hex");
}

/**
 * Checks cache for existing ranking result
 * Cache disabled - always returns null to force fresh AI ranking
 */
async function getCachedRanking(
  cacheKey: string,
  shopId?: string
): Promise<{ 
  selectedHandles: string[];
  reasoning?: string | null;
  trustFallback: boolean;
  source: "ai" | "fallback";
  parseFailReason?: string | null;
} | null> {
  // Cache disabled - always return null to force fresh AI ranking
  console.log("[AI Ranking] Cache disabled - will call OpenAI");
  return null;
}

/**
 * Stores ranking result in cache
 * Cache disabled - no-op function
 */
async function setCachedRanking(
  cacheKey: string,
  shopId: string,
  userIntent: string,
  candidates: ProductCandidate[],
  selectedHandles: string[],
  reasoning: string | null,
  resultCount: number
): Promise<void> {
  // Cache disabled - do nothing
  // This function is kept for API compatibility but doesn't cache anything
  return;
}

/**
 * Ranks products using OpenAI based on user intent
 * 
 * @param userIntent - User's answers/summary from quiz/chat
 * @param candidates - Up to 200 candidate products
 * @param resultCount - Number of products to return (8/12/16)
 * @param shopId - Shop ID for usage tracking
 * @param sessionToken - Session token for charge prevention (optional)
 * @param variantConstraints - Size/color/material constraints
 * @param variantPreferences - Variant option preferences
 * @param includeTerms - Keywords to include in results
 * @param avoidTerms - Keywords to avoid in results
 * @param hardConstraints - Hard constraints (hardTerms, hardFacets, avoidTerms, trustFallback)
 * @param experienceId - Experience ID for prompt cache key (optional)
 * @returns Ranked product handles and reasoning (always returns a result, falls back to deterministic ranking if AI fails)
 */
export async function rankProductsWithAI(
  userIntent: string,
  candidates: ProductCandidate[],
  resultCount: number,
  shopId?: string,
  sessionToken?: string,
  variantConstraints?: { size: string | null; color: string | null; material: string | null },
  variantPreferences?: Record<string, string>,
  includeTerms?: string[],
  avoidTerms?: string[],
  hardConstraints?: HardConstraints,
  experienceId?: string | null,
  strictGateCount?: number,
  strictGateCandidates?: ProductCandidate[]
): Promise<{ 
  selectedHandles: string[];
  reasoning?: string | null;
  trustFallback: boolean;
  source: "ai" | "fallback";
  parseFailReason?: string | null;
}> {
  // Helper function to determine fallback scope and candidates
  const getFallbackCandidates = (): { candidates: ProductCandidate[]; scope: "strict_gate" | "full_pool" } => {
    if (strictGateCount !== undefined && strictGateCount > 0 && strictGateCandidates && strictGateCandidates.length > 0) {
      return { candidates: strictGateCandidates, scope: "strict_gate" };
    }
    return { candidates, scope: "full_pool" };
  };

  if (candidates.length === 0) {
    console.log("[AI Ranking] source=fallback parse_fail_reason=No candidates to rank");
    const fallback = getFallbackCandidates();
    console.log("[AI Ranking] fallback_scope=", fallback.scope);
    return deterministicRanking(fallback.candidates, resultCount, variantPreferences, "No candidates to rank");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[AI Ranking] source=fallback parse_fail_reason=OPENAI_API_KEY not set");
    const fallback = getFallbackCandidates();
    console.log("[AI Ranking] fallback_scope=", fallback.scope);
    return deterministicRanking(fallback.candidates, resultCount, variantPreferences, "OPENAI_API_KEY not set");
  }

  if (!isAIRankingEnabled()) {
    console.log("[AI Ranking] source=fallback parse_fail_reason=Feature disabled via FEATURE_AI_RANKING");
    const fallback = getFallbackCandidates();
    console.log("[AI Ranking] fallback_scope=", fallback.scope);
    return deterministicRanking(fallback.candidates, resultCount, variantPreferences, "Feature disabled via FEATURE_AI_RANKING");
  }
  
  // Check cache first
  if (shopId) {
    const cacheKey = generateCacheKey(
      userIntent,
      candidates,
      resultCount,
      variantConstraints,
      variantPreferences,
      includeTerms,
      avoidTerms
    );
    
    const cached = await getCachedRanking(cacheKey, shopId);
    if (cached) {
      return cached; // Return cached result, no OpenAI call needed!
    }
  }

  const model = getOpenAIModel();
  const supportsJsonMode = JSON_MODE_SUPPORTED_MODELS.has(model);
  const supportsJsonSchema = JSON_SCHEMA_SUPPORTED_MODELS.has(model);
  console.log("[AI Ranking] Starting AI ranking with model:", model, "candidates:", candidates.length);
  console.log("[AI Ranking] json_mode=", supportsJsonMode);
  console.log("[AI Ranking] json_schema=", supportsJsonSchema);

  // Enhance user intent for better AI understanding
  const enhancedIntent = enhanceUserIntent(userIntent);
  console.log("[AI Ranking] Enhanced user intent length:", enhancedIntent.length);

  // Extract hard constraints (with defaults)
  const hardTerms = hardConstraints?.hardTerms || [];
  const hardTermsCount = hardTerms.length;
  const hardFacetsRaw = hardConstraints?.hardFacets || {};
  const avoidTermsFromConstraints = hardConstraints?.avoidTerms || [];
  const trustFallback = hardConstraints?.trustFallback || false;
  const isBundle = hardConstraints?.isBundle || false;
  const bundleItems = hardConstraints?.bundleItems || [];
  
  // Log hardTerms count and whether empty matchedHardTerms are allowed
  const allowEmptyMatchedHardTerms = hardTermsCount === 0;
  console.log("[AI Ranking] hardTermsCount=", hardTermsCount, "allowEmptyMatchedHardTerms=", allowEmptyMatchedHardTerms);
  
  // Convert hardFacets from single values to arrays if needed
  // Also merge avoidTerms (from params and constraints)
  const finalAvoidTerms = [...new Set([...(avoidTerms || []), ...avoidTermsFromConstraints])];
  
  // Build hardFacets object for prompt (only include if present)
  const hardFacetsForPrompt: { size?: string[]; color?: string[]; material?: string[] } = {};
  if (hardFacetsRaw.size && hardFacetsRaw.size.length > 0) {
    hardFacetsForPrompt.size = hardFacetsRaw.size;
  }
  if (hardFacetsRaw.color && hardFacetsRaw.color.length > 0) {
    hardFacetsForPrompt.color = hardFacetsRaw.color;
  }
  if (hardFacetsRaw.material && hardFacetsRaw.material.length > 0) {
    hardFacetsForPrompt.material = hardFacetsRaw.material;
  }
  // If variantConstraints provided but not in hardFacets, check if we should include them
  if (variantConstraints && Object.keys(hardFacetsForPrompt).length === 0) {
    if (variantConstraints.size) {
      hardFacetsForPrompt.size = [variantConstraints.size];
    }
    if (variantConstraints.color) {
      hardFacetsForPrompt.color = [variantConstraints.color];
    }
    if (variantConstraints.material) {
      hardFacetsForPrompt.material = [variantConstraints.material];
    }
  }
  
  /**
   * Smart truncation: preserves key information (materials, features, sizing, ingredients) even when truncating
   * Industry-agnostic: works for Fashion, Beauty, Home & Garden, Health & Wellness, and other industries
   * Extracts important phrases from full description and includes them even if they're beyond the truncation point
   */
  function smartTruncateDescription(fullDesc: string, maxChars: number): string {
    if (!fullDesc || fullDesc.length <= maxChars) return fullDesc;
    
    // Industry-agnostic key patterns to preserve:
    // 1. Materials/Ingredients/Composition (Fashion: fabric, Beauty: ingredients, Home: materials, Health: ingredients)
    // 2. Features/Benefits (all industries)
    // 3. Sizing/Dimensions/Volume (Fashion: size/fit, Home: dimensions, Beauty/Health: volume/weight)
    // 4. Care/Usage Instructions (all industries)
    const keyPatterns = [
      // Materials/Ingredients/Composition (industry-agnostic)
      /\b(?:made from|material|fabric|composition|contains?|ingredients?|formula|formulated with|made with)\s+[^.]{5,100}/gi,
      // Specific materials/ingredients (expanded for all industries)
      /\b(?:cotton|wool|silk|linen|polyester|nylon|leather|denim|cashmere|viscose|spandex|elastane|wood|metal|glass|ceramic|plastic|bamboo|marble|granite|stainless steel|aluminum|brass|copper|retinol|hyaluronic acid|vitamin c|niacinamide|peptide|ceramide|collagen|aloe vera|shea butter|coconut oil|argan oil|jojoba|glycerin|salicylic acid|benzoyl peroxide|mineral|organic|natural|synthetic)[^.]{0,60}/gi,
      // Features/Benefits (industry-agnostic)
      /\b(?:waterproof|breathable|stretch|comfort|durable|quality|premium|anti-aging|moisturizing|hydrating|soothing|anti-inflammatory|hypoallergenic|non-comedogenic|cruelty-free|vegan|organic|eco-friendly|sustainable|ergonomic|adjustable|portable|lightweight|heavy-duty|rust-resistant|fade-resistant|stain-resistant|wrinkle-free|shrink-resistant)[^.]{0,80}/gi,
      // Sizing/Dimensions/Volume (industry-agnostic)
      /\b(?:size|sizing|fit|measurement|dimension|width|length|height|depth|weight|volume|capacity|ounces?|oz|ml|milliliters?|liters?|grams?|kg|kilograms?|pounds?|lbs|inches?|in|feet|ft|cm|centimeters?|meters?|m|fits? true to size|runs? (?:small|large)|one size|universal)[^.]{5,100}/gi,
      // Care/Usage Instructions (industry-agnostic)
      /\b(?:care|washing|cleaning|maintenance|instructions?|usage|how to use|directions?|apply|application|storage|keep|store|avoid|do not|recommended for|suitable for|ideal for)[^.]{5,100}/gi,
    ];
    
    // Extract key phrases from full description
    const keyPhrases: string[] = [];
    for (const pattern of keyPatterns) {
      const matches = fullDesc.match(pattern);
      if (matches) {
        keyPhrases.push(...matches.map(m => m.trim()));
      }
    }
    
    // Remove duplicates and limit
    const uniquePhrases = Array.from(new Set(keyPhrases)).slice(0, 5);
    
    // Truncate description normally
    const truncated = fullDesc.substring(0, maxChars);
    
    // If we found key phrases that aren't in the truncated portion, append them
    if (uniquePhrases.length > 0) {
      const truncatedLower = truncated.toLowerCase();
      const missingPhrases = uniquePhrases.filter(phrase => 
        !truncatedLower.includes(phrase.toLowerCase().substring(0, 20))
      );
      
      if (missingPhrases.length > 0) {
        const additionalInfo = missingPhrases.join("; ").substring(0, 100);
        return truncated + " ... " + additionalInfo;
      }
    }
    
    return truncated;
  }
  
  // Track candidate set size for retry with smaller set when parsed output missing
  // Declare currentCandidates early so it can be used in buildProductList and buildUserPrompt
  let currentCandidates = candidates;
  
  // Build product list for prompt (limit to 200)
  // Reduced payload: truncate descriptions, cap arrays, remove searchText, cap optionValues
  // This function can be called with shortened=true to reduce payload for retries
  // Uses currentCandidates (may be reduced on retry) instead of original candidates
  function buildProductList(shortened: boolean = false, compressed: boolean = false): string {
    const candidatesToUse = currentCandidates;
    const maxCandidates = 200;
    if (compressed) {
      // Compressed mode: include key structured fields + smart-truncated description with key info preserved
      return candidatesToUse.slice(0, maxCandidates).map((p, idx) => {
        const tags = (p.tags && p.tags.length > 0) ? p.tags.slice(0, 20).join(", ") : "none";
        const sizes = (p.sizes && p.sizes.length > 0) ? p.sizes.slice(0, 10).join(", ") : "none";
        const colors = (p.colors && p.colors.length > 0) ? p.colors.slice(0, 10).join(", ") : "none";
        const materials = (p.materials && p.materials.length > 0) ? p.materials.slice(0, 10).join(", ") : "none";
        
        // Use smart truncation for description to preserve key info (materials, features, sizing)
        const fullDesc = (p as any).desc1000 
          ? (p as any).desc1000
          : (cleanDescription(p.description) || "");
        const descText = smartTruncateDescription(fullDesc, 200);
        
        return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   tags: ${tags}
   sizes: ${sizes}
   colors: ${colors}
   materials: ${materials}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   description: ${descText}`;
      }).join("\n\n");
    }
    
    const descLimit = shortened ? 400 : 500;
    
    return candidatesToUse.slice(0, maxCandidates).map((p, idx) => {
    // Cap tags to max 20
    const tags = (p.tags && p.tags.length > 0) ? p.tags.slice(0, 20).join(", ") : "none";
    
    // Cap sizes/colors/materials to max 20 each
    const sizes = (p.sizes && p.sizes.length > 0) ? p.sizes.slice(0, 20).join(", ") : "none";
    const colors = (p.colors && p.colors.length > 0) ? p.colors.slice(0, 20).join(", ") : "none";
    const materials = (p.materials && p.materials.length > 0) ? p.materials.slice(0, 20).join(", ") : "none";
    
    // Cap optionValues: max 3 keys, max 10 values per key
    let optionValuesJson = "{}";
    if (p.optionValues && typeof p.optionValues === "object") {
      const cappedOptionValues: Record<string, string[]> = {};
      const keys = Object.keys(p.optionValues).slice(0, 3);
      for (const key of keys) {
        const values = (p.optionValues[key] || []);
        if (Array.isArray(values)) {
          cappedOptionValues[key] = values.slice(0, 10);
        }
      }
      optionValuesJson = JSON.stringify(cappedOptionValues);
    }
    
      // Use desc1000 if available, use smart truncation to preserve key information
      const fullDesc = (p as any).desc1000 
        ? (p as any).desc1000
        : (cleanDescription(p.description) || "No description available");
      const descriptionText = smartTruncateDescription(fullDesc, descLimit);
    
    return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   vendor: ${p.vendor || "unknown"}
   tags: ${tags}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   sizes: ${sizes}
   colors: ${colors}
   materials: ${materials}
   optionValues: ${optionValuesJson}
   desc1000: ${descriptionText}`;
  }).join("\n\n");
  }
  
  // Build initial product list
  let productList = buildProductList(false);
  
  // Log payload size (actual JSON string length)
  const productListJsonString = JSON.stringify(productList);
  const productListJsonChars = productListJsonString.length;
  const candidateCount = candidates.length;
  console.log("[AI Ranking] productListJsonChars=", productListJsonChars, "candidateCount=", candidateCount);
  
  // Adaptive compression: use compressed prompt on first attempt if payload too large
  // Lowered threshold from 35000 to 15000 for faster processing
  // Also always use compressed for bundles or large candidate counts
  const shouldUseCompressedFirst = productListJsonChars > 15000 || candidateCount > 40 || (hardConstraints?.isBundle === true);
  if (shouldUseCompressedFirst) {
    console.log("[AI Ranking] Using compressed prompt on first attempt (productListJsonChars=", productListJsonChars, ", candidateCount=", candidateCount, ")");
    productList = buildProductList(false, true); // Rebuild with compressed mode
  }

  const constraints = variantConstraints ?? { size: null, color: null, material: null };
  const prefs = variantPreferences ?? {};
  const include = includeTerms ?? [];
  const avoid = avoidTerms ?? [];
  
  const constraintsText = constraints.size || constraints.color || constraints.material
    ? `
Variant preferences (if present):
- Size: ${constraints.size ?? "none"}
- Color: ${constraints.color ?? "none"}
- Material: ${constraints.material ?? "none"}

Rules:
- Prefer products that explicitly offer the requested size/color/material in their variant options.
- If no product matches all constraints, choose the closest matches and explain which constraints were unmet.
- Do not hallucinate variant availability. Use only the candidate's sizes/colors/materials arrays.
`
    : "";

  const prefsText = Object.keys(prefs).length
    ? `Variant option preferences (must use candidate optionValues; do not guess):\n${JSON.stringify(prefs, null, 2)}`
    : "Variant option preferences: none";

  const rulesText = `
Rules:
- Prefer products that satisfy the variant option preferences using candidate.optionValues.
- If no product satisfies all preferences, return closest matches and explain which preferences were not met.
- Do not hallucinate variant availability. Only use the provided optionValues/sizes/colors/materials arrays.
`;

  const keywordText = (include.length > 0 || avoid.length > 0)
    ? `
Keyword preferences:
${include.length > 0 ? `- Include terms: ${include.join(", ")}` : ""}
${avoid.length > 0 ? `- Avoid terms: ${avoid.join(", ")}` : ""}

Rules:
- Prefer products whose title, tags, or description contain the include terms.
- Exclude products whose title or tags contain any avoid terms.
`
    : "";

  const systemPrompt = isBundle
    ? `You are an expert product recommendation assistant for an e-commerce store. Your task is to build a BUNDLE of products across multiple categories from pre-filtered candidate lists.

CRITICAL OUTPUT FORMAT:
- Return ONLY valid JSON (no markdown, no prose, no explanations outside JSON)
- Output must be parseable JSON.parse() directly
- Use the exact bundle schema provided below - no deviations

REASONING QUALITY (CRITICAL):
- Each product's "reason" field must be written in natural, professional, conversational language
- Write as if you're a knowledgeable sales associate explaining to a customer why this product matches their needs
- Be specific and helpful: mention how it fits their request, style, occasion, or preferences
- Avoid technical jargon or robotic phrases like "Product matches hardTerm X" or "This item satisfies criteria Y"
- Instead use human-like language: "This elegant navy suit is perfect for formal occasions and professional settings" not "Matches suit category and navy color"
- Each reason should be ONE sentence maximum, engaging, and customer-facing

BUNDLE REQUIREMENTS:
- You will receive ${bundleItems.length} bundle items, each with its own candidate group
- For each itemIndex, choose exactly 1 primary selection from that item's candidate group
- After selecting 1 primary per item, add alternates to fill ${resultCount} total selections
- Distribute alternates evenly across items (round-robin)
- Each selection in selected_by_item MUST include itemIndex matching the candidate's group

BUDGET CONSTRAINT:
${bundleItems.some(item => item.budgetMax) ? `- Total budget: $${bundleItems.reduce((sum, item) => sum + (item.budgetMax || 0), 0).toFixed(2)}
- Prefer selections where sum(price) <= totalBudget
- If impossible to stay within budget, set trustFallback=true and label alternatives` : "- No budget constraint specified"}

HARD CONSTRAINT RULES:
${trustFallback ? `- trustFallback=true: You may show alternatives when exact matches are insufficient, but MUST label each as "exact" or "alternative"` : `- trustFallback=false: EVERY returned product MUST satisfy ALL of the following:
  a) At least one hardTerm match for its itemIndex in (title OR productType OR tags OR desc1000 snippet)
  b) ALL hardFacets must match when provided (size, color, material)
  c) Must NOT contain any avoidTerms in title/tags/desc1000 (unless avoidTerms is empty)
  d) Evidence must not be empty - must specify which hardTerms matched and which fields were used
  e) Handle MUST exist in that itemIndex's candidate group`}

OUTPUT SCHEMA (MUST be exactly this structure):
{
  "trustFallback": ${trustFallback},
  "selected_by_item": [
    {
      "itemIndex": 0,
      "handle": "exact-handle-from-item-0-candidates",
      "label": "exact" | "alternative",
      "score": 85,
      "evidence": {
        "matchedHardTerms": ["suit"],
        "matchedFacets": { "size": [], "color": ["navy"], "material": [] },
        "fieldsUsed": ["title", "productType", "desc1000"]
      },
      "reason": "Navy suit matches category and color requirements."
    }
  ]
}

REQUIREMENTS:
- "selected_by_item" array MUST contain at least 1 selection per itemIndex (exactly 1 primary per item)
- After primaries, add alternates to reach ${resultCount} total, distributing evenly across items
- All handles must exist in their itemIndex's candidate group (copy exactly as shown)
- No duplicate handles
- evidence.matchedHardTerms must not be empty when trustFallback=false
- evidence.fieldsUsed must include at least one of: ["title", "productType", "tags", "desc1000"]
- CRITICAL: Each "reason" must be professional, human-like, and conversational:
  * Write as if you're a knowledgeable sales associate speaking directly to the customer
  * Use natural language that highlights benefits, style, occasion, or fit
  * Be specific: mention colors, materials, occasions, or use cases when relevant
  * Avoid robotic phrases: NO "Product matches X", NO "Satisfies criteria Y", NO technical jargon
  * Example GOOD: "This sophisticated navy suit is ideal for business meetings and formal events, with excellent tailoring for a polished look"
  * Example BAD: "Matches suit category and navy color; satisfies formal wear requirements"
`
    : `You are an expert product recommendation assistant for an e-commerce store. Your task is to rank products from a pre-filtered candidate list based on strict matching rules.

CRITICAL OUTPUT FORMAT (HIGHEST PRIORITY):
- Return ONLY valid JSON (no markdown, no prose, no explanations outside JSON)
- Output must be parseable JSON.parse() directly - test your JSON before returning
- Use the exact schema provided below - no deviations
- CRITICAL: Ensure all arrays have proper commas between elements (e.g., ["item1", "item2"] not ["item1" "item2"])
- CRITICAL: Ensure all objects have proper commas between properties
- CRITICAL: Close all brackets and braces properly
- Double-check your JSON is valid before returning - invalid JSON will cause errors

REASONING QUALITY (CRITICAL):
- Each product's "reason" field must be written in natural, professional, conversational language
- Write as if you're a knowledgeable sales associate explaining to a customer why this product matches their needs
- Be specific and helpful: mention how it fits their request, style, occasion, preferences, or use case
- Avoid technical jargon or robotic phrases like "Product matches hardTerm X" or "This item satisfies criteria Y"
- Instead use human-like language: "This elegant navy suit is perfect for formal occasions and professional settings" not "Matches suit category and navy color"
- Each reason should be ONE sentence maximum, engaging, and customer-facing

HARD CONSTRAINT RULES:
${hardTerms.length === 0 ? `- hardTerms is EMPTY: Rank products by soft terms + overall relevance. Do NOT reject products for missing hardTerms since none were specified. Prioritize products that match soft terms, variant preferences, and overall relevance to the user's intent.` : trustFallback ? `- trustFallback=true: You may show alternatives when exact matches are insufficient, but MUST label each as "exact" or "alternative"` : `- trustFallback=false: EVERY returned product MUST satisfy ALL of the following:
  a) At least one hardTerm match in (title OR productType OR tags OR desc1000 snippet)
  b) ALL hardFacets must match when provided (size, color, material)
  c) Must NOT contain any avoidTerms in title/tags/desc1000 (unless avoidTerms is empty)
  d) Evidence must not be empty - must specify which hardTerms matched and which fields were used`}

CATEGORY DRIFT PREVENTION:
- If hardTerm includes a specific category (e.g., "suit", "sofa", "treadmill", "serum"), do NOT return adjacent categories:
  * "suit" → do NOT return "shirt", "trousers", "blazer", "jacket" unless trustFallback=true AND labeled "alternative"
  * "sofa" → do NOT return "chair", "loveseat", "futon" unless trustFallback=true AND labeled "alternative"
  * "treadmill" → do NOT return "exercise bike", "elliptical", "rower" unless trustFallback=true AND labeled "alternative"
  * "serum" → do NOT return "moisturizer", "cleanser", "toner" unless trustFallback=true AND labeled "alternative"
- Only exact category matches can be labeled "exact"
- Adjacent categories can only be "alternative" when trustFallback=true

MATCHING REQUIREMENTS:
1. Read the FULL desc1000 field for each candidate (up to 1000 characters)
2. Check title, productType, tags, and desc1000 for hardTerm matches
3. Verify hardFacet matches in sizes/colors/materials arrays
4. Exclude products containing avoidTerms in title/tags/desc1000
5. Score 0-100 based on relevance (higher = better match)

OUTPUT SCHEMA (MUST be exactly this structure):
{
  "trustFallback": ${trustFallback},
  "selected": [
    {
      "handle": "exact-handle-from-candidate-list",
      "label": "exact" | "alternative",
      "score": 85,
      "evidence": {
        "matchedHardTerms": ["suit"],
        "matchedFacets": { "color": ["navy", "blue"] },
        "fieldsUsed": ["title", "productType", "desc1000"]
      },
      "reason": "Navy blue suit matches category and color requirements."
    }
  ]
}

REQUIREMENTS:
- "selected" array MUST contain exactly ${resultCount} items
- All handles must exist in the candidate list (copy exactly as shown)
- No duplicate handles
- evidence.matchedHardTerms must not be empty when trustFallback=false
- evidence.fieldsUsed must include at least one of: ["title", "productType", "tags", "desc1000"]
- CRITICAL: Each "reason" must be professional, human-like, and conversational:
  * Write as if you're a knowledgeable sales associate speaking directly to the customer
  * Use natural language that highlights benefits, style, occasion, or fit
  * Be specific: mention colors, materials, occasions, or use cases when relevant
  * Avoid robotic phrases: NO "Product matches X", NO "Satisfies criteria Y", NO technical jargon
  * Example GOOD: "This sophisticated navy suit is ideal for business meetings and formal events, with excellent tailoring for a polished look"
  * Example BAD: "Matches suit category and navy color; satisfies formal wear requirements"
  * Each reason should be ONE sentence maximum, engaging, and customer-facing`;

  // Build hard constraints object for prompt
  const hardConstraintsJson = JSON.stringify({
    hardTerms,
    ...(Object.keys(hardFacetsForPrompt).length > 0 ? { hardFacets: hardFacetsForPrompt } : {}),
    avoidTerms: finalAvoidTerms,
    trustFallback,
  }, null, 2);

  // Build user prompt (can be shortened or compressed for retries)
  // Uses currentCandidates (may be reduced on retry) instead of original candidates
  function buildUserPrompt(shortened: boolean = false, compressed: boolean = false): string {
    if (isBundle && bundleItems.length >= 2) {
      // BUNDLE MODE: Group candidates by itemIndex
      const candidatesByItem = new Map<number, ProductCandidate[]>();
      for (const c of currentCandidates) {
        const itemIdx = (c as any)._bundleItemIndex;
        if (typeof itemIdx === "number") {
          if (!candidatesByItem.has(itemIdx)) {
            candidatesByItem.set(itemIdx, []);
          }
          candidatesByItem.get(itemIdx)!.push(c);
        }
      }
      
      // Build bundle items list
      const bundleItemsList = bundleItems.map((item, idx) => {
        const budgetText = item.budgetMax ? ` (allocated budget: $${item.budgetMax.toFixed(2)})` : "";
        return `Item ${idx}: ${item.hardTerms.join(", ")} (quantity: ${item.quantity})${budgetText}`;
      }).join("\n");
      
      const totalBudgetText = bundleItems.some(item => item.budgetMax)
        ? `\nTotal Budget: $${bundleItems.reduce((sum, item) => sum + (item.budgetMax || 0), 0).toFixed(2)}`
        : "";
      
      // Build candidate groups by itemIndex
      let candidateGroupsText = "";
      for (let itemIdx = 0; itemIdx < bundleItems.length; itemIdx++) {
        const itemCandidates = candidatesByItem.get(itemIdx) || [];
        const itemHardTerms = bundleItems[itemIdx].hardTerms;
        
        candidateGroupsText += `\n\n=== Item ${itemIdx} Candidates (${itemHardTerms.join(", ")}) ===\n`;
        candidateGroupsText += itemCandidates.slice(0, 30).map((p, idx) => {
          const tags = (p.tags && p.tags.length > 0) ? p.tags.slice(0, 20).join(", ") : "none";
          // Use smart truncation for bundle descriptions (150 chars in compressed mode, 500 otherwise)
          const fullDesc = (p as any).desc1000 
            ? (p as any).desc1000
            : (cleanDescription(p.description) || "No description available");
          const descText = smartTruncateDescription(fullDesc, compressed ? 150 : 500);
          
          return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   vendor: ${p.vendor || "unknown"}
   tags: ${tags}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   desc1000: ${descText}`;
        }).join("\n\n");
      }
      
      return `Shopper Intent (BUNDLE):
${enhancedIntent}

Bundle Items:
${bundleItemsList}${totalBudgetText}

Hard Constraints:
${hardConstraintsJson}

${constraintsText ? `Variant Preferences:
${constraintsText}` : ""}

${prefsText && prefsText !== "Variant option preferences: none" ? `${prefsText}${rulesText}` : ""}

${keywordText || ""}

Candidates Grouped by Item:
${candidateGroupsText}

TASK:
1. For each bundle item, choose exactly 1 primary selection from that item's candidate group
2. After selecting 1 primary per item, add alternates to fill ${resultCount} total selections
3. Distribute alternates evenly across items (round-robin)
4. Enforce budget: prefer selections where sum(price) <= totalBudget; if impossible, set trustFallback=true and label alternatives

For each selected item in selected_by_item:
   - itemIndex: Must match the candidate's group (0, 1, 2, ...)
   - Exact handle (copy from that itemIndex's candidate list)
   - Label: "exact" if all constraints satisfied, "alternative" only if trustFallback=true
   - Score: 0-100 based on match quality
   - Evidence: Which hardTerms matched, which facets matched, which fields were used
   - Reason: Write a natural, professional, conversational 1-sentence explanation as if speaking directly to the customer. Be specific about benefits, style, occasion, or use case. Avoid technical jargon or robotic phrases.

Return ONLY the JSON object matching the bundle schema - no markdown, no prose outside JSON.`;
    }
    
    // SINGLE-ITEM MODE: Existing logic
    const productListForPrompt = compressed 
      ? buildProductList(false, true) 
      : (shortened ? buildProductList(true) : productList);
    const intentForPrompt = shortened ? enhancedIntent.substring(0, 500) : enhancedIntent;
    
    // Update matching requirements for compressed mode
    const matchingRequirements = compressed
      ? `1. For each candidate, check if it satisfies the hard constraints:
   - At least one hardTerm in title/productType/tags/searchText
   - All hardFacets match (if provided in candidate data)
   - No avoidTerms in title/tags/searchText`
      : `1. For each candidate, check if it satisfies the hard constraints:
   - At least one hardTerm in title/productType/tags/desc1000
   - All hardFacets match (size/color/material in candidate arrays)
   - No avoidTerms in title/tags/desc1000`;
    
    return `Shopper Intent:
${intentForPrompt}

Hard Constraints:
${hardConstraintsJson}

${constraintsText && !compressed ? `Variant Preferences:
${constraintsText}` : ""}

${prefsText && prefsText !== "Variant option preferences: none" && !compressed ? `${prefsText}${rulesText}` : ""}

${keywordText || ""}

Candidate Products (${candidates.length} total):
${productListForPrompt}

TASK:
${matchingRequirements}

2. Select exactly ${resultCount} products:
   ${trustFallback ? "- If ${resultCount} exact matches exist, return all as 'exact'" : "- ALL must be 'exact' matches (satisfy all hard constraints)"}
   ${trustFallback ? "- If fewer than ${resultCount} exact matches, fill with 'alternative' matches closest to intent" : "- If fewer than ${resultCount} exact matches exist, return only the exact matches you find"}

3. For each selected item, provide:
   - Exact handle (copy from candidate list)
   - Label: "exact" if all constraints satisfied, "alternative" only if trustFallback=true
   - Score: 0-100 based on match quality
   - Evidence: Which hardTerms matched, which facets matched, which fields were used
   - Reason: Write a natural, professional, conversational 1-sentence explanation as if you're a knowledgeable sales associate speaking directly to the customer. Be specific about benefits, style, occasion, or use case. Example: "This sophisticated navy suit is ideal for business meetings and formal events, with excellent tailoring for a polished look" (NOT "Matches suit category and navy color")

Return ONLY the JSON object matching the schema - no markdown, no prose outside JSON.`;
  }
  
  let userPrompt = buildUserPrompt(false);

  // Build JSON schema for StructuredRankingResult or StructuredBundleResult if supported
  function buildJsonSchema(isBundle: boolean = false) {
    const evidenceSchema = {
      type: "object",
      properties: {
        matchedHardTerms: { type: "array", items: { type: "string" } },
        matchedFacets: {
          type: "object",
          properties: {
            size: { type: "array", items: { type: "string" } },
            color: { type: "array", items: { type: "string" } },
            material: { type: "array", items: { type: "string" } },
          },
          required: ["size", "color", "material"],
          additionalProperties: false,
        },
        fieldsUsed: { type: "array", items: { type: "string" } },
      },
      required: ["matchedHardTerms", "matchedFacets", "fieldsUsed"],
      additionalProperties: false,
    };
    
    const selectedItemSchema = {
      type: "object",
      properties: {
        handle: { type: "string" },
        label: { type: "string", enum: ["exact", "alternative"] },
        score: { type: "number", minimum: 0, maximum: 100 },
        evidence: evidenceSchema,
        reason: { type: "string" },
      },
      required: ["handle", "label", "score", "evidence", "reason"],
      additionalProperties: false,
    };
    
    if (isBundle) {
      // Bundle schema: strict - only trustFallback and selected_by_item
      return {
        type: "object",
        properties: {
          trustFallback: { type: "boolean" },
          selected_by_item: {
            type: "array",
            items: {
              type: "object",
              properties: {
                itemIndex: { type: "number" },
                handle: { type: "string" },
                label: { type: "string", enum: ["exact", "alternative"] },
                score: { type: "number", minimum: 0, maximum: 100 },
                evidence: evidenceSchema,
                reason: { type: "string" },
              },
              required: ["itemIndex", "handle", "label", "score", "evidence", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["trustFallback", "selected_by_item"],
        additionalProperties: false,
      };
    } else {
      // Single-item schema: strict - only trustFallback and selected
      return {
        type: "object",
        properties: {
          trustFallback: { type: "boolean" },
          selected: {
            type: "array",
            items: selectedItemSchema,
          },
        },
        required: ["trustFallback", "selected"],
        additionalProperties: false,
      };
    }
  }

  // Attempt AI ranking with retries
  let lastError: any = null;
  let lastParseFailReason: string | undefined = undefined;
  const candidateHandles = new Set(candidates.map(p => p.handle));
  
  // currentCandidates is already declared above (before buildProductList and buildUserPrompt)
  
  // Adaptive timeout function based on candidateCount and productListJsonChars
  // Increased timeouts to handle larger requests and json_schema mode which can be slower
  function calculateAdaptiveTimeout(candidateCount: number, productListJsonChars: number): number {
    // <= 15 candidates and <= 10k chars: 20s (faster for small requests)
    if (candidateCount <= 15 && productListJsonChars <= 10000) {
      return 20000;
    }
    // <= 25 candidates and <= 15k chars: 30s
    if (candidateCount <= 25 && productListJsonChars <= 15000) {
      return 30000;
    }
    // <= 40 candidates or <= 25k chars: 40s (increased from 25s)
    if (candidateCount <= 40 || productListJsonChars <= 25000) {
      return 40000;
    }
    // else: 50s (increased from 40s for very large requests)
    return 50000;
  }
  
  // Response metadata variables (declared outside loop for catch block access)
  let responseStatus: number | null = null;
  let responseId: string | null = null;
  let bodyResponseId: string | null = null;
  
  // Request payload variables (declared outside try for catch block access)
  let requestBody: any = null;
  let currentCandidateCount: number = candidates.length;
  let currentProductListJsonChars: number = productListJsonChars;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Calculate timeout for this attempt (needed in catch block)
    let timeoutMs = 40000; // Default to hard cap
    
    // Reset response metadata for each attempt
    responseStatus = null;
    responseId = null;
    bodyResponseId = null;
    
    try {
      const isRetry = attempt > 0;
      // Use compressed prompt if: retry with parse failure OR adaptive compression triggered on first attempt
      const useCompressedPrompt = (isRetry && lastParseFailReason !== undefined) || (attempt === 0 && shouldUseCompressedFirst);
      
      // On retry after missing parsed output, use smaller candidate set (reduce by 30-50%)
      if (isRetry && lastParseFailReason === "Missing parsed output in SDK response" && currentCandidates.length === candidates.length) {
        // Reduce by 30-50% (using 30% reduction as existing logic)
        const reductionFactor = 0.7; // 30% reduction (keeps 70%)
        currentCandidates = candidates.slice(0, Math.floor(candidates.length * reductionFactor));
        console.log("[AI Ranking] Retrying with smaller candidate set", { 
          original: candidates.length, 
          retry: currentCandidates.length,
          reduction: `${Math.round((1 - reductionFactor) * 100)}%`
        });
      }
      
      // Calculate current productListJsonChars based on currentCandidates and compression
      const currentProductList = useCompressedPrompt ? buildProductList(false, true) : (attempt === 0 ? productList : buildProductList(false));
      currentProductListJsonChars = JSON.stringify(currentProductList).length;
      currentCandidateCount = currentCandidates.length;
      
      // Calculate adaptive timeout based on current state
      timeoutMs = calculateAdaptiveTimeout(currentCandidateCount, currentProductListJsonChars);
      
      // Log timeout decision
      console.log("[AI Ranking] timeoutMs=", timeoutMs, "candidateCount=", currentCandidateCount, "productListJsonChars=", currentProductListJsonChars);
      
      if (isRetry) {
        console.log(`[AI Ranking] Retry attempt ${attempt} of ${MAX_RETRIES}${useCompressedPrompt ? " (using compressed prompt)" : ""}`);
      } else if (shouldUseCompressedFirst) {
        console.log("[AI Ranking] First attempt using compressed prompt (adaptive compression)");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Determine API endpoint based on structured outputs support
      let apiUsed: "chat";
      let apiUrl: string;
      
      // Use Chat Completions API with structured outputs (json_schema) when supported
      // This guarantees valid JSON output that matches the schema exactly
      // Note: json_schema is supported through chat.completions, not a separate responses endpoint
      apiUsed = "chat";
      apiUrl = OPENAI_CHAT_COMPLETIONS_URL;
      
      if (supportsJsonSchema) {
        // Use Chat Completions API with json_schema for structured outputs
        requestBody = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: useCompressedPrompt ? buildUserPrompt(false, true) : userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: isBundle ? "structured_bundle_result" : "structured_ranking_result",
              strict: true,
              schema: buildJsonSchema(isBundle),
            },
          },
          temperature: 0,
          max_tokens: 700,
        };
        
        console.log("[AI Ranking] structured_outputs=true");
      } else {
        // Fallback for models that don't support json_schema - use json_object mode
        requestBody = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: useCompressedPrompt ? buildUserPrompt(false, true) : userPrompt },
          ],
          temperature: 0,
          max_tokens: 700,
          response_format: { type: "json_object" },
        };
        console.warn("[AI Ranking] Model does not support json_schema, falling back to json_object mode");
      }

      // Use appropriate endpoint based on API type
      let response: Response;
      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        });
      } catch (fetchError: any) {
        // Handle fetch errors (network, abort, timeout)
        clearTimeout(timeoutId);
        if (fetchError.name === "AbortError" || controller.signal.aborted) {
          // Timeout occurred - don't try to parse response
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
          lastParseFailReason = `Request timeout after ${timeoutMs}ms`;
          responseStatus = null;
          responseId = null;
          continue; // Try again if retries remaining
        }
        // Re-throw other fetch errors to be handled by outer catch
        throw fetchError;
      }

      clearTimeout(timeoutId);

      // Extract response metadata before consuming body
      responseStatus = response.status;
      responseId = response.headers.get("x-request-id") || response.headers.get("openai-request-id") || null;
      
      if (!response.ok) {
        let errorData: any = null;
        try {
          const errorText = await response.text();
          // Try to parse error JSON if possible (no PII expected)
          try {
            errorData = JSON.parse(errorText);
          } catch {
            // Keep as text if not JSON
            errorData = { raw: errorText.substring(0, 200) }; // Truncate for safety
          }
        } catch {
          // Ignore errors reading response body
        }
        
        // Extract error type/code from response if available
        const errorType = errorData?.error?.type || errorData?.type || null;
        const errorCode = errorData?.error?.code || errorData?.code || null;
        
        // Determine fail reason (short description, no PII)
        let failReason = `HTTP ${responseStatus}`;
        if (errorType) failReason += ` ${errorType}`;
        if (errorCode) failReason += ` (${errorCode})`;
        
        // Structured error log
        const logData: any = {
          attempt: attempt + 1,
          status: responseStatus,
          fail_type: "http",
          fail_reason: failReason,
        };
        if (responseId) logData.response_id = responseId;
        if (errorType) logData.error_type = errorType;
        if (errorCode) logData.error_code = errorCode;
        console.log("[AI Ranking] attempt=", logData.attempt, "status=", logData.status, "fail_type=", logData.fail_type, "fail_reason=", logData.fail_reason, responseId ? `response_id=${responseId}` : "");
        
        lastError = new Error(`OpenAI API error: ${responseStatus}`);
        lastParseFailReason = failReason;
        continue; // Try again if retries remaining
      }

      // Parse response JSON - handle potential timeout/incomplete responses
      let data: any;
      try {
        const responseText = await response.text();
        if (!responseText || responseText.trim() === "") {
          throw new Error("Empty response body");
        }
        data = JSON.parse(responseText);
      } catch (parseError: any) {
        // If parsing fails, check if it was due to timeout/abort
        if (controller.signal.aborted) {
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
          lastParseFailReason = `Request timeout after ${timeoutMs}ms`;
          responseStatus = null;
          responseId = null;
          continue; // Try again if retries remaining
        }
        // Re-throw parse errors to be handled by outer catch
        throw new Error(`Failed to parse response: ${parseError.message || String(parseError)}`);
      }
      
      // Extract response ID from response body if present (OpenAI sometimes includes this)
      bodyResponseId = data.id || data.request_id || null;
      
      // Read parsed output from Chat Completions API
      // For json_schema mode, the response is in choices[0].message.content as valid JSON
      // For json_object mode, same structure
      let structuredResult: StructuredRankingResult | StructuredBundleResult | null = null;
      
      // Chat.completions API: check choices[0].message structure
      const message = data.choices?.[0]?.message;
      if (message) {
        // Check for refusal
        if (message.refusal) {
          const refusalResponseId = data.id || data.request_id || responseId || bodyResponseId || null;
          
          // Structured error log for model refusal
          const logData: any = {
            attempt: attempt + 1,
            status: responseStatus || "unknown",
            fail_type: "parse",
            fail_reason: "Model refusal",
          };
          if (refusalResponseId) logData.response_id = refusalResponseId;
          console.log("[AI Ranking] attempt=", logData.attempt, "status=", logData.status, "fail_type=", logData.fail_type, "fail_reason=", logData.fail_reason, refusalResponseId ? `response_id=${refusalResponseId}` : "");
          
          // Also log refusal details (safe, no PII)
          console.log("[AI Ranking] Model refused to generate structured output");
          
          lastError = new Error("Model refused to generate structured output");
          lastParseFailReason = "Model refusal";
          continue; // Try again if retries remaining
        }

        // Check for parsed field (may be present in some SDK versions)
        if (message.parsed && typeof message.parsed === "object") {
          structuredResult = message.parsed as StructuredRankingResult | StructuredBundleResult;
        }
        // Check if content is already an object (parsed) rather than a string
        else if (message.content && typeof message.content === "object" && !Array.isArray(message.content)) {
          structuredResult = message.content as StructuredRankingResult | StructuredBundleResult;
        }
        // For json_schema mode, content is a JSON string that needs parsing
        else if (message.content && typeof message.content === "string" && supportsJsonSchema) {
          try {
            structuredResult = parseStructuredRanking(message.content);
          } catch (parseError) {
            // Parse error will be handled below
            console.warn("[AI Ranking] Failed to parse json_schema content:", parseError instanceof Error ? parseError.message : String(parseError));
          }
        }
      }

      // If parsed output is missing from SDK's documented location, treat as hard failure
      // Retry once with smaller candidate set if this is first attempt
      if (!structuredResult) {
        // Log response shape for debugging (no PII)
        const responseKeys = Object.keys(data);
        
        // Extract response/request ID from response if present
        const parseResponseId = data.id || data.request_id || responseId || bodyResponseId || null;
        
        // Structured error log for parse failure
        const logData: any = {
          attempt: attempt + 1,
          status: responseStatus || "unknown",
          fail_type: "parse",
          fail_reason: "Missing parsed output in SDK response",
        };
        if (parseResponseId) logData.response_id = parseResponseId;
        console.log("[AI Ranking] attempt=", logData.attempt, "status=", logData.status, "fail_type=", logData.fail_type, "fail_reason=", logData.fail_reason, parseResponseId ? `response_id=${parseResponseId}` : "");
        
        // Also log detailed debug info (separate log line)
        console.log("[AI Ranking] structured_outputs missing parsed output", {
          model,
          apiUsed,
          keys: responseKeys.join(","),
          attempt
        });
        
        lastError = new Error("Structured outputs missing parsed output from SDK");
        lastParseFailReason = "Missing parsed output in SDK response";
        
        // If first attempt and we have many candidates, retry with smaller set
        // (currentCandidates will be updated at start of next iteration)
        if (attempt === 0 && currentCandidates.length > 20) {
          // Continue to retry - currentCandidates will be reduced in next iteration
          continue;
        }
        
        // If retry already attempted or too few candidates, proceed to fallback
        continue; // This will eventually fallback after MAX_RETRIES
      }

      console.log("[AI Ranking] Successfully parsed structured output (strict mode)");

      // Strict schema ensures only required fields are present
      // No need to set defaults for removed fields (rejected_candidates, selected in bundle)

      // Validate bundle response if in bundle mode
      if (isBundle && "selected_by_item" in structuredResult) {
        const bundleResult = structuredResult as StructuredBundleResult;
        
        // Build item pools for validation
        const candidatesByItem = new Map<number, Set<string>>();
        for (const c of candidates) {
          const itemIdx = (c as any)._bundleItemIndex;
          if (typeof itemIdx === "number") {
            if (!candidatesByItem.has(itemIdx)) {
              candidatesByItem.set(itemIdx, new Set());
            }
            candidatesByItem.get(itemIdx)!.add(c.handle);
          }
        }
        
        // Validate and remap handles to correct item pools
        const remappedItems: BundleSelectedItem[] = [];
        let remappedCount = 0;
        const handleToItemIndex = new Map<string, number[]>(); // Track which pools contain each handle
        
        // Build reverse index: handle -> itemIndices that contain it
        for (const [itemIdx, pool] of candidatesByItem.entries()) {
          for (const handle of pool) {
            if (!handleToItemIndex.has(handle)) {
              handleToItemIndex.set(handle, []);
            }
            handleToItemIndex.get(handle)!.push(itemIdx);
          }
        }
        
        // Remap handles to correct itemIndex if needed
        for (const item of bundleResult.selected_by_item) {
          const declaredPool = candidatesByItem.get(item.itemIndex);
          const handleExistsInDeclaredPool = declaredPool && declaredPool.has(item.handle);
          
          if (handleExistsInDeclaredPool) {
            // Handle is in correct pool, keep as-is
            remappedItems.push(item);
        } else {
            // Handle not in declared pool, try to find correct pool
            const correctPools = handleToItemIndex.get(item.handle) || [];
            
            if (correctPools.length === 0) {
              // Handle not in ANY pool - this is invalid
              if (!bundleResult.trustFallback) {
                lastError = new Error(`Handle ${item.handle} not found in any item pool`);
                lastParseFailReason = `Handle ${item.handle} not found in any item pool`;
                console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
                continue; // Try again if retries remaining
              }
              // If trustFallback, skip invalid handle
              continue;
            } else if (correctPools.length === 1) {
              // Handle exists in exactly one pool - remap to that pool
              remappedItems.push({ ...item, itemIndex: correctPools[0] });
              remappedCount++;
            } else {
              // Handle exists in multiple pools - keep original itemIndex
              remappedItems.push(item);
            }
          }
        }
        
        // Check for missing itemIndices after remapping
        const remappedIndices = new Set(remappedItems.map(item => item.itemIndex));
        const expectedIndices = new Set(bundleItems.map((_, idx) => idx));
        const missingIndices = Array.from(expectedIndices).filter(idx => !remappedIndices.has(idx));
        
        if (missingIndices.length > 0) {
          // Missing itemIndices - log but don't fail (will be handled by top-up or fallback)
          console.log("[AI Bundle] missingItemIndices=", missingIndices.join(","), "after remapping");
        }
        
        // Update bundleResult with remapped items
        bundleResult.selected_by_item = remappedItems;
        
        // Successfully validated bundle response
        const finalItemIndices = new Set(bundleResult.selected_by_item.map(item => item.itemIndex));
        console.log("[AI Bundle] structuredOk=true, itemCount=", bundleResult.selected_by_item.length, 
          "returnedPerItem=", Array.from(finalItemIndices).map(idx => {
            const count = bundleResult.selected_by_item.filter(item => item.itemIndex === idx).length;
            return `item${idx}:${count}`;
          }).join(","),
          "remappedCount=", remappedCount,
          "missingItemIndices=", missingIndices.length > 0 ? missingIndices.join(",") : "none",
          "trustFallback=", bundleResult.trustFallback);
        
        // Calculate total price for budget check
        const candidateMap = new Map(candidates.map(p => [p.handle, p]));
        const totalPrice = bundleResult.selected_by_item.reduce((sum, item) => {
          const candidate = candidateMap.get(item.handle);
          if (candidate && candidate.price) {
            const price = parseFloat(String(candidate.price));
            return sum + (Number.isFinite(price) ? price : 0);
          }
          return sum;
        }, 0);
        
        const totalBudget = bundleItems.reduce((sum, item) => sum + (item.budgetMax || 0), 0);
        const budgetOk = totalBudget === 0 || totalPrice <= totalBudget;
        
        console.log("[AI Bundle] budgetOk=", budgetOk, "totalPrice=", totalPrice.toFixed(2), "totalBudget=", totalBudget.toFixed(2));
        
        // Convert bundle result to ranked handles
        const rankedHandles = bundleResult.selected_by_item
          .sort((a, b) => {
            // Sort by itemIndex first, then by score descending
            if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
            return b.score - a.score;
          })
          .map(item => item.handle)
          .slice(0, resultCount);
        
        // Build reasoning from bundle items
        const reasoningParts = bundleResult.selected_by_item
          .filter((item, idx, arr) => arr.findIndex(i => i.itemIndex === item.itemIndex) === idx) // One per itemIndex
          .map(item => item.reason)
          .filter(Boolean);
        
        const reasoning = reasoningParts.length > 0
          ? reasoningParts.join(" ")
          : `Built a bundle with ${bundleResult.selected_by_item.length} items.`;
        
        // Bundle mode: AI succeeded (structured output parsed and validated)
        console.log("[AI Ranking] source=ai trustFallback=", bundleResult.trustFallback);
        return {
          selectedHandles: rankedHandles,
          reasoning,
          trustFallback: bundleResult.trustFallback,
          source: "ai",
          parseFailReason: null,
        };
      }

      // Validate against expected schema (single-item mode)
      const validation = validateRankingSchema(structuredResult as StructuredRankingResult, trustFallback, candidateHandles, hardTermsCount);
      
      if (!validation.valid) {
        // Before retrying, try to parse as old format as a fallback
        try {
          const oldFormat: RankingResult = structuredResult as any;
          if (oldFormat.ranked_handles && Array.isArray(oldFormat.ranked_handles)) {
            console.log("[AI Ranking] Falling back to old format parsing");
            const validHandles = oldFormat.ranked_handles
              .filter((h): h is string => typeof h === "string" && h.trim().length > 0 && candidateHandles.has(h.trim()))
              .map(h => h.trim())
              .slice(0, resultCount);
            if (validHandles.length > 0) {
              console.log("[AI Ranking] source=ai trustFallback=", trustFallback, "(old format fallback)");
              return {
                selectedHandles: validHandles,
                reasoning: oldFormat.reasoning || "AI-ranked products based on user intent",
                trustFallback,
                source: "ai",
                parseFailReason: null,
              };
            }
          }
        } catch (oldFormatError) {
          // Old format parsing failed, continue to retry
        }
        
        lastError = new Error(`Schema validation failed: ${validation.reason}`);
        lastParseFailReason = `Schema validation failed: ${validation.reason}`;
        console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
        continue; // Try again if retries remaining
      }

      // Successfully parsed and validated
      console.log("[AI Ranking] Successfully parsed and validated JSON response");
      
      // Single-item mode: runtime validation of selected items
      if (!isBundle || !("selected_by_item" in structuredResult)) {
        // Schema validation already passed, now do runtime validation of selected items
        const singleItemResult = structuredResult as StructuredRankingResult;
      const candidateMap = new Map(candidates.map(p => [p.handle, p]));
      
        console.log("[AI Ranking] AI returned", singleItemResult.selected.length, "selected items");
      
        // Validate and filter selected items (runtime checks beyond schema)
      const validSelectedItems: SelectedItem[] = [];
      
        for (const item of singleItemResult.selected) {
        const handle = item.handle.trim();
        const candidate = candidateMap.get(handle);
        
        if (!candidate) {
          console.warn("[AI Ranking] Skipping item with handle not in candidates:", handle);
          continue;
        }
        
        // If trustFallback=false, validate constraints
        if (!trustFallback) {
          // Basic validation: check if hardTerm appears in candidate fields
          // Use searchText if available (compressed mode), otherwise use desc1000
          const candidateText = [
            candidate.title || "",
            candidate.productType || "",
            ...(candidate.tags || []),
            (candidate as any).searchText || (candidate as any).desc1000 || cleanDescription(candidate.description) || "",
          ].join(" ").toLowerCase();
          
          // RELAXED VALIDATION: Use fuzzy matching instead of exact substring matching
          // This allows AI results to pass more often while still ensuring relevance
          const hasHardTermMatch = item.evidence.matchedHardTerms.some((term: string) => {
            const termLower = term.toLowerCase();
            // Exact match
            if (candidateText.includes(termLower)) return true;
            // Fuzzy match: check if words from term appear in candidate text
            const termWords = termLower.split(/\s+/).filter(w => w.length >= 3);
            if (termWords.length > 0) {
              return termWords.every(word => candidateText.includes(word));
            }
            // Single word match (partial)
            if (termLower.length >= 4) {
              return candidateText.includes(termLower.substring(0, Math.min(termLower.length, 6)));
            }
            return false;
          });
          
          if (!hasHardTermMatch && hardTerms.length > 0) {
            // RELAXED: Instead of rejecting, check if ANY hard term appears (even if not in evidence)
            const hasAnyHardTerm = hardTerms.some(term => {
              const termLower = term.toLowerCase();
              return candidateText.includes(termLower) || 
                     termLower.split(/\s+/).some(word => word.length >= 3 && candidateText.includes(word));
            });
            
            if (!hasAnyHardTerm) {
              console.warn(`[AI Ranking] Skipping ${handle} - no hardTerm match found in candidate`);
              continue;
            } else {
              // AI claimed a match but evidence doesn't show it - trust AI but log warning
              console.warn(`[AI Ranking] AI evidence mismatch for ${handle}, but hardTerm found in text - accepting`);
            }
          }
          
          // Check avoidTerms
          if (finalAvoidTerms.length > 0) {
            const hasAvoidTerm = finalAvoidTerms.some(avoid =>
              candidateText.includes(avoid.toLowerCase())
            );
            if (hasAvoidTerm) {
              console.warn(`[AI Ranking] Skipping ${handle} - contains avoidTerm`);
              continue;
            }
          }
        }
        
        validSelectedItems.push(item);
      }
      
        console.log("[AI Ranking] Validated", validSelectedItems.length, "out of", singleItemResult.selected.length, "selected items");
      
      if (validSelectedItems.length === 0) {
          console.error("[AI Ranking] No valid selected items after runtime validation");
          
          // SAFETY: If AI returned items but all were invalid, try to use them anyway (with trustFallback)
          // This prevents 0 results when AI makes minor validation mistakes
          if (singleItemResult.selected.length > 0) {
            console.warn("[AI Ranking] ⚠️  AI returned items but all failed validation - using with trustFallback=true");
            // Use AI's selections but mark as trustFallback
            const aiHandles = singleItemResult.selected
              .map(item => item.handle.trim())
              .filter(handle => candidateMap.has(handle))
              .slice(0, resultCount);
            
            if (aiHandles.length > 0) {
              return {
                selectedHandles: aiHandles,
                reasoning: singleItemResult.selected[0]?.reason || "Selected based on your preferences.",
                trustFallback: true,
                source: "ai",
                parseFailReason: "Validation failed but using AI selections",
              };
            }
          }
          
          lastError = new Error("No valid selected items after runtime validation");
          lastParseFailReason = "No valid items after runtime validation";
        continue; // Try again if retries remaining
      }

      // Extract handles and build reasoning
      const selectedHandles = validSelectedItems
        .slice(0, resultCount)
        .map(item => item.handle.trim());
      
        // Build human-like reasoning from AI's item reasons (prioritize AI feedback)
        const itemReasons = validSelectedItems
          .slice(0, resultCount)
          .map(item => item.reason)
          .filter(Boolean);
        
      let reasoning: string;
        
        // Prioritize AI's human-like reasons if available
        if (itemReasons.length > 0) {
          // Use AI's reasons as primary feedback (more human-like)
          reasoning = itemReasons.join(" ");
          
          // Add brief context if helpful (but keep it natural)
          if (!trustFallback && hardTerms.length > 0 && itemReasons.length >= resultCount) {
            // All items have reasons, so the AI feedback is comprehensive
            // No need to add generic summary
          } else if (trustFallback && hardTerms.length > 0) {
            // Add context about alternatives if trustFallback
            reasoning = `Showing closest matches to "${hardTerms.join(", ")}". ${reasoning}`;
          }
        } else {
          // Fallback to summary if AI didn't provide reasons (shouldn't happen with structured output)
      if (!trustFallback && hardTerms.length > 0) {
        const matchedTerms = [...new Set(validSelectedItems.flatMap(item => item.evidence?.matchedHardTerms || []))];
        const facetParts: string[] = [];
        if (hardFacetsForPrompt.size) facetParts.push(`size: ${hardFacetsForPrompt.size.join(", ")}`);
        if (hardFacetsForPrompt.color) facetParts.push(`color: ${hardFacetsForPrompt.color.join(", ")}`);
        if (hardFacetsForPrompt.material) facetParts.push(`material: ${hardFacetsForPrompt.material.join(", ")}`);
            const facetsText = facetParts.length > 0 ? ` with ${facetParts.join(", ")}` : "";
            reasoning = `Selected products matching ${matchedTerms.join(", ")}${facetsText}.`;
      } else if (trustFallback && hardTerms.length > 0) {
        reasoning = `No exact matches found for "${hardTerms.join(", ")}"; showing closest alternatives.`;
      } else {
            reasoning = "Selected products based on your preferences.";
          }
      }

      console.log("[AI Ranking] source=ai trustFallback=", trustFallback);
      console.log("[AI Ranking] Successfully ranked", selectedHandles.length, "products");
      
      // Cache the result for future requests (best-effort, don't block)
      if (shopId) {
        const cacheKey = generateCacheKey(
          userIntent,
          candidates,
          resultCount,
          variantConstraints,
          variantPreferences,
          includeTerms,
          avoidTerms
        );
        // Store in cache asynchronously (don't await, don't block return)
        setCachedRanking(
          cacheKey,
          shopId,
          userIntent,
          candidates,
          selectedHandles,
          reasoning || null,
          resultCount
        ).catch(err => {
          console.error("[AI Ranking] Error caching result (non-blocking):", err);
        });
      }
      
      // NOTE: Billing is handled once per session after final results are computed.
      // rankProductsWithAI should not create UsageEvents or set chargedAt/creditsBurned.
      // This allows multi-pass AI ranking (top-up passes) without duplicate charges.
      
      return {
        selectedHandles,
        reasoning: reasoning || null,
        trustFallback,
        source: "ai",
        parseFailReason: null,
      };
      }
    } catch (error: any) {
      lastError = error;
      
      // Determine fail type and reason
      // Use responseStatus/responseId from try block if available (response was received)
      let failType: "timeout" | "parse" | "http" | "unknown";
      let failReason: string;
      let httpStatus: number | null = responseStatus;
      let errorResponseId: string | null = responseId || bodyResponseId;
      
      // Extract error details from OpenAI error object
      const errorMessage = error?.message || error?.error?.message || null;
      const errorType = error?.type || error?.error?.type || null;
      const errorCode = error?.code || error?.error?.code || null;
      const errorParam = error?.param || error?.error?.param || null;
      
      // Get request payload keys for debugging (without logging full content)
      const requestPayloadKeys = requestBody ? Object.keys(requestBody) : [];
      const responseFormatKeys = requestBody?.response_format ? Object.keys(requestBody.response_format) : [];
      
      if (error.name === "AbortError") {
        failType = "timeout";
        failReason = `Request timeout after ${timeoutMs}ms`;
        // Timeout means no response was received
        httpStatus = null;
        errorResponseId = null;
      } else if (error.response) {
        // HTTP error caught in fetch (response object exists but indicates error)
        failType = "http";
        httpStatus = error.response.status || responseStatus || null;
        errorResponseId = error.response.headers?.["x-request-id"] || error.response.headers?.["openai-request-id"] || responseId || null;
        failReason = httpStatus ? `HTTP ${httpStatus}` : "HTTP error";
        if (errorMessage) {
          failReason += `: ${errorMessage.substring(0, 100)}`; // Truncate for safety
        }
      } else if (httpStatus !== null) {
        // We got a response but parsing or processing failed
        failType = "parse";
        failReason = "Response processing error";
        if (errorMessage) {
          failReason += `: ${errorMessage.substring(0, 100)}`; // Truncate for safety
        }
      } else if (errorMessage && (errorMessage.includes("JSON") || errorMessage.includes("parse"))) {
        // Parse error before response received
        failType = "parse";
        failReason = "Parse error";
        if (errorMessage) {
          failReason += `: ${errorMessage.substring(0, 100)}`; // Truncate for safety
        }
      } else {
        // Unknown error (network, etc.)
        failType = "unknown";
        failReason = errorMessage ? errorMessage.substring(0, 100) : String(error).substring(0, 100); // Truncate for safety
      }
      
      // Enhanced structured error log with request parameter details
      const logData: any = {
        attempt: attempt + 1,
        status: httpStatus || "unknown",
        fail_type: failType,
        fail_reason: failReason,
      };
      if (errorResponseId) logData.response_id = errorResponseId;
      if (errorMessage) logData.error_message = errorMessage.substring(0, 200); // Truncate for safety
      if (errorType) logData.error_type = errorType;
      if (errorCode) logData.error_code = errorCode;
      if (errorParam) logData.error_param = errorParam;
      
      // Log request payload structure (keys only, no values to avoid logging prompts/products)
      logData.request_payload_keys = requestPayloadKeys;
      if (responseFormatKeys.length > 0) {
        logData.response_format_keys = responseFormatKeys;
      }
      
      // Also log sizes already tracked (candidateCount, productListJsonChars) for context
      logData.candidate_count = currentCandidateCount;
      logData.product_list_json_chars = currentProductListJsonChars;
      
      console.log("[AI Ranking] attempt=", logData.attempt, "status=", logData.status, "fail_type=", logData.fail_type, "fail_reason=", logData.fail_reason, 
        errorResponseId ? `response_id=${errorResponseId}` : "",
        errorType ? `error_type=${errorType}` : "",
        errorCode ? `error_code=${errorCode}` : "",
        errorParam ? `error_param=${errorParam}` : "",
        `request_payload_keys=[${requestPayloadKeys.join(",")}]`,
        responseFormatKeys.length > 0 ? `response_format_keys=[${responseFormatKeys.join(",")}]` : "",
        `candidate_count=${currentCandidateCount} product_list_json_chars=${currentProductListJsonChars}`
      );
      
      lastParseFailReason = failReason;
      
      // Continue to next attempt if retries remaining
      if (attempt < MAX_RETRIES) {
        continue;
      }
    }
  }

  // All attempts failed - return deterministic fallback (structured result, not throwing)
  const failReason = lastParseFailReason || (lastError instanceof Error ? lastError.message : String(lastError || "Unknown error"));
  console.log("[AI Ranking] source=fallback parse_fail_reason=", failReason);
  
  // Determine fallback scope: if strictGateCount > 0, use strict gate pool only; otherwise use full candidates
  let fallbackCandidates = candidates;
  let fallbackScope: "strict_gate" | "full_pool" = "full_pool";
  
  if (strictGateCount !== undefined && strictGateCount > 0 && strictGateCandidates && strictGateCandidates.length > 0) {
    fallbackCandidates = strictGateCandidates;
    fallbackScope = "strict_gate";
  }
  
  console.log("[AI Ranking] fallback_scope=", fallbackScope);
  
  // Return structured fallback result instead of throwing
  const fallbackResult = deterministicRanking(fallbackCandidates, resultCount, variantPreferences, failReason);
  
  // SAFETY: Ensure fallback always returns at least some results
  if (fallbackResult.selectedHandles.length === 0 && fallbackCandidates.length > 0) {
    console.warn("[AI Ranking] ⚠️  Fallback returned 0 handles - using first available candidates");
    // Use first available candidates as absolute fallback
    const availableCandidates = fallbackCandidates.filter(c => c.available);
    const fallbackCandidatesToUse = availableCandidates.length > 0 ? availableCandidates : fallbackCandidates;
    fallbackResult.selectedHandles = fallbackCandidatesToUse
      .slice(0, Math.min(resultCount, fallbackCandidatesToUse.length))
      .map(c => c.handle);
    fallbackResult.reasoning = "Showing the best available matches for your request.";
    console.log(`[AI Ranking] ✅ Absolute fallback applied: ${fallbackResult.selectedHandles.length} products`);
  }
  
  return fallbackResult;
}

/**
 * Fallback ranking: simple sorting by newest/available
 */
export function fallbackRanking(
  candidates: ProductCandidate[],
  resultCount: number
): string[] {
  // Sort by: available first, then by handle (stable sort)
  const sorted = [...candidates].sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    return a.handle.localeCompare(b.handle);
  });

  return sorted.slice(0, resultCount).map(p => p.handle);
}


