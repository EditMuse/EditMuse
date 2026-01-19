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

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? "45000"); // Configurable timeout, default 45 seconds
const MAX_RETRIES = 1; // Max 1 retry, so at most 2 attempts total
const CACHE_DURATION_HOURS = 0; // Cache disabled - always use fresh AI ranking
const MAX_DESCRIPTION_LENGTH = 1000; // Increased from 200 to allow full description analysis

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
  console.log("[AI Ranking] Starting AI ranking with model:", model, "candidates:", candidates.length);

  // Enhance user intent for better AI understanding
  const enhancedIntent = enhanceUserIntent(userIntent);
  console.log("[AI Ranking] Enhanced user intent length:", enhancedIntent.length);

  // Extract hard constraints (with defaults)
  const hardTerms = hardConstraints?.hardTerms || [];
  const hardFacetsRaw = hardConstraints?.hardFacets || {};
  const avoidTermsFromConstraints = hardConstraints?.avoidTerms || [];
  const trustFallback = hardConstraints?.trustFallback || false;
  
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
  const productList = candidates.slice(0, 200).map((p, idx) => {
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
    
    // Use desc1000 if available, truncate to 500 chars (reduced from 1000)
    const descriptionText = (p as any).desc1000 
      ? ((p as any).desc1000.substring(0, 500))
      : (cleanDescription(p.description) || "No description available").substring(0, 500);
    
    // Remove searchText entirely - not needed for AI prompt
    
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

  const systemPrompt = `You are an expert product recommendation assistant for an e-commerce store. Your task is to rank products from a pre-filtered candidate list based on strict matching rules.

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
- Each reason must be 1 sentence maximum
- rejected_candidates array is optional but include up to 20 if helpful for debugging`;

  // Build hard constraints object for prompt
  const hardConstraintsJson = JSON.stringify({
    hardTerms,
    ...(Object.keys(hardFacetsForPrompt).length > 0 ? { hardFacets: hardFacetsForPrompt } : {}),
    avoidTerms: finalAvoidTerms,
    trustFallback,
  }, null, 2);

  const userPrompt = `Shopper Intent:
${enhancedIntent}

Hard Constraints:
${hardConstraintsJson}

${constraintsText ? `Variant Preferences:
${constraintsText}` : ""}

${prefsText && prefsText !== "Variant option preferences: none" ? `${prefsText}${rulesText}` : ""}

${keywordText || ""}

Candidate Products (${candidates.length} total):
${productList}

TASK:
1. For each candidate, check if it satisfies the hard constraints:
   - At least one hardTerm in title/productType/tags/desc1000
   - All hardFacets match (size/color/material in candidate arrays)
   - No avoidTerms in title/tags/desc1000

2. Select exactly ${resultCount} products:
   ${trustFallback ? "- If ${resultCount} exact matches exist, return all as 'exact'" : "- ALL must be 'exact' matches (satisfy all hard constraints)"}
   ${trustFallback ? "- If fewer than ${resultCount} exact matches, fill with 'alternative' matches closest to intent" : "- If fewer than ${resultCount} exact matches exist, return only the exact matches you find"}

3. For each selected item, provide:
   - Exact handle (copy from candidate list)
   - Label: "exact" if all constraints satisfied, "alternative" only if trustFallback=true
   - Score: 0-100 based on match quality
   - Evidence: Which hardTerms matched, which facets matched, which fields were used
   - Reason: 1 sentence explaining the match

4. Optionally include up to 20 rejected candidates with brief "why" explanations.

Return ONLY the JSON object matching the schema - no markdown, no prose outside JSON.`;

  // Attempt AI ranking with retries
  let lastError: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[AI Ranking] Retry attempt ${attempt} of ${MAX_RETRIES}`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2, // Lower temperature (0.2 vs 0.3) for more consistent and focused ranking
          max_tokens: 1500, // Increased to allow more detailed reasoning
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[AI Ranking] OpenAI API error:", response.status, errorText);
        lastError = new Error(`OpenAI API error: ${response.status}`);
        continue; // Try again if retries remaining
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        console.error("[AI Ranking] No content in OpenAI response");
        lastError = new Error("No content in OpenAI response");
        continue; // Try again if retries remaining
      }

      console.log("[AI Ranking] Raw OpenAI response content (first 500 chars):", content.substring(0, 500));

      // Robust JSON extraction - trim whitespace and extract first {...} block
      let jsonContent = content.trim();
      
      // If wrapped in markdown code blocks, extract JSON
      const codeBlockMatch = jsonContent.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (codeBlockMatch) {
        jsonContent = codeBlockMatch[1].trim();
      } else {
        // Extract first {...} JSON block
        const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonContent = jsonMatch[0];
        }
      }

      // Parse JSON response
      let structuredResult: StructuredRankingResult;
      let structuredOk = false;
      let fallbackUsed = false;
      
      try {
        structuredResult = JSON.parse(jsonContent);
        // Validate it's the new structured format
        if (structuredResult.selected && Array.isArray(structuredResult.selected)) {
          structuredOk = true;
        } else {
          // Not the new format, try old format
          fallbackUsed = true;
          throw new Error("Not structured format");
        }
      } catch (parseError) {
        console.error("[AI Ranking] Failed to parse structured JSON response:", parseError);
        console.error("[AI Ranking] Attempted to parse:", jsonContent.substring(0, 500));
        // Fall back to old format parsing
        fallbackUsed = true;
        try {
          const oldFormat: RankingResult = JSON.parse(jsonContent);
          if (oldFormat.ranked_handles && Array.isArray(oldFormat.ranked_handles)) {
            console.log("[AI Ranking] Falling back to old format parsing");
            const candidateHandles = new Set(candidates.map(p => p.handle));
            const validHandles = oldFormat.ranked_handles
              .filter((h): h is string => typeof h === "string" && h.trim().length > 0 && candidateHandles.has(h.trim()))
              .map(h => h.trim())
              .slice(0, resultCount);
            if (validHandles.length > 0) {
              // Debug log for fallback
              console.log("[AI Ranking] structuredOk=", false, "fallbackUsed=", true, "trustFallback=", hardConstraints?.trustFallback ?? null);
              return {
                rankedHandles: validHandles,
                reasoning: oldFormat.reasoning || "AI-ranked products based on user intent",
              };
            }
          }
        } catch (fallbackError) {
          // Both failed, continue to retry
        }
        lastError = parseError;
        continue; // Try again if retries remaining
      }
      
      // Debug log for structured format
      console.log("[AI Ranking] structuredOk=", structuredOk, "fallbackUsed=", fallbackUsed, "trustFallback=", hardConstraints?.trustFallback ?? null);

      // Validate response structure
      if (!structuredResult.selected || !Array.isArray(structuredResult.selected)) {
        console.error("[AI Ranking] Invalid response structure - missing selected array");
        lastError = new Error("Invalid response structure - missing selected array");
        continue; // Try again if retries remaining
      }

      // Validate handles exist in candidates
      const candidateHandles = new Set(candidates.map(p => p.handle));
      const candidateMap = new Map(candidates.map(p => [p.handle, p]));
      
      console.log("[AI Ranking] AI returned", structuredResult.selected.length, "selected items");
      
      // Validate and filter selected items
      const validSelectedItems: SelectedItem[] = [];
      
      for (const item of structuredResult.selected) {
        if (!item.handle || typeof item.handle !== "string") {
          console.warn("[AI Ranking] Skipping item with invalid handle:", item);
          continue;
        }
        
        const handle = item.handle.trim();
        if (!candidateHandles.has(handle)) {
          console.warn("[AI Ranking] Skipping item with handle not in candidates:", handle);
          continue;
        }
        
        // If trustFallback=false, validate constraints
        if (!trustFallback) {
          const candidate = candidateMap.get(handle);
          if (!candidate) continue;
          
          // Check if evidence has matchedHardTerms
          if (!item.evidence || !item.evidence.matchedHardTerms || item.evidence.matchedHardTerms.length === 0) {
            console.warn(`[AI Ranking] Skipping ${handle} - no matchedHardTerms when trustFallback=false`);
            continue;
          }
          
          // Basic validation: check if hardTerm appears in candidate fields
          const candidateText = [
            candidate.title || "",
            candidate.productType || "",
            ...(candidate.tags || []),
            (candidate as any).desc1000 || cleanDescription(candidate.description) || "",
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
      
      console.log("[AI Ranking] Validated", validSelectedItems.length, "out of", structuredResult.selected.length, "selected items");
      
      if (validSelectedItems.length === 0) {
        console.error("[AI Ranking] No valid selected items after validation");
        lastError = new Error("No valid selected items after validation");
        continue; // Try again if retries remaining
      }

      // Extract handles and build reasoning
      const rankedHandles = validSelectedItems
        .slice(0, resultCount)
        .map(item => item.handle.trim());
      
      // Build reasoning from evidence and reasons
      let reasoning: string;
      if (!trustFallback && hardTerms.length > 0) {
        const matchedTerms = [...new Set(validSelectedItems.flatMap(item => item.evidence?.matchedHardTerms || []))];
        const facetParts: string[] = [];
        if (hardFacetsForPrompt.size) facetParts.push(`size: ${hardFacetsForPrompt.size.join(", ")}`);
        if (hardFacetsForPrompt.color) facetParts.push(`color: ${hardFacetsForPrompt.color.join(", ")}`);
        if (hardFacetsForPrompt.material) facetParts.push(`material: ${hardFacetsForPrompt.material.join(", ")}`);
        const facetsText = facetParts.length > 0 ? ` + ${facetParts.join(", ")}` : "";
        reasoning = `Matched: ${matchedTerms.join(", ")}${facetsText}.`;
      } else if (trustFallback && hardTerms.length > 0) {
        reasoning = `No exact matches found for "${hardTerms.join(", ")}"; showing closest alternatives.`;
      } else {
        reasoning = "AI-ranked products based on user intent.";
      }
      
      // Add item reasons (concatenate, keep short)
      const itemReasons = validSelectedItems
        .slice(0, resultCount)
        .map(item => item.reason)
        .filter(Boolean)
        .slice(0, 5); // Limit to first 5 to keep reasoning concise
      
      if (itemReasons.length > 0) {
        reasoning += " " + itemReasons.join(" ");
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
    } catch (error: any) {
      lastError = error;
      if (error.name === "AbortError") {
        console.error("[AI Ranking] Request timeout after", TIMEOUT_MS, "ms", attempt < MAX_RETRIES ? "- will retry" : "- max retries reached");
      } else {
        console.error("[AI Ranking] Error:", error.message || error, attempt < MAX_RETRIES ? "- will retry" : "- max retries reached");
      }
      // Continue to next attempt if retries remaining
      if (attempt < MAX_RETRIES) {
        continue;
      }
    }
  }

  // All attempts failed - return deterministic fallback
  console.log("[AI Ranking] All AI attempts failed, using deterministic fallback");
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


