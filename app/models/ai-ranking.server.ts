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

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 12000; // 12 seconds
const MAX_RETRIES = 1; // Max 1 retry, so at most 2 attempts total
const CACHE_DURATION_HOURS = 36; // Cache for 36 hours (between 24-48 hours)

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

  // Sort candidates
  const sorted = [...candidates].sort((a, b) => {
    // 1) available desc
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    
    // 2) preferenceScore desc (if variantPreferences provided)
    if (variantPreferences && Object.keys(variantPreferences).length > 0) {
      const sa = preferenceScore(a, variantPreferences);
      const sb = preferenceScore(b, variantPreferences);
      if (sa !== sb) return sb - sa;
    }
    
    // 3) price closeness to budget (if we had budget info, but we don't have it here)
    // For now, just use handle as tiebreaker
    return a.handle.localeCompare(b.handle);
  });

  const rankedHandles = sorted.slice(0, resultCount).map(p => p.handle);
  
  return {
    rankedHandles,
    reasoning: "AI ranking unavailable; used deterministic ranking.",
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
 */
async function getCachedRanking(
  cacheKey: string,
  shopId?: string
): Promise<{ rankedHandles: string[]; reasoning: string } | null> {
  if (!shopId) {
    return null; // Can't cache without shopId
  }
  
  try {
    const now = new Date();
    const cached = await prisma.aIRankingCache.findFirst({
      where: {
        cacheKey,
        shopId,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });
    
    if (cached) {
      console.log("[AI Ranking] Cache HIT - using cached result");
      // Parse JSON string (SQLite stores as string, PostgreSQL as Json)
      let rankedHandles: string[] = [];
      try {
        rankedHandles = typeof cached.rankedHandles === "string"
          ? JSON.parse(cached.rankedHandles)
          : (cached.rankedHandles as string[]);
      } catch {
        console.error("[AI Ranking] Error parsing cached rankedHandles");
      }
      return {
        rankedHandles,
        reasoning: cached.reasoning || "Cached AI-ranked products",
      };
    }
    
    console.log("[AI Ranking] Cache MISS - will call OpenAI");
    return null;
  } catch (error) {
    console.error("[AI Ranking] Error checking cache:", error);
    return null; // On error, proceed without cache
  }
}

/**
 * Stores ranking result in cache
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
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_DURATION_HOURS * 60 * 60 * 1000);
    
    // Create product hash for storage
    const productHandles = candidates.map(c => c.handle).sort();
    const productHash = crypto.createHash("sha256")
      .update(productHandles.join(","))
      .digest("hex");
    
    // Upsert cache entry (update if exists, create if not)
    // SQLite stores JSON as string, PostgreSQL as Json type
    const rankedHandlesJson = JSON.stringify(rankedHandles);
    await prisma.aIRankingCache.upsert({
      where: { cacheKey },
      update: {
        rankedHandles: rankedHandlesJson,
        reasoning,
        expiresAt,
      },
      create: {
        cacheKey,
        shopId,
        userIntent: userIntent.substring(0, 1000), // Limit length for storage
        productHash,
        rankedHandles: rankedHandlesJson,
        reasoning: reasoning.substring(0, 2000), // Limit length
        resultCount,
        expiresAt,
      },
    });
    
    console.log("[AI Ranking] Cached result for", CACHE_DURATION_HOURS, "hours");
  } catch (error) {
    console.error("[AI Ranking] Error caching result:", error);
    // Don't throw - caching is best-effort
  }
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
  avoidTerms?: string[]
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

  // Build product list for prompt (limit to 200)
  const productList = candidates.slice(0, 200).map((p, idx) => {
    const sizes = (p.sizes && p.sizes.length > 0) ? p.sizes.join(", ") : "none";
    const colors = (p.colors && p.colors.length > 0) ? p.colors.join(", ") : "none";
    const materials = (p.materials && p.materials.length > 0) ? p.materials.join(", ") : "none";
    const optionValues = p.optionValues ? JSON.stringify(p.optionValues) : "{}";
    
    return `${idx + 1}. Handle: ${p.handle}
   Title: ${p.title}
   Tags: ${p.tags.join(", ") || "none"}
   Type: ${p.productType || "unknown"}
   Vendor: ${p.vendor || "unknown"}
   Price: ${p.price || "unknown"}
   Description: ${(p.description || "").substring(0, 200)}${p.description && p.description.length > 200 ? "..." : ""}
   Available: ${p.available ? "yes" : "no"}
   Sizes: ${sizes}
   Colors: ${colors}
   Materials: ${materials}
   OptionValues: ${optionValues}`;
  }).join("\n\n");

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

  const systemPrompt = `You are a product recommendation assistant for an e-commerce store. Your task is to rank products based on how well they match the shopper's intent.

CRITICAL RULES:
- Return ONLY valid JSON matching the schema
- You MUST use the EXACT handle values from the candidate list (case-sensitive, no modifications)
- Copy handles EXACTLY as shown in the "Handle: ..." field
- Rank products by relevance to user intent (most relevant first)
- Consider: product type, tags, description, price, availability${constraintsText || prefsText !== "Variant option preferences: none" ? ", variant options (sizes/colors/materials/optionValues)" : ""}
- Return exactly ${resultCount} products (or fewer if fewer candidates)
- Do NOT include products that don't match the intent
- Do NOT include PII or personal information in reasoning
- Do NOT modify, truncate, or change the handle values in any way

Output schema (MUST be valid JSON):
{
  "ranked_handles": ["exact-handle-1", "exact-handle-2", ...],
  "reasoning": "Brief explanation of why these products were selected"
}`;

  const userPrompt = `Shopper Intent:
${userIntent || "No specific intent provided"}${constraintsText}

${prefsText}${rulesText}${keywordText}

Candidate Products (${candidates.length} total):
${productList}

IMPORTANT: Copy the handle values EXACTLY as shown above (e.g., if you see "Handle: my-product-handle", use "my-product-handle" exactly).

Rank the top ${resultCount} products that best match the shopper's intent. Return ONLY the JSON object with ranked_handles array (using exact handles) and reasoning string.`;

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
          temperature: 0.3, // Lower temperature for more consistent ranking
          max_tokens: 1000,
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

      // Parse JSON response
      let rankingResult: RankingResult;
      try {
        rankingResult = JSON.parse(content);
      } catch (parseError) {
        console.error("[AI Ranking] Failed to parse JSON response:", parseError);
        console.error("[AI Ranking] Raw content that failed to parse:", content);
        lastError = parseError;
        continue; // Try again if retries remaining
      }

      // Validate response structure
      if (!rankingResult.ranked_handles || !Array.isArray(rankingResult.ranked_handles)) {
        console.error("[AI Ranking] Invalid response structure - missing ranked_handles array");
        lastError = new Error("Invalid response structure");
        continue; // Try again if retries remaining
      }

      // Validate handles exist in candidates
      const candidateHandles = new Set(candidates.map(p => p.handle));
      const candidateHandlesArray = Array.from(candidateHandles);
      
      console.log("[AI Ranking] AI returned", rankingResult.ranked_handles.length, "handles");
      console.log("[AI Ranking] AI handles:", rankingResult.ranked_handles);
      console.log("[AI Ranking] Expected candidate handles:", candidateHandlesArray);
      
      // Try to match handles (case-insensitive, trimmed)
      const validHandles = rankingResult.ranked_handles
        .map(h => {
          if (!h || typeof h !== "string") return null;
          const trimmed = h.trim();
          // Try exact match first
          if (candidateHandles.has(trimmed)) return trimmed;
          // Try case-insensitive match
          const lower = trimmed.toLowerCase();
          for (const candidate of candidateHandlesArray) {
            if (candidate.toLowerCase() === lower) {
              return candidate; // Return the original case
            }
          }
          return null;
        })
        .filter((h): h is string => h !== null);
      
      console.log("[AI Ranking] Matched", validHandles.length, "out of", rankingResult.ranked_handles.length, "handles");
      
      if (validHandles.length === 0) {
        console.error("[AI Ranking] No valid handles in AI response");
        console.error("[AI Ranking] AI returned handles:", JSON.stringify(rankingResult.ranked_handles));
        console.error("[AI Ranking] Expected handles:", JSON.stringify(candidateHandlesArray));
        lastError = new Error("No valid handles in AI response");
        continue; // Try again if retries remaining
      }

      // Limit to resultCount
      const rankedHandles = validHandles.slice(0, resultCount);
      const reasoning = rankingResult.reasoning || "AI-ranked products based on user intent";

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

