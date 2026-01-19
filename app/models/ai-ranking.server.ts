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
  rejected_candidates?: RejectedCandidate[];
}

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? "45000"); // Configurable timeout, default 45 seconds
const MAX_RETRIES = 2; // Max 2 retries, so at most 3 attempts total (initial attempt + 2 retries)
const CACHE_DURATION_HOURS = 0; // Cache disabled - always use fresh AI ranking
const MAX_DESCRIPTION_LENGTH = 1000; // Increased from 200 to allow full description analysis

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
  
  // 4) Attempt JSON.parse
  try {
    const parsed = JSON.parse(jsonSlice);
    return parsed as StructuredRankingResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new JSONParseError(`JSON.parse failed: ${errorMessage}`, content);
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
  candidateHandles: Set<string>
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
    
    // If trustFallback=false, require at least one matchedHardTerm
    if (!trustFallback && item.evidence.matchedHardTerms.length === 0) {
      return { valid: false, reason: "No matchedHardTerms when trustFallback=false" };
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
  variantPreferences?: Record<string, string>
): { rankedHandles: string[]; reasoning: string } {
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

  const rankedHandles = sorted.slice(0, resultCount).map(p => p.handle);
  
  return {
    rankedHandles,
    reasoning: "AI ranking unavailable; selected products based on availability, preferences, and product information quality.",
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
): Promise<{ rankedHandles: string[]; reasoning: string } | null> {
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
  rankedHandles: string[],
  reasoning: string,
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
  hardConstraints?: HardConstraints
): Promise<{ rankedHandles: string[]; reasoning: string }> {
  if (candidates.length === 0) {
    console.log("[AI Ranking] No candidates to rank - using deterministic fallback");
    return deterministicRanking(candidates, resultCount, variantPreferences);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[AI Ranking] OPENAI_API_KEY not set - using deterministic fallback");
    return deterministicRanking(candidates, resultCount, variantPreferences);
  }

  if (!isAIRankingEnabled()) {
    console.log("[AI Ranking] Feature disabled via FEATURE_AI_RANKING - using deterministic fallback");
    return deterministicRanking(candidates, resultCount, variantPreferences);
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
  const hardFacetsRaw = hardConstraints?.hardFacets || {};
  const avoidTermsFromConstraints = hardConstraints?.avoidTerms || [];
  const trustFallback = hardConstraints?.trustFallback || false;
  const isBundle = hardConstraints?.isBundle || false;
  const bundleItems = hardConstraints?.bundleItems || [];
  
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
  
  // Build product list for prompt (limit to 200)
  // Reduced payload: truncate descriptions, cap arrays, remove searchText, cap optionValues
  // This function can be called with shortened=true to reduce payload for retries
  function buildProductList(shortened: boolean = false, compressed: boolean = false): string {
    if (compressed) {
      // Compressed mode: only handle, title, productType, tags, available, price, searchText (truncated to 200 chars)
      return candidates.slice(0, 200).map((p, idx) => {
        const tags = (p.tags && p.tags.length > 0) ? p.tags.slice(0, 20).join(", ") : "none";
        const searchText = (p as any).searchText ? ((p as any).searchText.substring(0, 200)) : "";
        
        return `${idx + 1}. handle: ${p.handle}
   title: ${p.title}
   productType: ${p.productType || "unknown"}
   tags: ${tags}
   available: ${p.available ? "yes" : "no"}
   price: ${p.price || "unknown"}
   searchText: ${searchText}`;
      }).join("\n\n");
    }
    
    const descLimit = shortened ? 400 : 500;
    
    return candidates.slice(0, 200).map((p, idx) => {
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
      
      // Use desc1000 if available, truncate based on shortened flag
      const descriptionText = (p as any).desc1000 
        ? ((p as any).desc1000.substring(0, descLimit))
        : (cleanDescription(p.description) || "No description available").substring(0, descLimit);
      
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
  
  // Log payload size
  const productListJsonChars = productList.length;
  console.log("[AI Ranking] productListJsonChars=", productListJsonChars);

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
  ],
  "selected": [],
  "rejected_candidates": [
    { "handle": "some-handle", "why": "Does not match hardTerm 'suit'" }
  ]
}

REQUIREMENTS:
- "selected_by_item" array MUST contain at least 1 selection per itemIndex (exactly 1 primary per item)
- After primaries, add alternates to reach ${resultCount} total, distributing evenly across items
- All handles must exist in their itemIndex's candidate group (copy exactly as shown)
- No duplicate handles
- evidence.matchedHardTerms must not be empty when trustFallback=false
- evidence.fieldsUsed must include at least one of: ["title", "productType", "tags", "desc1000"]
- Each reason must be 1 sentence maximum and written in natural, conversational language
- Write reasons as if explaining to a customer why this product matches their needs
- rejected_candidates array is optional but include up to 20 if helpful for debugging`
    : `You are an expert product recommendation assistant for an e-commerce store. Your task is to rank products from a pre-filtered candidate list based on strict matching rules.

CRITICAL OUTPUT FORMAT:
- Return ONLY valid JSON (no markdown, no prose, no explanations outside JSON)
- Output must be parseable JSON.parse() directly
- Use the exact schema provided below - no deviations

HARD CONSTRAINT RULES:
${trustFallback ? `- trustFallback=true: You may show alternatives when exact matches are insufficient, but MUST label each as "exact" or "alternative"` : `- trustFallback=false: EVERY returned product MUST satisfy ALL of the following:
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
  ],
  "rejected_candidates": [
    { "handle": "some-handle", "why": "Does not match hardTerm 'suit'" }
  ]
}

REQUIREMENTS:
- "selected" array MUST contain exactly ${resultCount} items
- All handles must exist in the candidate list (copy exactly as shown)
- No duplicate handles
- evidence.matchedHardTerms must not be empty when trustFallback=false
- evidence.fieldsUsed must include at least one of: ["title", "productType", "tags", "desc1000"]
- Each reason must be 1 sentence maximum and written in natural, conversational language
- Write reasons as if explaining to a customer why this product matches their needs (e.g., "This navy suit perfectly matches your formal wear requirements" not "Product matches hardTerm 'suit' and color 'navy'")
- rejected_candidates array is optional but include up to 20 if helpful for debugging`;

  // Build hard constraints object for prompt
  const hardConstraintsJson = JSON.stringify({
    hardTerms,
    ...(Object.keys(hardFacetsForPrompt).length > 0 ? { hardFacets: hardFacetsForPrompt } : {}),
    avoidTerms: finalAvoidTerms,
    trustFallback,
  }, null, 2);

  // Build user prompt (can be shortened or compressed for retries)
  function buildUserPrompt(shortened: boolean = false, compressed: boolean = false): string {
    if (isBundle && bundleItems.length >= 2) {
      // BUNDLE MODE: Group candidates by itemIndex
      const candidatesByItem = new Map<number, ProductCandidate[]>();
      for (const c of candidates) {
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
          const descText = (p as any).desc1000 
            ? ((p as any).desc1000.substring(0, 500))
            : (cleanDescription(p.description) || "No description available").substring(0, 500);
          
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
   - Reason: Write a natural, conversational 1-sentence explanation

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
   - Reason: Write a natural, conversational 1-sentence explanation as if speaking to the customer (e.g., "This navy suit is perfect for formal occasions" rather than "Matches suit category and navy color")

4. Optionally include up to 20 rejected candidates with brief "why" explanations.

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
    
    const rejectedCandidateSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          handle: { type: "string" },
          why: { type: "string" },
        },
        required: ["handle", "why"],
        additionalProperties: false,
      },
    };
    
    if (isBundle) {
      // Bundle schema: requires selected_by_item, selected is optional fallback
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
          selected: {
            type: "array",
            items: selectedItemSchema,
          },
          rejected_candidates: rejectedCandidateSchema,
        },
        required: ["trustFallback", "selected_by_item", "selected", "rejected_candidates"],
        additionalProperties: false,
      };
    } else {
      // Single-item schema
      return {
        type: "object",
        properties: {
          trustFallback: { type: "boolean" },
          selected: {
            type: "array",
            items: selectedItemSchema,
          },
          rejected_candidates: rejectedCandidateSchema,
        },
        required: ["trustFallback", "selected", "rejected_candidates"],
        additionalProperties: false,
      };
    }
  }

  // Attempt AI ranking with retries
  let lastError: any = null;
  let lastParseFailReason: string | undefined = undefined;
  const candidateHandles = new Set(candidates.map(p => p.handle));
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const isRetry = attempt > 0;
      const useCompressedPrompt = isRetry && lastParseFailReason !== undefined;
      
      if (isRetry) {
        console.log(`[AI Ranking] Retry attempt ${attempt} of ${MAX_RETRIES}${useCompressedPrompt ? " (using compressed prompt)" : ""}`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      // Build request body with JSON mode/schema if supported
      const requestBody: any = {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: useCompressedPrompt ? buildUserPrompt(false, true) : userPrompt },
        ],
        temperature: 0, // Set to 0 for more deterministic output
        max_tokens: 1500,
      };
      
      // Add JSON schema if supported, otherwise JSON object mode
      if (supportsJsonSchema) {
        requestBody.response_format = {
          type: "json_schema",
          json_schema: {
            name: isBundle ? "structured_bundle_result" : "structured_ranking_result",
            strict: true,
            schema: buildJsonSchema(isBundle),
          },
        };
      } else if (supportsJsonMode) {
        requestBody.response_format = { type: "json_object" };
      }

      const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify(requestBody),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[AI Ranking] OpenAI API error:", response.status, errorText);
        lastError = new Error(`OpenAI API error: ${response.status}`);
        lastParseFailReason = `API error: ${response.status}`;
        continue; // Try again if retries remaining
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        console.error("[AI Ranking] No content in OpenAI response");
        lastError = new Error("No content in OpenAI response");
        lastParseFailReason = "No content in response";
        continue; // Try again if retries remaining
      }

      console.log("[AI Ranking] Raw OpenAI response content (first 500 chars):", content.substring(0, 500));

      // Parse JSON response using improved parser
      let structuredResult: StructuredRankingResult | StructuredBundleResult;
      
      try {
        structuredResult = parseStructuredRanking(content);
      } catch (err) {
        if (err instanceof JSONParseError) {
          lastError = err;
          lastParseFailReason = err.message;
          console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
          // This typed error triggers compressed retry
          continue; // Try again if retries remaining
        } else {
          // Unexpected error type
          lastError = err;
          lastParseFailReason = `Unexpected parsing error: ${err instanceof Error ? err.message : String(err)}`;
          console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
          continue; // Try again if retries remaining
        }
      }

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
        
        // Validate bundle response
        const itemIndices = new Set(bundleResult.selected_by_item.map(item => item.itemIndex));
        const expectedIndices = new Set(bundleItems.map((_, idx) => idx));
        const missingIndices = Array.from(expectedIndices).filter(idx => !itemIndices.has(idx));
        
        if (missingIndices.length > 0 && !bundleResult.trustFallback) {
          lastError = new Error(`Missing selections for itemIndices: ${missingIndices.join(", ")}`);
          lastParseFailReason = `Missing selections for itemIndices: ${missingIndices.join(", ")}`;
          console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
          continue;
        }
        
        // Validate handles belong to correct item pools
        const invalidHandles: string[] = [];
        for (const item of bundleResult.selected_by_item) {
          const itemPool = candidatesByItem.get(item.itemIndex);
          if (!itemPool || !itemPool.has(item.handle)) {
            if (!bundleResult.trustFallback) {
              invalidHandles.push(`${item.handle} (itemIndex ${item.itemIndex})`);
            }
          }
        }
        
        if (invalidHandles.length > 0 && !bundleResult.trustFallback) {
          lastError = new Error(`Handles not in correct item pools: ${invalidHandles.join(", ")}`);
          lastParseFailReason = `Handles not in correct item pools: ${invalidHandles.join(", ")}`;
          console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
          continue;
        }
        
        // Successfully validated bundle response
        console.log("[AI Bundle] structuredOk=true, itemCount=", bundleResult.selected_by_item.length, 
          "returnedPerItem=", Array.from(itemIndices).map(idx => {
            const count = bundleResult.selected_by_item.filter(item => item.itemIndex === idx).length;
            return `item${idx}:${count}`;
          }).join(","),
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
        
        return {
          rankedHandles,
          reasoning,
        };
      }

      // Validate against expected schema (single-item mode)
      const validation = validateRankingSchema(structuredResult as StructuredRankingResult, trustFallback, candidateHandles);
      
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
              console.log("[AI Ranking] Successfully parsed old format, returning result");
              return {
                rankedHandles: validHandles,
                reasoning: oldFormat.reasoning || "AI-ranked products based on user intent",
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
          
          const hasHardTermMatch = item.evidence.matchedHardTerms.some((term: string) =>
            candidateText.includes(term.toLowerCase())
          );
          
          if (!hasHardTermMatch && hardTerms.length > 0) {
            console.warn(`[AI Ranking] Skipping ${handle} - claimed hardTerm match not found in candidate`);
            continue;
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
          lastError = new Error("No valid selected items after runtime validation");
          lastParseFailReason = "No valid items after runtime validation";
          continue; // Try again if retries remaining
        }

        // Extract handles and build reasoning
        const rankedHandles = validSelectedItems
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

        console.log("[AI Ranking] Successfully ranked", rankedHandles.length, "products");
        
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
            rankedHandles,
            reasoning,
            resultCount
          ).catch(err => {
            console.error("[AI Ranking] Error caching result (non-blocking):", err);
          });
        }
        
        // NOTE: Billing is handled once per session after final results are computed.
        // rankProductsWithAI should not create UsageEvents or set chargedAt/creditsBurned.
        // This allows multi-pass AI ranking (top-up passes) without duplicate charges.
        
        return {
          rankedHandles,
          reasoning,
        };
      }
    } catch (error: any) {
      lastError = error;
      if (error.name === "AbortError") {
        console.error("[AI Ranking] Request timeout after", TIMEOUT_MS, "ms", attempt < MAX_RETRIES ? "- will retry" : "- max retries reached");
        lastParseFailReason = `Request timeout after ${TIMEOUT_MS}ms`;
      } else {
        console.error("[AI Ranking] Error:", error.message || error, attempt < MAX_RETRIES ? "- will retry" : "- max retries reached");
        lastParseFailReason = `Exception: ${error.message || String(error)}`;
      }
      console.log("[AI Ranking] parse_fail_reason=", lastParseFailReason);
      // Continue to next attempt if retries remaining
      if (attempt < MAX_RETRIES) {
        continue;
      }
    }
  }

  // All attempts failed - return deterministic fallback (structured result, not throwing)
  const failReason = lastParseFailReason || (lastError instanceof Error ? lastError.message : String(lastError || "Unknown error"));
  console.log("[AI Ranking] All AI attempts failed, using deterministic fallback");
  console.log("[AI Ranking] parse_fail_reason=", failReason);
  
  // Return structured fallback result instead of throwing
  return deterministicRanking(candidates, resultCount, variantPreferences);
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


