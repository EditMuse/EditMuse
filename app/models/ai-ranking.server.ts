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
import OpenAI from "openai";

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
  label: "exact" | "good" | "fallback";
  score: number;
  evidence?: Evidence; // Optional in minimal schema
  reason?: string; // Optional in minimal schema
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
 * Extracts a description snippet from product data (industry-agnostic)
 * Sources from description, bodyHtml, or other available fields
 * Strips HTML, normalizes whitespace, truncates to maxChars
 */
function extractDescriptionSnippet(product: ProductCandidate | any, maxChars: number = 400): string {
  // Try multiple possible description fields (industry-agnostic)
  let rawDescription: string | null | undefined = 
    product.description || 
    product.bodyHtml || 
    product.body_html ||
    product.longDescription ||
    product.long_description ||
    product.fullDescription ||
    product.full_description ||
    (product as any).desc1000 ||
    null;
  
  if (!rawDescription) return "";
  
  // Clean HTML and normalize
  let cleaned = cleanDescription(rawDescription);
  
  // Truncate to maxChars (hard cap)
  if (cleaned.length > maxChars) {
    cleaned = cleaned.substring(0, maxChars).trim();
  }
  
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
 * @deprecated This function is no longer used. We now use OpenAI SDK structured parsing (message.parsed).
 * Kept for backward compatibility fallback only.
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
    
    // CRITICAL FIX: Handle "Expected ',' or ']' after array element" errors
    // Fix missing commas between array elements (most common issue)
    // Pattern: Object/array element followed by another element without comma
    // Must be careful to only fix within arrays, not within object properties
    
    // Fix: Missing comma between array elements (object in array)
    // Pattern: "}" followed by "{" (object element in array) - but only if not inside a string
    fixed = fixed.replace(/([^,\s])\s*}\s*{/g, '$1}, {'); // Object before object in array
    fixed = fixed.replace(/([^,\s])\s*]\s*\[/g, '$1], ['); // Array before array
    fixed = fixed.replace(/([^,\s])\s*}\s*\[/g, '$1}, ['); // Object before array
    fixed = fixed.replace(/([^,\s])\s*]\s*{/g, '$1], {'); // Array before object
    
    // Fix: Missing comma between array elements of any type
    // Pattern: Value followed by value without comma (within array context)
    fixed = fixed.replace(/([^,\s\]}])\s+(["{[\d])/g, '$1, $2'); // Any value before bracket/brace/quote/digit
    fixed = fixed.replace(/([^,\s\]}]")\s*"([^,\s\]}])/g, '$1, "$2'); // String before string
    fixed = fixed.replace(/(\d+)\s+(["{[\d])/g, '$1, $2'); // Number before value
    fixed = fixed.replace(/(true|false|null)\s+(["{[\d])/g, '$1, $2'); // Boolean/null before value
    
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
      // Third attempt: More aggressive repair (handles "Expected ',' or '}' after property value" and array errors)
      // Use a more comprehensive approach to fix JSON syntax
      let repaired = fixed;
      
      // CRITICAL FIX: Handle "Expected ',' or '}' after property value" errors
      // Pattern: Property value followed by another property or closing brace without comma
      // Example: "key": "value" "key2": ... or "key": "value" }
      // Also handle nested structures: "material": [] } or "color": ["Blue"] }
      repaired = repaired.replace(/("(?:[^"\\]|\\.)*")\s*("(?:[^"\\]|\\.)*":)/g, '$1, $2'); // String value before string property
      repaired = repaired.replace(/(\d+)\s*("(?:[^"\\]|\\.)*":)/g, '$1, $2'); // Number before property
      repaired = repaired.replace(/(true|false|null)\s*("(?:[^"\\]|\\.)*":)/g, '$1, $2'); // Boolean/null before property
      repaired = repaired.replace(/([}\]"])\s*("(?:[^"\\]|\\.)*":)/g, '$1, $2'); // Closing bracket/brace/quote before property
      
      // CRITICAL FIX: Handle missing comma after array/object value before closing brace
      // Pattern: "material": [] } or "color": ["Blue"] } or "size": [] }
      // This is a common error where array/object values are followed by closing brace without comma
      repaired = repaired.replace(/(\])\s*([}])/g, '$1$2'); // Array before closing brace (no comma needed, but ensure no space issues)
      repaired = repaired.replace(/(\])\s*("(?:[^"\\]|\\.)*":)/g, '$1, $2'); // Array before property (needs comma)
      repaired = repaired.replace(/(\[(?:[^\]]*)\]\s*)\s*([}])/g, '$1$2'); // Array value before closing brace
      
      // Fix missing commas in arrays - more aggressive patterns
      // CRITICAL FIX: Handle "Expected ',' or ']' after array element" errors
      // Pattern: Array element followed by another element or closing bracket without comma
      // Example: { "key": "value" } { "key2": "value2" } or { "key": "value" }]
      
      // Fix: Missing comma between array elements (object in array)
      // Pattern: "}" followed by "{" (object element in array)
      repaired = repaired.replace(/([^,\s])\s*}\s*{/g, '$1}, {'); // Object before object in array
      repaired = repaired.replace(/([^,\s])\s*]\s*\[/g, '$1], ['); // Array before array
      repaired = repaired.replace(/([^,\s])\s*}\s*\[/g, '$1}, ['); // Object before array
      repaired = repaired.replace(/([^,\s])\s*]\s*{/g, '$1], {'); // Array before object
      
      // Fix: Missing comma after array element before closing bracket
      // Pattern: "}" or "]" followed by "]" (element before closing bracket)
      repaired = repaired.replace(/([^,\s])\s*}\s*]/g, '$1}]'); // Object element before closing bracket (no comma needed)
      repaired = repaired.replace(/([^,\s])\s*]\s*]/g, '$1]]'); // Array element before closing bracket (no comma needed)
      
      // Fix: Missing comma between array elements (any type)
      repaired = repaired.replace(/([^,\s\]}])\s+(["{[\d])/g, '$1, $2'); // Any value before bracket/brace/quote/digit
      repaired = repaired.replace(/([^,\s\]}]")\s*"([^,\s\]}])/g, '$1, "$2'); // String before string
      repaired = repaired.replace(/(\d+)\s+(["{[\d])/g, '$1, $2'); // Number before value
      repaired = repaired.replace(/(true|false|null)\s+(["{[\d])/g, '$1, $2'); // Boolean/null before value
      repaired = repaired.replace(/([}\]"])\s*([{["\d])/g, '$1, $2'); // Closing bracket/brace/quote before opening
      
      // Fix missing commas in nested structures
      repaired = repaired.replace(/([}\]"])\s*"([^"]+)":/g, '$1, "$2":'); // Missing comma before property
      repaired = repaired.replace(/([}\]"])\s*([{[])/g, '$1, $2'); // Missing comma between structures
      
      // Fix property value followed by closing brace without comma
      repaired = repaired.replace(/("(?:[^"\\]|\\.)*")\s*([}])/g, '$1$2'); // String value before closing brace (no comma needed)
      repaired = repaired.replace(/(\d+)\s*([}])/g, '$1$2'); // Number before closing brace
      repaired = repaired.replace(/(true|false|null)\s*([}])/g, '$1$2'); // Boolean/null before closing brace
      
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
    
    if (item.label !== "exact" && item.label !== "good" && item.label !== "fallback") {
      return { valid: false, reason: `Invalid label: ${item.label} (must be "exact", "good", or "fallback")` };
    }
    
    if (typeof item.score !== "number" || item.score < 0 || item.score > 100) {
      return { valid: false, reason: `Invalid score: ${item.score}` };
    }
    
    // Evidence and reason are optional in minimal schema - skip validation if not present
    // If evidence is provided, validate it (for backward compatibility)
    if (item.evidence !== undefined) {
      if (typeof item.evidence !== "object" || !item.evidence) {
        return { valid: false, reason: "Invalid evidence (if provided, must be object)" };
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
  strictGateCandidates?: ProductCandidate[],
  conversationMessages?: Array<{ role: "system" | "user" | "assistant"; content: string }>
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
      // Compressed mode: include key structured fields + description snippet
      return candidatesToUse.slice(0, maxCandidates).map((p, idx) => {
        const tags = (p.tags && p.tags.length > 0) ? p.tags.slice(0, 20).join(", ") : "none";
        const sizes = (p.sizes && p.sizes.length > 0) ? p.sizes.slice(0, 10).join(", ") : "none";
        const colors = (p.colors && p.colors.length > 0) ? p.colors.slice(0, 10).join(", ") : "none";
        const materials = (p.materials && p.materials.length > 0) ? p.materials.slice(0, 10).join(", ") : "none";
        const descriptionSnippet = extractDescriptionSnippet(p, 400);
        
        return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   vendor: ${p.vendor || "unknown"}
   tags: ${tags}
   sizes: ${sizes}
   colors: ${colors}
   materials: ${materials}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   descriptionSnippet: ${descriptionSnippet || ""}`;
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
    
    const descriptionSnippet = extractDescriptionSnippet(p, 400);
    
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
   descriptionSnippet: ${descriptionSnippet || ""}`;
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

CRITICAL OUTPUT FORMAT (MINIMAL):
- Return ONLY the fields required by the schema - no extra keys, no explanations, no evidence, no reasons
- Do not include explanations, reasons, evidence, or extra keys
- Keep output concise to avoid truncation
- Return ONLY valid JSON (no markdown, no prose, no explanations outside JSON)
- Output must be parseable JSON.parse() directly
- Use the exact bundle schema provided below - no deviations

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
${trustFallback ? `- trustFallback=true: You may show alternatives when exact matches are insufficient, but MUST label each as "exact", "good", or "fallback"` : `- trustFallback=false: EVERY returned product MUST satisfy ALL of the following:
  a) At least one hardTerm match for its itemIndex in (title OR productType OR tags OR descriptionSnippet)
  b) ALL hardFacets must match when provided (size, color, material)
  c) Must NOT contain any avoidTerms in title/tags/descriptionSnippet (unless avoidTerms is empty)
  d) Handle MUST exist in that itemIndex's candidate group`}

OUTPUT SCHEMA (MUST be exactly this structure - MINIMAL):
{
  "trustFallback": ${trustFallback},
  "selected_by_item": [
    {
      "itemIndex": 0,
      "handle": "exact-handle-from-item-0-candidates",
      "label": "exact",
      "score": 85
    }
  ]
}

CRITICAL HANDLE REQUIREMENTS:
- You MUST select handles ONLY from allowedHandles (see below)
- Handles must match EXACTLY (case-sensitive, identical string)
- Do NOT invent, modify, prefix, or alter handles
- If the best match handle is not obvious, choose the closest handle from allowedHandles

REQUIREMENTS:
- "selected_by_item" array MUST contain at least 1 selection per itemIndex (exactly 1 primary per item)
- After primaries, add alternates to reach ${resultCount} total, distributing evenly across items
- All handles must exist in their itemIndex's candidate group (copy exactly as shown)
- No duplicate handles
- label must be one of: "exact", "good", "fallback"
- score must be 0-100 (higher = better match)
  * Example GOOD: "This sophisticated navy suit is ideal for business meetings and formal events, with excellent tailoring for a polished look"
  * Example BAD: "Matches suit category and navy color; satisfies formal wear requirements"
`
    : `You are an expert product recommendation assistant for an e-commerce store. Your task is to rank products from a pre-filtered candidate list based on strict matching rules.

CRITICAL OUTPUT FORMAT (MINIMAL):
- Return ONLY the fields required by the schema - no extra keys, no explanations, no evidence, no reasons
- Do not include explanations, reasons, evidence, or extra keys
- Keep output concise to avoid truncation
- Return ONLY valid JSON (no markdown, no prose, no explanations outside JSON)
- Output must be parseable JSON.parse() directly
- Use the exact schema provided below - no deviations

HARD CONSTRAINT RULES:
${hardTerms.length === 0 ? `- hardTerms is EMPTY: Rank products by soft terms + overall relevance. Do NOT reject products for missing hardTerms since none were specified. Prioritize products that match soft terms, variant preferences, and overall relevance to the user's intent.` : trustFallback ? `- trustFallback=true: You may show alternatives when exact matches are insufficient, but MUST label each as "exact", "good", or "fallback"` : `- trustFallback=false: EVERY returned product MUST satisfy ALL of the following:
  a) At least one hardTerm match in (title OR productType OR tags OR descriptionSnippet)
  b) ALL hardFacets must match when provided (size, color, material)
  c) Must NOT contain any avoidTerms in title/tags/descriptionSnippet (unless avoidTerms is empty)`}

CATEGORY DRIFT PREVENTION:
- If hardTerm includes a specific category (e.g., "suit", "sofa", "treadmill", "serum"), do NOT return adjacent categories:
  * "suit" → do NOT return "shirt", "trousers", "blazer", "jacket" unless trustFallback=true AND labeled "alternative"
  * "sofa" → do NOT return "chair", "loveseat", "futon" unless trustFallback=true AND labeled "alternative"
  * "treadmill" → do NOT return "exercise bike", "elliptical", "rower" unless trustFallback=true AND labeled "alternative"
  * "serum" → do NOT return "moisturizer", "cleanser", "toner" unless trustFallback=true AND labeled "alternative"
- Only exact category matches can be labeled "exact"
- Adjacent categories can only be "alternative" when trustFallback=true

MATCHING REQUIREMENTS:
1. Check title, productType, tags, and descriptionSnippet for hardTerm matches
2. Verify hardFacet matches in sizes/colors/materials arrays
3. Exclude products containing avoidTerms in title/tags/descriptionSnippet
5. Score 0-100 based on relevance (higher = better match)

OUTPUT SCHEMA (MUST be exactly this structure - MINIMAL):
{
  "trustFallback": ${trustFallback},
  "selected": [
    {
      "handle": "exact-handle-from-candidate-list",
      "label": "exact",
      "score": 85
    }
  ]
}

REQUIREMENTS:
- "selected" array MUST contain exactly ${resultCount} items
- All handles must exist in the candidate list (copy exactly as shown)
- No duplicate handles
- label must be one of: "exact", "good", "fallback"
- score must be 0-100 (higher = better match)`;

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
          const descriptionSnippet = extractDescriptionSnippet(p, 400);
          
          return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   vendor: ${p.vendor || "unknown"}
   tags: ${tags}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   descriptionSnippet: ${descriptionSnippet || ""}`;
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

ALLOWED HANDLES (You MUST use ONLY these exact handles):
${Array.from(candidatesByItem.values()).flat().map(c => c.handle).filter((h, i, arr) => arr.indexOf(h) === i).slice(0, 100).join(", ")}${Array.from(candidatesByItem.values()).flat().map(c => c.handle).filter((h, i, arr) => arr.indexOf(h) === i).length > 100 ? ` (and ${Array.from(candidatesByItem.values()).flat().map(c => c.handle).filter((h, i, arr) => arr.indexOf(h) === i).length - 100} more)` : ""}

TASK:
1. For each bundle item, choose exactly 1 primary selection from that item's candidate group
2. After selecting 1 primary per item, add alternates to fill ${resultCount} total selections
3. Distribute alternates evenly across items (round-robin)
4. Enforce budget: prefer selections where sum(price) <= totalBudget; if impossible, set trustFallback=true and label alternatives

For each selected item in selected_by_item:
   - itemIndex: Must match the candidate's group (0, 1, 2, ...)
   - Exact handle (MUST match EXACTLY from allowedHandles above - case-sensitive, identical string)
   - Label: "exact" if all constraints satisfied, "good" or "fallback" if trustFallback=true
   - Score: 0-100 based on match quality

CRITICAL: Handles must match EXACTLY from allowedHandles. Do NOT invent, modify, prefix, or alter handles.

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
   - At least one hardTerm in title/productType/tags/descriptionSnippet
   - All hardFacets match (if provided in candidate data)
   - No avoidTerms in title/tags/descriptionSnippet`
      : `1. For each candidate, check if it satisfies the hard constraints:
   - At least one hardTerm in title/productType/tags/descriptionSnippet
   - All hardFacets match (size/color/material in candidate arrays)
   - No avoidTerms in title/tags/descriptionSnippet`;
    
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

ALLOWED HANDLES (You MUST use ONLY these exact handles):
${currentCandidates.map(c => c.handle).slice(0, 100).join(", ")}${currentCandidates.length > 100 ? ` (and ${currentCandidates.length - 100} more)` : ""}

TASK:
${matchingRequirements}

2. Select exactly ${resultCount} products:
   ${trustFallback ? "- If ${resultCount} exact matches exist, return all as 'exact'" : "- ALL must be 'exact' matches (satisfy all hard constraints)"}
   ${trustFallback ? "- If fewer than ${resultCount} exact matches, fill with 'alternative' matches closest to intent" : "- If fewer than ${resultCount} exact matches exist, return only the exact matches you find"}

3. For each selected item, provide:
   - Exact handle (MUST match EXACTLY from allowedHandles above - case-sensitive, identical string)
   - Label: "exact" if all constraints satisfied, "good" or "fallback" if trustFallback=true
   - Score: 0-100 based on match quality

CRITICAL: Handles must match EXACTLY from allowedHandles. Do NOT invent, modify, prefix, or alter handles.

Return ONLY the JSON object matching the schema - no markdown, no prose outside JSON.`;
  }
  
  let userPrompt = buildUserPrompt(false);

  // Build JSON schema for StructuredRankingResult or StructuredBundleResult if supported
  // MINIMAL SCHEMA: Only essential fields to reduce output size and prevent truncation
  function buildJsonSchema(isBundle: boolean = false) {
    const minimalItemSchema = {
      type: "object",
      properties: {
        handle: { type: "string" },
        score: { type: "number", minimum: 0, maximum: 100 },
        label: { type: "string", enum: ["exact", "good", "fallback"] },
      },
      required: ["handle", "score", "label"],
      additionalProperties: false,
    };
    
    if (isBundle) {
      // Bundle schema: minimal - only trustFallback and selected_by_item
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
                score: { type: "number", minimum: 0, maximum: 100 },
                label: { type: "string", enum: ["exact", "good", "fallback"] },
              },
              required: ["itemIndex", "handle", "score", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["trustFallback", "selected_by_item"],
        additionalProperties: false,
      };
    } else {
      // Single-item schema: minimal - only trustFallback and selected
      return {
        type: "object",
        properties: {
          trustFallback: { type: "boolean" },
          selected: {
            type: "array",
            items: minimalItemSchema,
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
    // <= 15 candidates and <= 10k chars: 30s (increased from 20s for better AI success rate)
    if (candidateCount <= 15 && productListJsonChars <= 10000) {
      return 30000;
    }
    // <= 25 candidates and <= 15k chars: 35s (increased from 30s)
    if (candidateCount <= 25 && productListJsonChars <= 15000) {
      return 35000;
    }
    // <= 40 candidates or <= 25k chars: 45s (increased from 40s)
    if (candidateCount <= 40 || productListJsonChars <= 25000) {
      return 45000;
    }
    // else: 60s (increased from 50s for very large requests)
    return 60000;
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
      
      // On retry after parse failure, use smaller candidate set (reduce by 30-50%)
      if (isRetry && lastParseFailReason && lastParseFailReason.includes("parse") && currentCandidates.length === candidates.length) {
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
      // Use ONLY Chat Completions API with structured outputs (json_schema)
      // This guarantees valid JSON output that matches the schema exactly
      // Note: json_schema is supported through chat.completions, not a separate responses endpoint
      apiUsed = "chat";
      
      // Build messages array: use conversation history if available, otherwise use single userIntent
      let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
      
      if (conversationMessages && conversationMessages.length > 0) {
        // Use full conversation context
        // Check if first message is a system message (from conversation context)
        const hasSystemMessage = conversationMessages[0]?.role === "system";
        if (hasSystemMessage) {
          // Combine system messages: original conversation system + our system prompt
          const existingSystemContent = conversationMessages[0].content || "";
          messages.push({
            role: "system",
            content: `${existingSystemContent}\n\n${systemPrompt}`
          });
          // Add rest of conversation (skip first system message)
          messages.push(...conversationMessages.slice(1));
        } else {
          // No system message in conversation - add our system prompt first
          // Then add all conversation messages (user/assistant)
          messages.push({ role: "system", content: systemPrompt });
          messages.push(...conversationMessages);
        }
        
        // Add the current product ranking task as the final user message
        const taskContent = useCompressedPrompt ? buildUserPrompt(false, true) : userPrompt;
        if (taskContent && taskContent.trim().length > 0) {
          messages.push({
            role: "user",
            content: taskContent
          });
        }
        
        console.log(`[AI Ranking] ✅ Using conversation context: ${conversationMessages.length} conversation messages + 1 system + 1 task = ${messages.length} total messages`);
      } else {
        // Fallback to single userIntent (backward compatibility)
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: useCompressedPrompt ? buildUserPrompt(false, true) : userPrompt },
        ];
        console.log("[AI Ranking] Using single userIntent (no conversation context)");
      }
      
      // Adjust timeout based on conversation length (more messages = more processing time)
      const conversationLength = messages.length;
      const baseTimeout = timeoutMs;
      // Add 5 seconds per additional message beyond 2 (system + user)
      const conversationTimeoutAdjustment = Math.max(0, (conversationLength - 2) * 5000);
      timeoutMs = baseTimeout + conversationTimeoutAdjustment;
      // Cap at 90 seconds max for very long conversations
      timeoutMs = Math.min(timeoutMs, 90000);
      
      if (conversationTimeoutAdjustment > 0) {
        console.log(`[AI Ranking] Adjusted timeout for conversation: ${baseTimeout}ms + ${conversationTimeoutAdjustment}ms = ${timeoutMs}ms (${conversationLength} messages)`);
      }
      
      if (supportsJsonSchema) {
        // Use Chat Completions API with json_schema for structured outputs
        requestBody = {
          model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: isBundle ? "structured_bundle_result" : "structured_ranking_result",
              strict: true,
              schema: buildJsonSchema(isBundle),
            },
          },
          temperature: 0,
          max_tokens: 1400, // Increased to 1400 for all ranking to reduce truncation risk
        };
        
        console.log("[AI Ranking] structured_outputs=true");
      } else {
        // Fallback for models that don't support json_schema - use json_object mode
        // Use same messages array (with conversation context if available)
        requestBody = {
          model,
          messages,
          temperature: 0,
          max_tokens: 1400, // Increased to 1400 for all ranking to reduce truncation risk
          response_format: { type: "json_object" },
        };
        console.warn("[AI Ranking] Model does not support json_schema, falling back to json_object mode");
      }

      // Use OpenAI SDK for structured parsing with strict JSON schema
      const openai = new OpenAI({
        apiKey: apiKey,
        timeout: timeoutMs,
      });

      // Build SDK request parameters (matching requestBody for logging consistency)
      const sdkRequestParams = {
        model: model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        response_format: supportsJsonSchema ? {
          type: "json_schema" as const,
          json_schema: {
            name: isBundle ? "structured_bundle_result" : "structured_ranking_result",
            strict: true,
            schema: buildJsonSchema(isBundle),
          },
        } : { type: "json_object" as const },
        temperature: 0,
        max_tokens: 1400, // Increased to 1400 for all ranking to reduce truncation risk
      };

      let completion: any; // Use 'any' since parse() returns a different type with parsed output
      try {
        // Use chat.completions.parse() for structured outputs - this ensures message.parsed is populated
        console.log("[AI Ranking] max_tokens=1400");
        console.log("[AI Ranking] include_description_snippets=true snippet_max_chars=400");
        console.log("[AI Ranking] schema=minimal_v1");
        if (supportsJsonSchema) {
          // Use parse() method for structured outputs with json_schema
          completion = await openai.chat.completions.parse({
            model: model,
            messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: isBundle ? "structured_bundle_result" : "structured_ranking_result",
                strict: true,
                schema: buildJsonSchema(isBundle),
              },
            },
            temperature: 0,
            max_tokens: 1400,
          });
        } else {
          // Fallback to create() for json_object mode (parse() requires json_schema)
          completion = await openai.chat.completions.create(sdkRequestParams);
        }
      } catch (sdkError: any) {
        clearTimeout(timeoutId);
        
        // Handle timeout/abort
        if (sdkError.name === "AbortError" || controller.signal.aborted || sdkError.message?.includes("timeout")) {
          lastError = new Error(`Request timeout after ${timeoutMs}ms`);
          lastParseFailReason = `Request timeout after ${timeoutMs}ms`;
          responseStatus = null;
          responseId = null;
          continue; // Try again if retries remaining
        }
        
        // Handle API errors
        if (sdkError.status) {
          responseStatus = sdkError.status;
          responseId = sdkError.request_id || null;
          const errorType = sdkError.type || null;
          const errorCode = sdkError.code || null;
          let failReason = `HTTP ${responseStatus}`;
          if (errorType) failReason += ` ${errorType}`;
          if (errorCode) failReason += ` (${errorCode})`;
          
          console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus, "fail_type=http fail_reason=", failReason, responseId ? `response_id=${responseId}` : "");
          lastError = sdkError;
          lastParseFailReason = failReason;
          continue; // Try again if retries remaining
        }
        
        // Re-throw other errors
        throw sdkError;
      }

      clearTimeout(timeoutId);
      
      // Extract response metadata
      responseStatus = 200; // SDK handles HTTP, assume success if we got here
      responseId = completion.id || null;
      bodyResponseId = completion.id || null;
      
      // Parse structured output from SDK
      // With strict JSON schema, the SDK provides parsed output in message.parsed
      let structuredResult: StructuredRankingResult | StructuredBundleResult | null = null;
      
      const message = completion.choices?.[0]?.message;
      if (!message) {
        const parseResponseId = completion.id || responseId || bodyResponseId || null;
        console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus || "unknown", "fail_type=parse fail_reason=No message in choices", parseResponseId ? `response_id=${parseResponseId}` : "");
        lastError = new Error("No message in choices array");
        lastParseFailReason = "No message in choices array";
        continue;
      }
      
      // Check for refusal
      if (message.refusal) {
        const refusalResponseId = completion.id || responseId || bodyResponseId || null;
        console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus || "unknown", "fail_type=parse fail_reason=Model refusal", refusalResponseId ? `response_id=${refusalResponseId}` : "");
        console.log("[AI Ranking] Model refused to generate structured output");
        lastError = new Error("Model refused to generate structured output");
        lastParseFailReason = "Model refusal";
        continue; // Try again if retries remaining
      }

      // Use parsed output from SDK (structured outputs with strict schema)
      // When using parse() method, message.parsed is guaranteed to be populated for json_schema mode
      const messageWithParsed = message as any; // Type assertion to access parsed property
      
      if (messageWithParsed.parsed) {
        // SDK parse() method provides parsed output directly (structured outputs with strict schema)
        structuredResult = messageWithParsed.parsed as StructuredRankingResult | StructuredBundleResult;
        console.log("[AI Ranking] structured_outputs=true");
        console.log("[AI Ranking] parsed_output=true");
      } else if (supportsJsonSchema) {
        // This should not happen with parse() method - treat as failure
        const parseResponseId = bodyResponseId || responseId || null;
        console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus || "unknown", "fail_type=parse fail_reason=Missing parsed output from SDK parse() method", parseResponseId ? `response_id=${parseResponseId}` : "");
        lastError = new Error("Missing parsed output from SDK parse() method");
        lastParseFailReason = "Missing parsed output from SDK parse() method";
        continue; // This will eventually fallback after MAX_RETRIES
      } else {
        // For json_object fallback mode, we used create() not parse(), so parsed won't exist
        // This is an extreme safety fallback - should not normally reach here
        const parseResponseId = bodyResponseId || responseId || null;
        console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus || "unknown", "fail_type=parse fail_reason=No parsed output (json_object fallback mode)", parseResponseId ? `response_id=${parseResponseId}` : "");
        lastError = new Error("No parsed output (json_object fallback mode)");
        lastParseFailReason = "No parsed output (json_object fallback mode)";
        continue; // This will eventually fallback after MAX_RETRIES
      }

      // If we still don't have a structured result, this is an error
      if (!structuredResult) {
        const parseResponseId = bodyResponseId || responseId || null;
        console.log("[AI Ranking] attempt=", attempt + 1, "status=", responseStatus || "unknown", "fail_type=parse fail_reason=Failed to parse structured output", parseResponseId ? `response_id=${parseResponseId}` : "");
        lastError = new Error("Failed to parse structured output");
        lastParseFailReason = "Failed to parse structured output";
        continue;
      }

      console.log("[AI Ranking] Successfully parsed structured output (strict mode)");

      // Strict schema ensures only required fields are present
      // No need to set defaults for removed fields (rejected_candidates, selected in bundle)

      // Validate bundle response if in bundle mode
      if (isBundle && "selected_by_item" in structuredResult) {
        const bundleResult = structuredResult as StructuredBundleResult;
        
        // Defensive check: validate all handles are in allowedHandles before processing
        const allowedHandles = new Set(currentCandidates.map(c => c.handle));
        const bundleReturnedHandles = bundleResult.selected_by_item.map(item => item.handle.trim());
        const invalidHandles = bundleReturnedHandles.filter(handle => !allowedHandles.has(handle));
        
        if (invalidHandles.length > 0) {
          for (const invalidHandle of invalidHandles) {
            console.log(`[AI Ranking] invalid_handle_returned=${invalidHandle} (not in allowedHandles)`);
          }
          console.log(`[AI Ranking] allowed_handles_count=${allowedHandles.size}`);
          const firstFiveHandles = Array.from(allowedHandles).slice(0, 5);
          console.log(`[AI Ranking] allowed_handles_preview=[${firstFiveHandles.join(", ")}]`);
          lastError = new Error(`Invalid handles returned: ${invalidHandles.join(", ")}`);
          lastParseFailReason = `Invalid handles returned: ${invalidHandles.join(", ")}`;
          continue; // This will eventually fallback after MAX_RETRIES
        }
        
        // Log allowed handles count
        console.log(`[AI Ranking] allowed_handles_count=${allowedHandles.size}`);
        if (allowedHandles.size <= 20) {
          const allHandles = Array.from(allowedHandles);
          console.log(`[AI Ranking] allowed_handles=[${allHandles.join(", ")}]`);
        } else {
          const firstFiveHandles = Array.from(allowedHandles).slice(0, 5);
          console.log(`[AI Ranking] allowed_handles_preview=[${firstFiveHandles.join(", ")}...] (${allowedHandles.size} total)`);
        }
        
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
          .map(item => item.reason || "")
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
      // Defensive check: validate all handles are in allowedHandles before processing
      const allowedHandles = new Set(currentCandidates.map(c => c.handle));
      const allReturnedHandles: string[] = [];
      
      if (!isBundle || !("selected_by_item" in structuredResult)) {
        const singleItemResult = structuredResult as StructuredRankingResult;
        allReturnedHandles.push(...singleItemResult.selected.map(item => item.handle.trim()));
      } else {
        const bundleResult = structuredResult as StructuredBundleResult;
        allReturnedHandles.push(...bundleResult.selected_by_item.map(item => item.handle.trim()));
      }
      
      const invalidHandles = allReturnedHandles.filter(handle => !allowedHandles.has(handle));
      if (invalidHandles.length > 0) {
        for (const invalidHandle of invalidHandles) {
          console.log(`[AI Ranking] invalid_handle_returned=${invalidHandle} (not in allowedHandles)`);
        }
        console.log(`[AI Ranking] allowed_handles_count=${allowedHandles.size}`);
        const firstFiveHandles = Array.from(allowedHandles).slice(0, 5);
        console.log(`[AI Ranking] allowed_handles_preview=[${firstFiveHandles.join(", ")}]`);
        lastError = new Error(`Invalid handles returned: ${invalidHandles.join(", ")}`);
        lastParseFailReason = `Invalid handles returned: ${invalidHandles.join(", ")}`;
        continue; // This will eventually fallback after MAX_RETRIES
      }
      
      // Log allowed handles count
      console.log(`[AI Ranking] allowed_handles_count=${allowedHandles.size}`);
      if (allowedHandles.size <= 20) {
        const allHandles = Array.from(allowedHandles);
        console.log(`[AI Ranking] allowed_handles=[${allHandles.join(", ")}]`);
      } else {
        const firstFiveHandles = Array.from(allowedHandles).slice(0, 5);
        console.log(`[AI Ranking] allowed_handles_preview=[${firstFiveHandles.join(", ")}...] (${allowedHandles.size} total)`);
      }
      
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
          // In minimal schema, evidence is optional - if not present, assume match (trust the AI)
          const hasHardTermMatch = !item.evidence || item.evidence.matchedHardTerms.length === 0 
            ? true // If no evidence, trust the AI's selection
            : item.evidence.matchedHardTerms.some((term: string) => {
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
          .map(item => item.reason || "")
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
      // Use requestBody for logging (built above, matches SDK request)
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


