import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";
import { createConciergeSession, saveConciergeResult, addConciergeMessage } from "~/models/concierge.server";
import { getAccessTokenForShop, fetchShopifyProducts, fetchShopifyProductDescriptionsByHandles, fetchShopifyProductsBySearchQuery } from "~/shopify-admin.server";
import { rankProductsWithAI, fallbackRanking } from "~/models/ai-ranking.server";
import { parseIntentWithLLM } from "~/models/intent-parsing.server";
import { ConciergeSessionStatus, ConciergeRole } from "@prisma/client";
import { trackUsageEvent, chargeConciergeSessionOnce, getEntitlements } from "~/models/billing.server";
import { createOverageUsageCharge } from "~/models/shopify-billing.server";
import { withProxyLogging } from "~/utils/proxy-logging.server";
import { ensureResultDiversity, generateEmptyResultSuggestions } from "~/models/result-quality.server";
import {
  normalizeText,
  tokenize,
  cleanDescription,
  buildSearchText,
  bm25Score,
  calculateIDF,
  expandQueryTokens,
  expandTokenMorphology,
} from "~/utils/text-indexing.server";

type UsageEventType = "SESSION_STARTED" | "AI_RANKING_EXECUTED";

/**
 * Compute credits for delivered result count
 * Tiered billing: 1-8 = 1 credit, 9-12 = 1.5 credits, 13-16 = 2 credits
 * For values > 16, clamp to 2 credits (extend explicitly if needed)
 */
function creditsForDeliveredCount(n: number): number {
  if (n <= 0) return 0;
  if (n <= 8) return 1;
  if (n <= 12) return 1.5;
  return 2; // 13-16 (clamp for now, extend if >16 supported)
}

const PRODUCT_POOL_LIMIT_FIRST = 200; // First fetch: 200 products
const PRODUCT_POOL_LIMIT_MAX = 500;    // Maximum total products (if second fetch needed)
// CANDIDATE_WINDOW_SIZE is now dynamic based on entitlements (calculated per request)
const MAX_AI_PASSES = 3;              // first pass + up to 2 top-up passes
const MIN_CANDIDATES_FOR_AI = 50;     // enough variety for AI
const MIN_CANDIDATES_FOR_DELIVERY = 16; // ensures top-up has room (>=2x 8-pack)

type VariantConstraints = {
  size: string | null;
  color: string | null;
  material: string | null;
  allowValues?: Record<string, string[]>; // OR allow-list: attribute -> array of allowed values (case-normalized)
};

function pickString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Extract searchable text from product candidate (industry-agnostic)
 * Combines common catalog fields: title, handle, productType, tags, vendor, description snippet
 * Uses cleanDescription to strip HTML and normalize
 */
/**
 * Normalize a group key by removing sale/clearance tokens and generic terms
 * (Legacy function - kept for backward compatibility with assignGroupKey)
 */
function normalizeGroupKey(key: string): string {
  if (!key || typeof key !== "string") return "unknown";
  
  // Lowercase, trim, collapse whitespace
  let normalized = key.trim().toLowerCase().replace(/\s+/g, " ");
  
  // Remove sale/clearance tokens
  const removeTokens = ["sale", "clearance", "deal", "discount", "promo", "offer", "new", "latest", "trending"];
  const tokens = normalized.split(/\s+/);
  const filtered = tokens.filter(t => !removeTokens.includes(t));
  
  normalized = filtered.join(" ").trim();
  
  // If empty after removal, return "unknown"
  if (normalized.length === 0) {
    return "unknown";
  }
  
  return normalized;
}

/**
 * Canonicalize a group key for merging duplicates (industry-agnostic)
 * Handles singular/plural, punctuation, capitalization, whitespace variants
 */
function canonicalizeGroupKey(rawKey: string): string {
  if (!rawKey || typeof rawKey !== "string") return "unknown";
  
  // Step 1: lowercase, trim
  let canonical = rawKey.trim().toLowerCase();
  
  // Step 2: replace punctuation/separators with space, then collapse whitespace
  canonical = canonical.replace(/[-_/.,'"]/g, " ").replace(/\s+/g, " ").trim();
  
  if (canonical.length === 0) return "unknown";
  
  // Step 3: Split into tokens
  const tokens = canonical.split(/\s+/).filter(t => t.length > 0);
  
  // Step 4: Remove leading/trailing stop tokens (the, and, of) if standalone
  const stopTokens = new Set(["the", "and", "of"]);
  while (tokens.length > 0 && stopTokens.has(tokens[0])) {
    tokens.shift();
  }
  while (tokens.length > 0 && stopTokens.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  
  if (tokens.length === 0) return "unknown";
  
  // Step 5: Singularize tokens (conservative English)
  const singularized = tokens.map(token => {
    // Do not singularize short tokens or tokens with digits
    if (token.length <= 3 || /\d/.test(token)) {
      return token;
    }
    
    // Conservative singularization rules
    if (token.endsWith("ies") && token.length > 4) {
      return token.slice(0, -3) + "y";
    } else if (token.endsWith("sses") || token.endsWith("shes") || token.endsWith("ches") || token.endsWith("xes") || token.endsWith("zes")) {
      return token.slice(0, -2);
    } else if (token.endsWith("s") && !token.endsWith("ss") && token.length > 1) {
      return token.slice(0, -1);
    }
    
    return token;
  });
  
  // Step 6: Remove duplicate tokens (keep order)
  const uniqueTokens: string[] = [];
  const seen = new Set<string>();
  for (const token of singularized) {
    if (!seen.has(token)) {
      uniqueTokens.push(token);
      seen.add(token);
    }
  }
  
  if (uniqueTokens.length === 0) return "unknown";
  
  return uniqueTokens.join(" ");
}

/**
 * Derive a coarse family key from a product (industry-agnostic)
 * Uses productType/category/collections/title/vendor with generic stopword removal
 */
function deriveFamilyKey(candidate: any): { key: string; source: "productType" | "category" | "title" | "vendor" | "unknown" } {
  // Base: productType > category > collections[0] > vendor > title
  let base = "";
  let source: "productType" | "category" | "title" | "vendor" | "unknown" = "unknown";
  
  if (candidate.productType && typeof candidate.productType === "string") {
    base = candidate.productType;
    source = "productType";
  } else if (candidate.product_type && typeof candidate.product_type === "string") {
    base = candidate.product_type;
    source = "productType";
  } else if (candidate.category && typeof candidate.category === "string") {
    base = candidate.category;
    source = "category";
  } else if (candidate.collections && Array.isArray(candidate.collections) && candidate.collections.length > 0) {
    const firstColl = candidate.collections[0];
    base = typeof firstColl === "string" ? firstColl : (firstColl.title || firstColl.handle || "");
    source = "category";
  } else if (candidate.vendor && typeof candidate.vendor === "string") {
    base = candidate.vendor;
    source = "vendor";
  } else if (candidate.title && typeof candidate.title === "string") {
    base = candidate.title;
    source = "title";
  }
  
  if (!base || base.trim().length === 0) {
    return { key: "unknown", source: "unknown" };
  }
  
  // Normalize: lowercase, replace non-alphanum with space, collapse whitespace
  let normalized = base.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  
  // Generic stopwords (NOT category nouns - industry-agnostic)
  const stopwords = new Set([
    "new", "sale", "best", "top", "premium", "classic", "basic", "limited", "edition", "bundle", "set", "pack",
    "mens", "men", "women", "womens", "kids", "child", "unisex",
    "small", "medium", "large", "xl", "xxl", "xxxl", "one", "size",
    "and", "or", "for", "with", "without", "the", "a", "an", "of",
    "cotton", "satin", "silk", "poly", "polyester", "linen", "leather", "wool", "denim",
    "red", "blue", "black", "white", "green", "yellow", "pink", "grey", "gray", "brown", "beige", "navy",
    "print", "printed", "plain", "striped", "floral", "pattern", "patterns"
  ]);
  
  // Split into tokens, filter stopwords, numbers, and short tokens
  const tokens = normalized.split(/\s+/)
    .filter(t => {
      const cleaned = t.trim();
      return cleaned.length > 2 && 
             !stopwords.has(cleaned) && 
             !/^\d+$/.test(cleaned); // Drop pure numbers
    });
  
  if (tokens.length === 0) {
    return { key: "unknown", source: "unknown" };
  }
  
  // Family key selection (generic heuristic):
  // Prefer last token, else prefer longest token, else first token
  let familyKey = tokens[tokens.length - 1]; // Last token
  
  // If last token is too short or common, try longest
  if (familyKey.length < 4) {
    const longest = tokens.reduce((a, b) => a.length > b.length ? a : b);
    if (longest.length >= 4) {
      familyKey = longest;
    }
  }
  
  return { key: familyKey, source };
}

/**
 * Assign a group key to a product (industry-agnostic, coarse grouping)
 * Strict priority: productType > collection > vendor > "unknown"
 * DO NOT derive from title/tags noun phrases
 */
function assignGroupKey(candidate: any): { key: string; source: "productType" | "collection" | "vendor" | "unknown" } {
  // Priority A: normalized product.productType if present and not generic
  if (candidate.productType && typeof candidate.productType === "string") {
    const type = candidate.productType.trim();
    if (type.length > 0 && type !== "null" && type !== "undefined") {
      const normalized = normalizeGroupKey(type);
      const genericTypes = ["", "default", "product", "item", "unknown"];
      if (normalized !== "unknown" && !genericTypes.includes(normalized)) {
        return { key: normalized, source: "productType" };
      }
    }
  }
  
  // Priority B: primary collection handle/title if available (first non-sale/non-clearance collection)
  // Note: Collections may not be in candidate structure - check if available
  if (candidate.collections && Array.isArray(candidate.collections) && candidate.collections.length > 0) {
    for (const collection of candidate.collections) {
      const collHandle = typeof collection === "string" ? collection : (collection.handle || collection.title || "");
      if (collHandle && typeof collHandle === "string") {
        const normalized = normalizeGroupKey(collHandle);
        if (normalized !== "unknown") {
          return { key: normalized, source: "collection" };
        }
      }
    }
  }
  
  // Priority C: normalized vendor if it looks like a category (usually it won't, but keep as fallback)
  if (candidate.vendor && typeof candidate.vendor === "string") {
    const vendor = candidate.vendor.trim();
    if (vendor.length > 0 && vendor !== "null" && vendor !== "undefined") {
      const normalized = normalizeGroupKey(vendor);
      if (normalized !== "unknown") {
        return { key: normalized, source: "vendor" };
      }
    }
  }
  
  // Priority D: fallback "unknown"
  return { key: "unknown", source: "unknown" };
}

/**
 * Unified normalize function: used everywhere for consistency
 * lowercasing, trimming, collapsing whitespace, converting hyphens/underscores to spaces, removing duplicate punctuation
 */
function unifiedNormalize(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  
  return text
    .toLowerCase()
    .trim()
    // Convert hyphens and underscores to spaces
    .replace(/[-_]/g, " ")
    // Remove duplicate punctuation (keep single instance)
    .replace(/[.,;:!?]{2,}/g, (match) => match[0])
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

function extractSearchText(candidate: any, indexMetafields?: Array<{ namespace: string; key: string }> | null): string {
  const parts: string[] = [];
  
  // Title
  if (candidate.title && typeof candidate.title === "string") {
    parts.push(candidate.title);
  }
  
  // Handle (CRITICAL: often contains product type)
  if (candidate.handle && typeof candidate.handle === "string") {
    parts.push(candidate.handle);
  }
  
  // ProductType (handles both productType and product_type)
  const productType = candidate.productType || candidate.product_type;
  if (productType && typeof productType === "string") {
    parts.push(productType);
  }
  
  // ProductCategory/Taxonomy (if available from Shopify)
  if (candidate.productCategory && typeof candidate.productCategory === "string") {
    parts.push(candidate.productCategory);
  }
  if (candidate.taxonomy && typeof candidate.taxonomy === "string") {
    parts.push(candidate.taxonomy);
  }
  
  // Collections (if available from Shopify GraphQL)
  if (candidate.collections && Array.isArray(candidate.collections)) {
    for (const coll of candidate.collections) {
      if (typeof coll === "string") {
        parts.push(coll);
      } else if (coll && typeof coll === "object") {
        if (coll.title && typeof coll.title === "string") {
          parts.push(coll.title);
        }
        if (coll.handle && typeof coll.handle === "string") {
          parts.push(coll.handle);
        }
      }
    }
  }
  
  // Tags (array or string)
  if (Array.isArray(candidate.tags)) {
    parts.push(...candidate.tags.filter((t: any) => typeof t === "string"));
  } else if (candidate.tags && typeof candidate.tags === "string") {
    parts.push(candidate.tags);
  }
  
  // Vendor (optional)
  if (candidate.vendor && typeof candidate.vendor === "string") {
    parts.push(candidate.vendor);
  }
  
  // Variant titles and SKUs (if available from Shopify GraphQL)
  if (candidate.variants && Array.isArray(candidate.variants)) {
    for (const variant of candidate.variants) {
      if (variant && typeof variant === "object") {
        if (variant.title && typeof variant.title === "string") {
          parts.push(variant.title);
        }
        if (variant.sku && typeof variant.sku === "string") {
          parts.push(variant.sku);
        }
      }
    }
  }
  
  // Option values (all option names and values)
  if (candidate.optionValues && typeof candidate.optionValues === "object") {
    for (const [key, values] of Object.entries(candidate.optionValues)) {
      if (key && typeof key === "string") {
        parts.push(key); // Option name (e.g., "Size", "Color")
      }
      if (Array.isArray(values)) {
        parts.push(...values.filter((v: any) => typeof v === "string"));
      } else if (values && typeof values === "string") {
        parts.push(values);
      }
    }
  }
  
  // Sizes, colors, materials (if available separately)
  if (Array.isArray(candidate.sizes)) {
    parts.push(...candidate.sizes.filter((s: any) => typeof s === "string"));
  }
  if (Array.isArray(candidate.colors)) {
    parts.push(...candidate.colors.filter((c: any) => typeof c === "string"));
  }
  if (Array.isArray(candidate.materials)) {
    parts.push(...candidate.materials.filter((m: any) => typeof m === "string"));
  }
  
  // Metafields (if configured in Experience and available)
  if (indexMetafields && Array.isArray(indexMetafields) && candidate.metafields) {
    for (const metafieldConfig of indexMetafields) {
      if (candidate.metafields[metafieldConfig.namespace] && 
          candidate.metafields[metafieldConfig.namespace][metafieldConfig.key]) {
        const value = candidate.metafields[metafieldConfig.namespace][metafieldConfig.key];
        if (typeof value === "string") {
          parts.push(value);
        } else if (typeof value === "object" && value !== null) {
          // Handle JSON metafields
          try {
            parts.push(JSON.stringify(value));
          } catch (e) {
            // Skip if not serializable
          }
        }
      }
    }
  }
  
  // Description snippet (use existing cleanDescription if available, or extract snippet)
  let descText = "";
  if (candidate.description) {
    descText = cleanDescription(candidate.description);
  } else if (candidate.descPlain) {
    descText = candidate.descPlain;
  } else if (candidate.desc1000) {
    descText = cleanDescription(candidate.desc1000);
  }
  
  // Truncate description to 400 chars (snippet)
  if (descText.length > 400) {
    descText = descText.substring(0, 400);
  }
  if (descText) {
    parts.push(descText);
  }
  
  // Join and normalize using unified normalize
  return unifiedNormalize(parts.join(" "));
}

/**
 * Check if product matches hard facet constraints (size/color/material)
 * Industry-agnostic: checks variant availability and option values
 */
function productMatchesHardFacets(
  product: any,
  hardFacets: { size: string | null; color: string | null; material: string | null },
  knownOptionNames: string[],
  requireAvailable: boolean = false // Don't require availability by default - let caller decide
): boolean {
  // Check variant availability only if required (caller can control this)
  if (requireAvailable) {
  const hasAvailableVariant = product.available === true || 
    (product.variants && Array.isArray(product.variants) && product.variants.some((v: any) => 
      v.available === true || v.availableForSale === true
    ));
  
  if (!hasAvailableVariant) {
    return false;
    }
  }
  
  // Normalize option names (case-insensitive)
  const sizeKey = knownOptionNames.find(n => n.toLowerCase() === "size") ?? null;
  const colorKey = knownOptionNames.find(n => ["color","colour","shade"].includes(n.toLowerCase())) ?? null;
  const materialKey = knownOptionNames.find(n => ["material","fabric"].includes(n.toLowerCase())) ?? null;
  
  // Helper to normalize option values for comparison
  const normalizeValue = (val: string): string => {
    return val.toLowerCase().trim();
  };
  
  // Helper to check if a value matches (case-insensitive, with common aliases)
  const valueMatches = (productValue: string | null | undefined, constraintValue: string | null): boolean => {
    if (!constraintValue) return true; // No constraint means match
    if (!productValue) return false; // Constraint exists but product doesn't have it
    
    const normalizedProduct = normalizeValue(productValue);
    const normalizedConstraint = normalizeValue(constraintValue);
    
    // Exact match
    if (normalizedProduct === normalizedConstraint) return true;
    
    // Common size aliases (industry-agnostic: works for clothing, but also other products with size)
    const sizeAliases: Record<string, string[]> = {
      "s": ["small", "s"],
      "m": ["medium", "m"],
      "l": ["large", "l"],
      "xl": ["extra large", "x-large", "xl"],
      "xxl": ["extra extra large", "xx-large", "xxl"],
    };
    
    // Check aliases for size
    if (sizeKey && normalizedConstraint.length <= 3) {
      const aliases = sizeAliases[normalizedConstraint] || [];
      if (aliases.some(alias => normalizeValue(alias) === normalizedProduct)) return true;
    }
    
    // Partial match (e.g., "Medium" contains "M")
    if (normalizedProduct.includes(normalizedConstraint) || normalizedConstraint.includes(normalizedProduct)) {
      return true;
    }
    
    return false;
  };
  
  // Check size constraint
  if (hardFacets.size && sizeKey) {
    const productSizes = product.sizes || [];
    const hasSizeMatch = productSizes.some((s: string) => valueMatches(s, hardFacets.size));
    if (!hasSizeMatch) return false;
  }
  
  // Check color constraint
  if (hardFacets.color && colorKey) {
    const productColors = product.colors || [];
    const hasColorMatch = productColors.some((c: string) => valueMatches(c, hardFacets.color));
    if (!hasColorMatch) return false;
  }
  
  // Check material constraint
  if (hardFacets.material && materialKey) {
    const productMaterials = product.materials || [];
    const hasMaterialMatch = productMaterials.some((m: string) => valueMatches(m, hardFacets.material));
    if (!hasMaterialMatch) return false;
  }
  
  return true;
}

/**
 * Token-based slot scoring: score how well a product matches a slot descriptor
 * Industry-agnostic: uses token overlap across title, handle, productType, tags, vendor, description
 */
function scoreProductForSlot(
  product: any,
  slotDescriptor: string,
  stopwords: Set<string> = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by"])
): number {
  // Normalize and tokenize slot descriptor
  const normalizeToken = (text: string): string => {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, " ") // Replace punctuation with space
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();
  };
  
  const tokenize = (text: string): string[] => {
    return normalizeToken(text)
      .split(/\s+/)
      .filter(token => token.length > 0 && !stopwords.has(token));
  };
  
  const slotTokens = new Set(tokenize(slotDescriptor));
  if (slotTokens.size === 0) return 0;
  
  // Build product text from multiple fields
  const productText = extractSearchText(product);
  const productTokens = new Set(tokenize(productText));
  
  // Calculate token overlap score
  let matchCount = 0;
  for (const token of slotTokens) {
    if (productTokens.has(token)) {
      matchCount++;
    }
  }
  
  // Score = percentage of slot tokens found in product
  const score = matchCount / slotTokens.size;
  
  // Bonus for exact phrase match (if slot descriptor appears as phrase in product text)
  const normalizedSlot = normalizeToken(slotDescriptor);
  const normalizedProduct = normalizeToken(productText);
  if (normalizedProduct.includes(normalizedSlot)) {
    return Math.min(1.0, score + 0.3); // Cap at 1.0
  }
  
  return score;
}

/**
 * Assign products to slots using token-based scoring
 * Returns Map<slotIndex, Array<{product, score}>>
 */
function assignProductsToSlots(
  products: any[],
  slotDescriptors: string[],
  minScoreThreshold: number = 0.1
): Map<number, Array<{ product: any; score: number }>> {
  const slotAssignments = new Map<number, Array<{ product: any; score: number }>>();
  
  // Initialize slots
  for (let i = 0; i < slotDescriptors.length; i++) {
    slotAssignments.set(i, []);
  }
  
  // Score each product against each slot
  for (const product of products) {
    let bestSlot = -1;
    let bestScore = 0;
    
    for (let slotIdx = 0; slotIdx < slotDescriptors.length; slotIdx++) {
      const score = scoreProductForSlot(product, slotDescriptors[slotIdx]);
      if (score > bestScore && score >= minScoreThreshold) {
        bestScore = score;
        bestSlot = slotIdx;
      }
    }
    
    // Assign to best slot if score meets threshold
    if (bestSlot >= 0) {
      slotAssignments.get(bestSlot)!.push({ product, score: bestScore });
    }
  }
  
  // Sort each slot by score (descending)
  for (const [slotIdx, assignments] of slotAssignments.entries()) {
    assignments.sort((a, b) => b.score - a.score);
  }
  
  return slotAssignments;
}

/**
 * Get non-facet hard terms (excludes color/size/material from hardTerms)
 * Industry-agnostic: only filters out terms that match facets exactly (case-insensitive)
 */
function getNonFacetHardTerms(
  hardTerms: string[],
  facets: { size: string | null; color: string | null; material: string | null }
): string[] {
  const facetValues: string[] = [];
  if (facets.size) facetValues.push(facets.size.toLowerCase().trim());
  if (facets.color) facetValues.push(facets.color.toLowerCase().trim());
  if (facets.material) facetValues.push(facets.material.toLowerCase().trim());
  
  if (facetValues.length === 0) {
    return hardTerms; // No facets to filter
  }
  
  return hardTerms.filter(term => {
    const termLower = term.toLowerCase().trim();
    return !facetValues.some(facet => facet === termLower);
  });
}

function parseConstraintsFromAnswers(answersJson: any): VariantConstraints {
  // We don't know your exact answers shape, so we search common keys.
  // Works for { size: "Small" } or { answers: { size: "Small" } } etc.
  let root: any;
  try {
    root = typeof answersJson === "string" ? JSON.parse(answersJson) : answersJson;
  } catch {
    root = answersJson;
  }
  root = root?.answers ?? root ?? {};

  return {
    size: pickString(root, ["size", "Size", "selectedSize", "variantSize"]),
    color: pickString(root, ["color", "colour", "Color", "Colour", "selectedColor", "selectedColour"]),
    material: pickString(root, ["material", "fabric", "Material", "Fabric"]),
  };
}

/**
 * Extract OR allow-list values from text (e.g., "Navy or Blue", "either A or B", "A / B")
 * Returns array of normalized values or null if no OR pattern found
 */
function extractAllowList(text: string, validValues: string[]): string[] | null {
  const t = text.toLowerCase();
  
  // Patterns for OR: "A or B", "either A or B", "A / B", "A, B, or C"
  // Match words around "or", "either...or", or "/"
  const orPatterns = [
    /\b(\w+)\s+or\s+(\w+)\b/gi,
    /\beither\s+(\w+)\s+or\s+(\w+)\b/gi,
    /\b(\w+)\s*\/\s*(\w+)\b/gi,
    /\b(\w+),\s*(\w+)(?:,\s*or\s+(\w+))?/gi,
  ];
  
  for (const pattern of orPatterns) {
    const match = pattern.exec(text);
    if (match) {
      const values: string[] = [];
      // Extract all matched groups (skip full match at index 0)
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          const value = match[i].trim().toLowerCase();
          // Check if value is in the valid values list (case-insensitive)
          const normalized = validValues.find(v => v.toLowerCase() === value);
          if (normalized) {
            values.push(normalized);
          }
        }
      }
      if (values.length >= 2) {
        // Normalize values (capitalize first letter)
        return values.map(v => v.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" "));
      }
    }
  }
  
  return null;
}

function parseConstraintsFromText(text: string): VariantConstraints {
  const t = (text || "").toLowerCase();
  const allowValues: Record<string, string[]> = {};

  // Size parsing (keep conservative)
  const sizeMap: Record<string, string> = {
    "xxs": "XXS",
    "xs": "XS",
    "small": "Small",
    "s": "S",
    "medium": "Medium",
    "m": "M",
    "large": "Large",
    "l": "L",
    "xl": "XL",
    "xxl": "XXL",
  };
  
  const sizeValues = Object.keys(sizeMap);

  // Common "UK 10" style sizes (fashion)
  const ukDress = t.match(/\buk\s?(\d{1,2})\b/);
  const numericSize = t.match(/\bsize\s?(\d{1,2})\b/);

  // Try to extract OR allow-list for size first
  const sizeAllowList = extractAllowList(text, sizeValues);
  if (sizeAllowList) {
    allowValues.size = sizeAllowList;
    const sourceMatch = text.match(/\b(?:size\s+)?(?:either\s+)?\w+\s+(?:or|\/)\s+\w+/i);
    if (sourceMatch) {
      console.log("[Constraints] allow_list", { attribute: "size", values: sizeAllowList, sourceTextSnippet: sourceMatch[0] });
    }
  }

  let size: string | null = null;
  for (const key of Object.keys(sizeMap)) {
    const re = new RegExp(`\\b${key}\\b`, "i");
    if (re.test(text)) { size = sizeMap[key]; break; }
  }
  if (!size && ukDress?.[1]) size = `UK ${ukDress[1]}`;
  if (!size && numericSize?.[1]) size = `Size ${numericSize[1]}`;

  // Color parsing (simple list; expand later)
  const colors = [
    "black","white","grey","gray","navy","blue","green","red","pink","purple",
    "beige","cream","brown","tan","orange","yellow","gold","silver","khaki",
  ];
  
  // Try to extract OR allow-list for color first
  const colorAllowList = extractAllowList(text, colors);
  if (colorAllowList) {
    allowValues.color = colorAllowList;
    const sourceMatch = text.match(/\b(?:color|colour)?\s*(?:in\s+)?(?:either\s+)?\w+\s+(?:or|\/)\s+\w+/i);
    if (sourceMatch) {
      console.log("[Constraints] allow_list", { attribute: "color", values: colorAllowList, sourceTextSnippet: sourceMatch[0] });
    }
  }
  
  let color: string | null = null;
  for (const c of colors) {
    const re = new RegExp(`\\b${c}\\b`, "i");
    if (re.test(text)) { color = c[0].toUpperCase() + c.slice(1); break; }
  }

  // Material/Ingredient parsing (industry-agnostic: Fashion, Beauty, Home, Health)
  // Fashion: fabrics and materials
  // Beauty: key ingredients
  // Home: construction materials
  // Health: active ingredients
  const materials = [
    // Fashion/Apparel materials
    "cotton","linen","silk","wool","leather","denim","polyester","viscose","nylon","cashmere","spandex","elastane",
    // Beauty/Cosmetics ingredients
    "retinol","hyaluronic acid","vitamin c","niacinamide","peptide","ceramide","collagen","aloe vera","shea butter",
    "coconut oil","argan oil","jojoba","glycerin","salicylic acid","benzoyl peroxide","squalane","snail mucin",
    // Home/Garden materials
    "wood","metal","glass","ceramic","plastic","bamboo","marble","granite","stainless steel","aluminum","brass","copper",
    "fabric","upholstery","leather","rattan","wicker","mdf","particle board","solid wood",
    // Health/Wellness ingredients
    "protein","fiber","vitamin","mineral","omega","probiotic","prebiotic","antioxidant","turmeric","ginger","echinacea"
  ];
  
  // Try to extract OR allow-list for material first
  const materialAllowList = extractAllowList(text, materials);
  if (materialAllowList) {
    allowValues.material = materialAllowList;
    const sourceMatch = text.match(/\b(?:material|fabric)?\s*(?:in\s+)?(?:either\s+)?\w+(?:\s+\w+)?\s+(?:or|\/)\s+\w+/i);
    if (sourceMatch) {
      console.log("[Constraints] allow_list", { attribute: "material", values: materialAllowList, sourceTextSnippet: sourceMatch[0] });
    }
  }
  
  let material: string | null = null;
  for (const m of materials) {
    const re = new RegExp(`\\b${m.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(text)) { 
      material = m.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" "); 
      break; 
    }
  }

  const result: VariantConstraints = { size, color, material };
  if (Object.keys(allowValues).length > 0) {
    result.allowValues = allowValues;
  }
  return result;
}

/**
 * Parse user intent into hard terms, soft terms, avoid terms, and facets
 * Industry-agnostic intent parsing
 */
/**
 * Extract smart fetch signals from answers, conversation messages, and parsed intent
 * Returns keywords, selections, and constraints for building Shopify search queries
 */
function extractSmartFetchSignals(
  answers: any[],
  conversationMessages: Array<{ role: string; content: string }>,
  modeUsed: string
): {
  keywords: string[];
  selections: string[];
  hasMeaningfulSignals: boolean;
  rawPreview: string;
} {
  const keywords: string[] = [];
  const selections: string[] = [];
  const seen = new Set<string>();
  
  // Generic placeholders to ignore
  const ignorePatterns = [
    /^any$/i,
    /^all$/i,
    /^all products$/i,
    /^any colour$/i,
    /^any color$/i,
    /^any size$/i,
    /^any material$/i,
    /^none$/i,
    /^n\/a$/i,
    /^na$/i,
  ];
  
  const shouldIgnore = (text: string): boolean => {
    const trimmed = text.trim().toLowerCase();
    return ignorePatterns.some(pattern => pattern.test(trimmed));
  };
  
  // Extract from conversation messages (chat/hybrid modes)
  const userMessages: string[] = [];
  if (conversationMessages && conversationMessages.length > 0) {
    for (const msg of conversationMessages) {
      if (msg.role === "user" && msg.content && typeof msg.content === "string") {
        const content = msg.content.trim();
        if (content.length > 0 && !shouldIgnore(content)) {
          userMessages.push(content);
        }
      }
    }
  }
  
  // Helper to detect if an answer is a budget/price string (should be excluded from keywords)
  const isBudgetString = (text: string): boolean => {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    
    // Check for currency symbols
    if (/[\$£€¥]/.test(trimmed)) return true;
    
    // Check for budget patterns
    if (/under/i.test(lower) && /\d/.test(trimmed)) return true;
    if (/over/i.test(lower) && /\d/.test(trimmed)) return true;
    if (/and above/i.test(lower) && /\d/.test(trimmed)) return true;
    if (/plus/i.test(lower) && /\d/.test(trimmed)) return true;
    if (/[\+\-]/.test(trimmed) && /\d/.test(trimmed)) return true;
    
    // Check for numeric ranges (e.g., "100-250", "50 to 100")
    if (/\d+[\s\-]+to[\s\-]+\d+/i.test(trimmed)) return true;
    if (/\d+[\s\-]+\d+/.test(trimmed)) return true; // Simple range like "100-250"
    
    // Check for price-like patterns with numbers
    if (/^\$?\d+[\s\-]*(plus|\+|-|to|and above|under)/i.test(trimmed)) return true;
    
    return false;
  };
  
  // Extract from answers (quiz/hybrid modes) - filter out budget strings
  const answerTexts: string[] = [];
  const droppedPriceAnswers: string[] = [];
  if (Array.isArray(answers)) {
    for (const answer of answers) {
      if (answer === null || answer === undefined) continue;
      const answerStr = String(answer).trim();
      if (answerStr.length > 0 && !shouldIgnore(answerStr)) {
        // Skip budget patterns (they're constraints, not keywords)
        if (isBudgetString(answerStr)) {
          droppedPriceAnswers.push(answerStr);
          continue;
        }
        answerTexts.push(answerStr);
      }
    }
  }
  
  // Also filter budget strings from conversation messages
  const filteredUserMessages: string[] = [];
  for (const msg of userMessages) {
    // Check if message contains budget strings - if so, try to extract non-budget parts
    const words = msg.split(/\s+/);
    const nonBudgetWords: string[] = [];
    let inBudgetContext = false;
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const nextWord = i < words.length - 1 ? words[i + 1] : "";
      const combined = `${word} ${nextWord}`.trim();
      
      // Check if this word/combination is budget-related
      if (isBudgetString(word) || isBudgetString(combined)) {
        inBudgetContext = true;
        // Skip this word and potentially next word
        if (isBudgetString(combined)) i++; // Skip next word too
        continue;
      }
      
      // If we're not in a budget context, keep the word
      if (!inBudgetContext) {
        nonBudgetWords.push(word);
      }
    }
    
    if (nonBudgetWords.length > 0) {
      const cleaned = nonBudgetWords.join(" ").trim();
      if (cleaned.length > 0) {
        filteredUserMessages.push(cleaned);
      }
    }
  }
  
  // Combine all text sources (use filtered messages)
  const allText = [...filteredUserMessages, ...answerTexts].join(" ");
  const rawPreview = allText.substring(0, 200);
  
  // Tokenize and extract meaningful keywords (min 3 chars, not stopwords, not numbers-only)
  // Industry-agnostic stopwords including constraint/filler tokens
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "what", "which", "who", "whom", "where", "when", "why", "how", "if", "then", "else",
    "about", "above", "after", "before", "below", "between", "during", "through", "under", "over",
    "up", "down", "out", "off", "away", "back", "here", "there", "where", "everywhere", "nowhere",
    "some", "any", "all", "both", "each", "every", "few", "many", "most", "other", "some", "such",
    "no", "not", "none", "nothing", "nobody", "nowhere", "never", "neither", "nor",
    "want", "looking", "for", "need", "prefer", "like",
    // Constraint/filler tokens that should be removed from SmartFetch keywords
    "add", "also", "less", "than", "below", "over", "between", "then"
  ]);
  
  // Track dropped tokens for logging
  const droppedTokens: string[] = [];
  
  const words = allText.toLowerCase().split(/\s+/).filter(w => {
    const cleaned = w.replace(/[^\w]/g, "");
    // Exclude numbers-only tokens, stopwords, and price/currency tokens
    if (/^\d+$/.test(cleaned)) {
      droppedTokens.push(cleaned);
      return false; // Numbers-only
    }
    if (stopwords.has(cleaned)) {
      droppedTokens.push(cleaned);
      return false; // Stopword
    }
    // Check for currency symbols or price patterns
    if (/[\$£€¥]/.test(w) || isBudgetString(w)) {
      droppedTokens.push(cleaned);
      return false; // Price/currency token
    }
    return cleaned.length >= 3;
  });
  
  for (const word of words) {
    const cleaned = word.replace(/[^\w]/g, "").toLowerCase();
    // Skip numbers-only tokens, stopwords, and price tokens
    if (/^\d+$/.test(cleaned)) {
      droppedTokens.push(cleaned);
      continue;
    }
    if (stopwords.has(cleaned)) {
      droppedTokens.push(cleaned);
      continue;
    }
    if (cleaned.length >= 3 && !seen.has(cleaned)) {
      seen.add(cleaned);
      keywords.push(cleaned);
    }
  }
  
  // Extract phrases that the user ACTUALLY TYPED (not permutations)
  // Check the original text to see what phrases exist
  const originalTextLower = allText.toLowerCase();
  const userTypedPhrases: string[] = [];
  const phraseSeen = new Set<string>();
  
  // Only extract phrases that exist in the original text (consecutive words)
  // This prevents creating permutations like "lotion cream" from "lotion or cream"
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`.replace(/[^\w\s]/g, "").trim();
    // Skip phrases that are just numbers
    if (/^\d+\s+\d+$/.test(phrase)) continue;
    // Only add if it's a real multi-word phrase AND exists in original text
    if (phrase.includes(" ") && phrase.length >= 6 && !phraseSeen.has(phrase)) {
      // Check if this exact phrase exists in the original text (as consecutive words)
      // Use word boundaries to ensure it's not part of a larger phrase
      const phrasePattern = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (phrasePattern.test(originalTextLower)) {
        phraseSeen.add(phrase);
        userTypedPhrases.push(phrase);
      }
    }
  }
  
  // Only add phrases that the user actually typed (not permutations)
  for (const phrase of userTypedPhrases) {
    if (phrase.includes(" ") && phrase.length >= 6) {
      selections.push(phrase);
    }
  }
  
  // For >=2 keywords: Keep ALL keywords (don't remove them even if in phrases)
  // We'll build token-OR queries, so we need all individual tokens
  // Only deduplicate exact duplicates, not tokens that are part of phrases
  const deduplicatedKeywords: string[] = [];
  const keywordSeen = new Set<string>();
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase().trim();
    // Only skip exact duplicates (not tokens that are part of phrases)
    if (!keywordSeen.has(normalized)) {
      keywordSeen.add(normalized);
      deduplicatedKeywords.push(keyword);
    }
  }
  
  // Also deduplicate selections themselves
  const deduplicatedSelections: string[] = [];
  const selectionSeen = new Set<string>();
  for (const selection of selections) {
    const normalized = selection.toLowerCase().trim();
    if (!selectionSeen.has(normalized)) {
      selectionSeen.add(normalized);
      deduplicatedSelections.push(selection);
    }
  }
  
  const hasMeaningfulSignals = deduplicatedKeywords.length > 0 || deduplicatedSelections.length > 0;
  
  // Log sanitization results with dropped tokens
  const uniqueDropped = Array.from(new Set(droppedTokens)).slice(0, 20);
  console.log(`[SmartFetchTokens] intent=[${deduplicatedKeywords.slice(0, 10).join(",")}${deduplicatedKeywords.length > 10 ? "..." : ""}] dropped=[${uniqueDropped.join(",")}${uniqueDropped.length >= 20 ? "..." : ""}]`);
  console.log(`[SmartFetch] signals_sanitized keywords=[${deduplicatedKeywords.slice(0, 10).join(",")}${deduplicatedKeywords.length > 10 ? "..." : ""}] selections=[${deduplicatedSelections.slice(0, 5).join(",")}${deduplicatedSelections.length > 5 ? "..." : ""}] droppedPriceAnswers=[${droppedPriceAnswers.join(",")}]`);
  
  return {
    keywords: deduplicatedKeywords.slice(0, 20), // Cap to avoid query bloat
    selections: deduplicatedSelections.slice(0, 10), // Cap selections
    hasMeaningfulSignals,
    rawPreview,
  };
}

/**
 * Build a Shopify Admin GraphQL products search query string from fetch signals
 * Industry-agnostic: uses generic keyword matching over title/tag/product_type/vendor
 * Fixed: For >=2 keywords, builds token-OR queries (not phrase permutations)
 * Only quotes phrases that user actually typed, always includes individual token clauses
 */
function buildShopifySearchQuery(
  signals: { keywords: string[]; selections: string[]; hasMeaningfulSignals: boolean },
  maxQueryLength: number = 500
): string | null {
  if (!signals.hasMeaningfulSignals) {
    return null;
  }
  
  // Filter out numbers-only tokens
  const safeKeywords = signals.keywords.filter(k => !/^\d+$/.test(k));
  const safeSelections = signals.selections.filter(s => !/^\d+/.test(s));
  
  // For >=2 keywords: Build token-OR query (each token gets its own clause)
  // Always include individual token clauses, even if there's a phrase
  const tokenClauses: string[] = [];
  const tokensSeen = new Set<string>();
  
  // First, add individual token clauses for all keywords (for >=2 keywords, this is the primary strategy)
  for (const keyword of safeKeywords) {
    const normalized = keyword.trim().toLowerCase();
    if (normalized.length > 0 && !tokensSeen.has(normalized)) {
      tokensSeen.add(normalized);
      // Escape special characters
      const escaped = keyword.replace(/[\\"]/g, "\\$&");
      // Single tokens should NOT be quoted
      tokenClauses.push(
        `(title:${escaped} OR product_type:${escaped} OR tag:${escaped} OR vendor:${escaped})`
      );
    }
  }
  
  // Then, add phrase clauses ONLY for phrases that user actually typed
  // Always include these in addition to individual tokens (not instead of)
  for (const selection of safeSelections) {
    const normalized = selection.trim().toLowerCase();
    // Only add if it's a real multi-word phrase (contains space)
    if (normalized.includes(" ") && normalized.length > 0) {
      // Escape special characters
      const escaped = selection.replace(/[\\"]/g, "\\$&");
      // Quote multi-word phrases
      const quotedPhrase = `"${escaped}"`;
      tokenClauses.push(
        `(title:${quotedPhrase} OR product_type:${quotedPhrase} OR tag:${quotedPhrase} OR vendor:${quotedPhrase})`
      );
    }
  }
  
  if (tokenClauses.length === 0) {
    return null;
  }
  
  // Build single OR query (no AND logic)
  const query = tokenClauses.join(" OR ");
  
  // Truncate if too long
  let finalQuery = query;
  if (finalQuery.length > maxQueryLength) {
    finalQuery = finalQuery.substring(0, maxQueryLength);
    // Try to end at a logical point (before a closing paren or OR)
    const lastOr = finalQuery.lastIndexOf(" OR ");
    const lastParen = finalQuery.lastIndexOf(")");
    const cutPoint = Math.max(lastOr, lastParen);
    if (cutPoint > maxQueryLength * 0.7) {
      finalQuery = finalQuery.substring(0, cutPoint);
    }
  }
  
  // Final safety check: if query is empty or only contains numbers, return null
  const queryWithoutParens = finalQuery.replace(/[()]/g, "").trim();
  if (queryWithoutParens.length === 0 || /^\d+$/.test(queryWithoutParens)) {
    return null;
  }
  
  return finalQuery;
}

/**
 * Fetch products using Shopify search query with pagination
 * Returns products array and whether more pages are available
 */
async function fetchProductsByQueryPaginated(
  shopDomain: string,
  accessToken: string,
  query: string,
  targetCount: number,
  pageSize: number = 200
): Promise<{
  products: Array<any>;
  hasMorePages: boolean;
  totalFetched: number;
}> {
  // fetchShopifyProductsBySearchQuery is already imported at the top
  
  const allProducts: any[] = [];
  let cursor: string | null = null;
  let hasMorePages = true;
  let totalFetched = 0;
  
  while (hasMorePages && allProducts.length < targetCount) {
    const remaining = targetCount - allProducts.length;
    const currentPageSize = Math.min(pageSize, remaining);
    
    try {
      // Note: fetchShopifyProductsBySearchQuery doesn't support cursor pagination yet
      // For now, we'll fetch in batches by adjusting the query or using offset
      // This is a simplified version - in production, you'd want cursor-based pagination
      const batch = await fetchShopifyProductsBySearchQuery({
        shopDomain,
        accessToken,
        query,
        targetCount: currentPageSize,
      });
      
              // Deduplicate by handle
              const seenHandles = new Set(allProducts.map((p: any) => p.handle));
              const newProducts = batch.filter((p: any) => !seenHandles.has(p.handle));
      
      if (newProducts.length === 0) {
        hasMorePages = false;
        break;
      }
      
      allProducts.push(...newProducts);
      totalFetched += batch.length;
      
      // If we got fewer than requested, assume no more pages
      if (batch.length < currentPageSize) {
        hasMorePages = false;
      } else if (allProducts.length >= targetCount) {
        hasMorePages = false;
      }
      
      // Safety: cap total fetches
      if (totalFetched >= targetCount * 2) {
        hasMorePages = false;
      }
    } catch (error) {
      console.error(`[SmartFetch] Error fetching page:`, error);
      hasMorePages = false;
      break;
    }
  }
  
  return {
    products: allProducts.slice(0, targetCount),
    hasMorePages: allProducts.length >= targetCount && hasMorePages,
    totalFetched: allProducts.length,
  };
}

function parseIntentGeneric(
  userText: string,
  answersJson: string,
  variantConstraints: VariantConstraints
): {
  hardTerms: string[];
  softTerms: string[];
  avoidTerms: string[];
  hardFacets: { size: string | null; color: string | null; material: string | null };
} {
  const lowerText = userText.toLowerCase();
  
  // Strong category phrases across industries (non-exhaustive, can be expanded)
  const categoryPhrases = [
    // Apparel
    "suit", "dress", "shirt", "pants", "jeans", "jacket", "coat", "sweater", "hoodie", "t-shirt", "tshirt",
    "shorts", "skirt", "blouse", "polo", "tank", "blazer", "cardigan", "vest", "jumpsuit", "romper",
    // Home/Garden
    "sofa", "couch", "chair", "table", "desk", "bed", "mattress", "pillow", "blanket", "curtain", "rug",
    "lamp", "vase", "mirror", "shelf", "cabinet", "drawer", "plant", "lawn mower", "mower", "shed",
    "fence", "garden tool", "watering can", "pot", "planter", "outdoor furniture",
    // Beauty/Fitness
    "serum", "moisturizer", "cleanser", "toner", "face mask", "lipstick", "foundation", "mascara", "eyeliner",
    "perfume", "cologne", "shampoo", "conditioner", "treadmill", "dumbbell", "yoga mat", "resistance band",
    "exercise bike", "rowing machine", "elliptical",
    // Electronics
    "phone", "laptop", "tablet", "headphone", "speaker", "camera", "watch", "smartwatch",
    // General
    "book", "bag", "backpack", "wallet", "watch", "jewelry", "necklace", "ring", "earring", "bracelet",
    "shoe", "boot", "sneaker", "sandals", "flip flop", "slipper",
  ];
  
  // Industry-agnostic: NO synonym expansion
  // Use only the exact terms the user provides to avoid industry-specific assumptions
  function expandHardTermsWithSynonyms(terms: string[]): string[] {
    // Return terms as-is without any expansion for true industry-agnostic behavior
    return terms;
  }
  
  const hardTerms: string[] = [];
  const softTerms: string[] = [];
  const avoidTerms: string[] = [];
  
  // Extract avoid terms first
  const avoidPatterns = [
    /\bno\s+([a-z\s]{3,30})\b/gi,
    /\bnot\s+([a-z\s]{3,30})\b/gi,
    /\bwithout\s+([a-z\s]{3,30})\b/gi,
    /\bavoid\s+([a-z\s]{3,30})\b/gi,
    /\bdon't\s+want\s+([a-z\s]{3,30})\b/gi,
    /\bdon't\s+like\s+([a-z\s]{3,30})\b/gi,
  ];
  
  for (const pattern of avoidPatterns) {
    let match;
    while ((match = pattern.exec(lowerText)) !== null) {
      const phrase = match[1].trim();
      const tokens = tokenize(phrase);
      avoidTerms.push(...tokens);
    }
  }
  
  // Industry-agnostic: Intelligent term classification using linguistic patterns
  // Classifies terms as HARD (concrete products/attributes) or SOFT (abstract concepts/context)
  // First, remove price/budget information from text before term extraction (industry-agnostic)
  let textForTermExtraction = lowerText;
  // Remove price/budget patterns to prevent them from being extracted as terms
  const priceBudgetPatterns = [
    /\b(?:budget|price|cost|spend|spending|total|maximum|max)\s+(?:is|of)?\s*[£$€]?\s*\d+(?:[.,]\d+)?/gi,
    /\b[£$€]\s*\d+(?:[.,]\d+)?\s+(?:budget|total|for\s+all|for\s+everything)/gi,
    /\b(?:under|below|less\s+than|up\s+to)\s+[£$€]?\s*\d+(?:[.,]\d+)?/gi,
  ];
  for (const pattern of priceBudgetPatterns) {
    textForTermExtraction = textForTermExtraction.replace(pattern, " ");
  }
  
  const stopWords = new Set(["a", "an", "the", "and", "or", "for", "in", "on", "at", "to", "of", "with", "i", "want", "need", "looking", "for", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "this", "that", "these", "those", "my", "go", "the"]);
  
  // Context prepositions that indicate use-case/occasion (terms after these are usually SOFT)
  const contextPrepositions = new Set(["for", "at", "in", "on", "during", "when", "while"]);
  
  // Abstract collection/concept terms (always SOFT - industry-agnostic patterns)
  // These are linguistic patterns, not industry-specific lists
  const abstractPatterns = [
    /^(outfit|ensemble|set|kit|bundle|package|collection|combo|combination|pair|group|lot|suite|system|solution)$/i,
    /^(complete|full|entire|whole|total)$/i, // When used as nouns describing collections
    /^(complete\s+outfit|full\s+outfit|entire\s+outfit|whole\s+outfit)$/i, // Multi-word abstract patterns
  ];
  
  // Price/budget terms (always SOFT - these are constraints, not products)
  const priceBudgetTerms = [
    /^(budget|price|cost|spend|spending|total|maximum|max|under|below|less|up\s+to)$/i,
  ];
  
  // Occasion/context terms (always SOFT - these describe when/where/why, not what)
  const occasionPatterns = [
    /^(wedding|party|event|occasion|ceremony|meeting|interview|date|dinner|work|office|home|outdoor|indoor|formal|casual|sport|exercise|gym|beach|vacation|travel|business|professional)$/i,
  ];
  
  // Extract meaningful phrases (2-4 words) that aren't stop words
  // Use textForTermExtraction (with price/budget removed) for term extraction
  const words = textForTermExtraction.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w) && !/^\d+$/.test(w)); // Also filter pure numbers
  const wordPositions = new Map<string, number>(); // Track word positions for context analysis
  words.forEach((w, idx) => {
    const originalIdx = textForTermExtraction.indexOf(w, wordPositions.size > 0 ? Array.from(wordPositions.values())[wordPositions.size - 1] + 1 : 0);
    wordPositions.set(w, originalIdx);
  });
  
  // Build phrases: 1-word, 2-word, 3-word combinations (industry-agnostic)
  const hardTermCandidates = new Set<string>();
  const softTermCandidates = new Set<string>();
  
  // Analyze each word/phrase for context and semantic role
  function classifyTerm(term: string, position: number, contextBefore: string, contextAfter: string): "hard" | "soft" {
    const termLower = term.toLowerCase();
    
    // 1. Check for abstract collection patterns (always SOFT)
    for (const pattern of abstractPatterns) {
      if (pattern.test(termLower)) {
        return "soft";
      }
    }
    
    // 2. Check for price/budget terms (always SOFT - these are constraints, not products)
    for (const pattern of priceBudgetTerms) {
      if (pattern.test(termLower)) {
        return "soft";
      }
    }
    
    // 3. Check for occasion/context patterns (always SOFT)
    for (const pattern of occasionPatterns) {
      if (pattern.test(termLower)) {
        return "soft";
      }
    }
    
    // 4. Context-based classification: terms after context prepositions are usually SOFT
    const beforeWords = contextBefore.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (beforeWords.length > 0) {
      const lastWordBefore = beforeWords[beforeWords.length - 1];
      if (contextPrepositions.has(lastWordBefore)) {
        // Term follows a context preposition -> likely use-case/occasion (SOFT)
        return "soft";
      }
    }
    
    // 5. Check for "for X" pattern (use-case indicator)
    if (contextBefore.trim().endsWith(" for") || contextBefore.trim().endsWith(" for a") || contextBefore.trim().endsWith(" for an")) {
      return "soft"; // "for wedding", "for work", etc. are use-cases
    }
    
    // 6. Check for descriptive patterns that suggest attributes (HARD)
    // Colors, sizes, materials are usually HARD terms
    const colorPattern = /^(red|blue|green|yellow|orange|purple|pink|brown|black|white|gray|grey|navy|beige|tan|maroon|burgundy|teal|cyan|magenta|olive|khaki|ivory|cream|silver|gold|bronze|copper)$/i;
    const sizePattern = /^(small|medium|large|xlarge|xl|xxl|xxxl|tiny|huge|big|little|mini|maxi|petite|tall|short|wide|narrow)$/i;
    const materialPattern = /^(cotton|wool|silk|leather|denim|linen|polyester|nylon|spandex|cashmere|suede|canvas|velvet|satin|chiffon|jersey|knit|woven)$/i;
    
    if (colorPattern.test(termLower) || sizePattern.test(termLower) || materialPattern.test(termLower)) {
      return "hard"; // Descriptive attributes are HARD
    }
    
    // 7. Default: longer, specific terms are more likely to be concrete products (HARD)
    // Shorter, generic terms might be concepts (SOFT)
    if (termLower.length >= 6) {
      // Longer terms are usually specific products (HARD)
      return "hard";
    } else if (termLower.length <= 4) {
      // Very short terms might be concepts, but default to HARD if no other indicators
      // (most 4-letter words are still product terms: "sofa", "lamp", "book")
      return "hard";
    }
    
    // 8. Default to HARD for concrete nouns (most product terms)
    return "hard";
  }
  
  // Single significant words
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length >= 4) {
      const position = wordPositions.get(word) || 0;
      const contextBefore = lowerText.substring(Math.max(0, position - 20), position);
      const contextAfter = lowerText.substring(position + word.length, Math.min(lowerText.length, position + word.length + 20));
      
      const classification = classifyTerm(word, position, contextBefore, contextAfter);
      if (classification === "hard") {
        hardTermCandidates.add(word);
      } else {
        softTermCandidates.add(word);
      }
    }
  }
  
  // 2-word phrases
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (phrase.length >= 5) {
      const position = wordPositions.get(words[i]) || 0;
      const contextBefore = lowerText.substring(Math.max(0, position - 20), position);
      const contextAfter = lowerText.substring(position + phrase.length, Math.min(lowerText.length, position + phrase.length + 20));
      
      const classification = classifyTerm(phrase, position, contextBefore, contextAfter);
      if (classification === "hard") {
        hardTermCandidates.add(phrase);
      } else {
        softTermCandidates.add(phrase);
      }
    }
  }
  
  // 3-word phrases (most specific)
  for (let i = 0; i < words.length - 2; i++) {
    const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    if (phrase.length >= 8) {
      const position = wordPositions.get(words[i]) || 0;
      const contextBefore = lowerText.substring(Math.max(0, position - 20), position);
      const contextAfter = lowerText.substring(position + phrase.length, Math.min(lowerText.length, position + phrase.length + 20));
      
      const classification = classifyTerm(phrase, position, contextBefore, contextAfter);
      if (classification === "hard") {
        hardTermCandidates.add(phrase);
      } else {
        softTermCandidates.add(phrase);
      }
    }
  }
  
  // Add classified terms
  hardTerms.push(...Array.from(hardTermCandidates));
  softTerms.push(...Array.from(softTermCandidates));
  
  // Fallback: Also check categoryPhrases for common terms (helps with known categories)
  // But don't rely solely on this - extracted phrases take priority
  for (const phrase of categoryPhrases) {
    const regex = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (regex.test(lowerText) && !hardTerms.includes(phrase)) {
      hardTerms.push(phrase);
    }
  }
  
  // No synonym expansion (industry-agnostic)
  const expandedHardTerms = expandHardTermsWithSynonyms(hardTerms);
  
  // Parse answers JSON for additional context
  let answersData: any = {};
  try {
    answersData = typeof answersJson === "string" ? JSON.parse(answersJson) : answersJson;
    if (Array.isArray(answersData)) {
      // If array, concatenate strings and extract terms
      const answerText = answersData
        .filter((a: any) => typeof a === "string")
        .join(" ")
        .toLowerCase();
      
      // Use same intelligent classification logic for answers
      const answerWords = answerText.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
      const answerWordPositions = new Map<string, number>();
      answerWords.forEach((w, idx) => {
        const originalIdx = answerText.indexOf(w, answerWordPositions.size > 0 ? Array.from(answerWordPositions.values())[answerWordPositions.size - 1] + 1 : 0);
        answerWordPositions.set(w, originalIdx);
      });
      
      // Classify and add terms from answers
      for (let i = 0; i < answerWords.length; i++) {
        const word = answerWords[i];
        if (word.length >= 4) {
          const position = answerWordPositions.get(word) || 0;
          const contextBefore = answerText.substring(Math.max(0, position - 20), position);
          const contextAfter = answerText.substring(position + word.length, Math.min(answerText.length, position + word.length + 20));
          
          const classification = classifyTerm(word, position, contextBefore, contextAfter);
          if (classification === "hard" && !expandedHardTerms.includes(word)) {
            expandedHardTerms.push(word);
          } else if (classification === "soft" && !softTerms.includes(word)) {
            softTerms.push(word);
          }
        }
      }
      
      // 2-word phrases from answers
      for (let i = 0; i < answerWords.length - 1; i++) {
        const phrase = `${answerWords[i]} ${answerWords[i + 1]}`;
        if (phrase.length >= 5) {
          const position = answerWordPositions.get(answerWords[i]) || 0;
          const contextBefore = answerText.substring(Math.max(0, position - 20), position);
          const contextAfter = answerText.substring(position + phrase.length, Math.min(answerText.length, position + phrase.length + 20));
          
          const classification = classifyTerm(phrase, position, contextBefore, contextAfter);
          if (classification === "hard" && !expandedHardTerms.includes(phrase)) {
          expandedHardTerms.push(phrase);
          } else if (classification === "soft" && !softTerms.includes(phrase)) {
            softTerms.push(phrase);
          }
        }
      }
    } else if (typeof answersData === "object") {
      // Extract terms from object values (industry-agnostic)
      const answerText = JSON.stringify(answersData).toLowerCase();
      const answerWords = answerText.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
      
      // Simple classification for object values (less context available)
      for (const word of answerWords) {
        if (word.length >= 4) {
          // Use simple pattern matching for object values
          let isSoft = false;
          for (const pattern of abstractPatterns) {
            if (pattern.test(word)) {
              isSoft = true;
              break;
            }
          }
          for (const pattern of occasionPatterns) {
            if (pattern.test(word)) {
              isSoft = true;
              break;
            }
          }
          
          if (isSoft && !softTerms.includes(word)) {
            softTerms.push(word);
          } else if (!isSoft && !expandedHardTerms.includes(word)) {
            expandedHardTerms.push(word);
          }
        }
      }
    }
  } catch {
    // Ignore parse errors
  }
  
  // No synonym expansion (already done above)
  const finalHardTerms = expandedHardTerms;
  
  // Extract soft terms (remaining meaningful tokens)
  const allTokens = tokenize(userText);
  const avoidSet = new Set(avoidTerms);
  const hardSet = new Set(finalHardTerms.flatMap((t: string) => tokenize(t)));
  
  for (const token of allTokens) {
    if (!avoidSet.has(token) && !hardSet.has(token) && token.length >= 3) {
      softTerms.push(token);
    }
  }
  
  // Hard facets from variant constraints
  const hardFacets = {
    size: variantConstraints.size,
    color: variantConstraints.color,
    material: variantConstraints.material,
  };
  
  return {
    hardTerms: Array.from(new Set(finalHardTerms)),
    softTerms: Array.from(new Set(softTerms)),
    avoidTerms: Array.from(new Set(avoidTerms)),
    hardFacets,
  };
}

/**
 * Get shop currency from Shopify shop data (cached)
 * Returns currency code (e.g., "USD", "GBP", "EUR") or null if unavailable
 */
async function getShopCurrency(shopDomain: string, accessToken: string): Promise<string | null> {
  try {
    const apiVersion = "2026-01";
    const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    
    const query = `{
      shop {
        currencyCode
      }
    }`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    
    if (!response.ok) {
      console.log("[Currency] Failed to fetch shop currency, status:", response.status);
      return null;
    }
    
    const data = await response.json();
    if (data.errors) {
      console.log("[Currency] GraphQL errors fetching shop currency:", data.errors);
      return null;
    }
    
    const currencyCode = data.data?.shop?.currencyCode || null;
    return currencyCode;
  } catch (error) {
    console.log("[Currency] Error fetching shop currency:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Convert currency symbol to ISO currency code
 */
function currencySymbolToCode(symbol: string): string | null {
  const mapping: Record<string, string> = {
    "$": "USD",
    "£": "GBP",
    "€": "EUR",
  };
  return mapping[symbol] || null;
}

/**
 * Simple currency conversion (can be replaced with configurable FX rate source)
 * Returns conversion rate or 1.0 if currencies match or unknown
 */
function getCurrencyConversionRate(fromCurrency: string | null, toCurrency: string | null): number {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
    return 1.0;
  }
  
  // Default: treat as numeric if no conversion rate available
  // In production, this could call an FX API or use cached rates
  // For now, log mismatch and return 1.0 to treat as numeric
  return 1.0;
}

/**
 * Parse numeric price ceiling from user intent text (industry-agnostic)
 * Extracts a single numeric ceiling (maxPriceCeiling) from natural language phrases
 * Supports currency symbols (£ $ €) and optional commas
 * Returns { value: number, currency: string | null } or null if no valid ceiling is found
 */
function parsePriceCeiling(text: string): { value: number; currency: string | null } | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const normalizedText = text.toLowerCase();
  
  // Ordered list of regex patterns (first match wins)
  // Supports: currency symbols (£ $ €), optional commas, integer/decimal numbers
  const priceCeilingPatterns = [
    // "budget is $600"
    { pattern: /budget\s+is\s*([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "budget is" },
    // "maximum budget is $600" or "max budget is $600"
    { pattern: /(?:maximum|max)\s+budget\s+is\s*([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "max budget is" },
    // "max budget $600" (without "is")
    { pattern: /(?:maximum|max)\s+budget\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "max budget" },
    // "up to $600"
    { pattern: /up\s+to\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "up to" },
    // "under $600" / "below $600" / "less than $600"
    { pattern: /(?:under|below|less\s+than)\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "under/below/less than" },
    // "anything under 80" / "anything below 80"
    { pattern: /anything\s+(?:under|below)\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "anything under/below" },
    // "total budget is $600" or "my total budget is $600"
    { pattern: /(?:my\s+)?total\s+budget\s+is\s*([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "total budget is" },
    // "$600 budget" or "$600 total" or "$600 for all"
    { pattern: /([£$€])\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s+(?:budget|total|for\s+all|for\s+everything)/i, name: "currency amount budget" },
    // "total of $600" or "budget of $600"
    { pattern: /(?:total|budget)\s+of\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "total/budget of" },
    // "spend $600" or "spending $600"
    { pattern: /spend(?:ing)?\s+([£$€]?)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i, name: "spend/spending" },
  ];
  
  for (const { pattern, name } of priceCeilingPatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      // Extract currency symbol (if present) and numeric value
      // Most patterns have: group 1 = optional currency, group 2 = value
      // "currency amount budget" pattern has: group 1 = required currency, group 2 = value
      let currencyDetected = "";
      let valueStr = "";
      
      if (match.length >= 3 && match[2]) {
        // Pattern has value in group 2
        // Check if group 1 is a currency symbol
        if (match[1] && /[£$€]/.test(match[1])) {
          currencyDetected = match[1];
          valueStr = match[2];
        } else {
          // Group 1 is optional currency (might be empty) or not a currency
          currencyDetected = match[1] && /[£$€]/.test(match[1]) ? match[1] : "";
          valueStr = match[2];
        }
      } else if (match[1]) {
        // Only one capture group - could be currency or value
        if (/[£$€]/.test(match[1])) {
          currencyDetected = match[1];
          // Value might be in the full match, need to extract
          const fullMatch = match[0];
          const afterCurrency = fullMatch.replace(new RegExp(`[£$€]\\s*`), "");
          const numberMatch = afterCurrency.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/);
          valueStr = numberMatch ? numberMatch[1] : "";
        } else {
          // Group 1 is the value
          valueStr = match[1];
        }
      }
      
      // Remove commas and parse safely
      const cleanedValue = valueStr.replace(/,/g, "");
      const parsed = parseFloat(cleanedValue);
      
      if (!isNaN(parsed) && isFinite(parsed) && parsed > 0) {
        const currencyCode = currencyDetected ? currencySymbolToCode(currencyDetected) : null;
        console.log("[Constraints] Parsed price ceiling", {
          value: parsed,
          pattern: name,
          currencyDetected: currencyDetected || "none",
          currencyCode: currencyCode || "none"
        });
        return { value: parsed, currency: currencyCode };
      }
    }
  }
  
  return null;
}

/**
 * Industry-agnostic: Normalize text for comparison (strip punctuation, normalize case, collapse whitespace, singularize)
 */
function normalizeItemLabel(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,;:!?]+/g, "") // Strip punctuation
    .replace(/\s+/g, " ") // Collapse whitespace
    .replace(/\b(shirts?|trousers?|pants?|jeans?|shoes?|boots?|sneakers?)\b/gi, (match) => {
      // Simple pluralization: remove trailing 's' for common patterns
      return match.replace(/s$/i, "");
    })
    .trim();
}

/**
 * Check if candidate satisfies constraints via structured options OR tag-derived facets
 * Returns { ok: boolean, conflict?: {facet, expected, actual, source} }
 * Industry-agnostic: works with any facet keys (size, color, material, scent, finish, etc.)
 */
async function satisfiesConstraintsStructuredOrTags(
  candidate: any, // EnrichedCandidate type - defined later in scope
  constraints: Array<{ key: string; value: string }>,
  facetVocabulary?: { optionNames: Set<string>; optionNameToValues: Map<string, Set<string>> }
): Promise<{ ok: boolean; conflict?: { facet: string; expected: string; actual: string; source: string } }> {
  if (constraints.length === 0) {
    return { ok: true };
  }
  
  const { productSatisfiesConstraints, extractConstraintsFromTags, normalizeFacetValue } = await import("~/utils/facets.server");
  
  // Helper to check if two values match (with equivalence)
  function valueMatchesConstraint(productValue: string, constraintValue: string): boolean {
    const normalizedProduct = productValue.toLowerCase().trim();
    const normalizedConstraint = constraintValue.toLowerCase().trim();
    
    // Exact match
    if (normalizedProduct === normalizedConstraint) return true;
    
    // Partial match (conservative - only if one contains the other)
    if (normalizedProduct.includes(normalizedConstraint) || normalizedConstraint.includes(normalizedProduct)) {
      return true;
    }
    
    // Size equivalences (only for size-related constraints)
    const sizeEquivalences: Record<string, string[]> = {
      "s": ["small", "s"],
      "m": ["medium", "m"],
      "l": ["large", "l"],
      "xl": ["extra large", "x-large", "xl", "extra-large"],
      "xxl": ["extra extra large", "xx-large", "xxl", "extra-extra-large"],
    };
    
    if (sizeEquivalences[normalizedConstraint]) {
      const aliases = sizeEquivalences[normalizedConstraint];
      if (aliases.some(alias => normalizedProduct === alias)) return true;
    }
    
    if (sizeEquivalences[normalizedProduct]) {
      const aliases = sizeEquivalences[normalizedProduct];
      if (aliases.some(alias => normalizedConstraint === alias)) return true;
    }
    
    return false;
  }
  
  // Step 1: Try structured matching (variants/options)
  const structuredMatch = productSatisfiesConstraints(candidate, constraints, true);
  if (structuredMatch) {
    return { ok: true };
  }
  
  // Step 2: Check for explicit conflicts in structured data
  const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
  const discoveredOptionNames = facetVocabulary?.optionNames || new Set<string>();
  
  // Check variants for conflicts
  if (Array.isArray(candidate.variants)) {
    for (const variant of candidate.variants) {
      if (Array.isArray(variant.selectedOptions)) {
        for (const opt of variant.selectedOptions) {
          const optName = (opt.name || "").toLowerCase().trim();
          const optValue = (opt.value || "").toLowerCase().trim();
          
          for (const constraint of constraints) {
            const constraintKey = constraint.key.toLowerCase().trim();
            const constraintValue = constraint.value.toLowerCase().trim();
            
            if (optName === constraintKey) {
              // Check if values match (with equivalence)
              const matches = valueMatchesConstraint(optValue, constraintValue);
              if (!matches) {
                // Explicit conflict in structured data
                return {
                  ok: false,
                  conflict: {
                    facet: constraint.key,
                    expected: constraint.value,
                    actual: opt.value,
                    source: "variant_option"
                  }
                };
              }
            }
          }
        }
      }
    }
  }
  
  // Step 3: Extract tag-derived constraints and check for conflicts
  const tagConstraints = extractConstraintsFromTags(tags, discoveredOptionNames);
  const tagConstraintsMap = new Map<string, string>();
  for (const tc of tagConstraints) {
    tagConstraintsMap.set(tc.key.toLowerCase(), tc.value.toLowerCase());
  }
  
  // Check if tag constraints conflict with requested constraints
  for (const constraint of constraints) {
    const constraintKey = constraint.key.toLowerCase().trim();
    const constraintValue = constraint.value.toLowerCase().trim();
    const tagValue = tagConstraintsMap.get(constraintKey);
    
    if (tagValue) {
      // Tag has this facet - check if it matches
      const matches = valueMatchesConstraint(tagValue, constraintValue);
      if (matches) {
        // Tag matches - accept
        return { ok: true };
      } else {
        // Tag conflicts - reject
        return {
          ok: false,
          conflict: {
            facet: constraint.key,
            expected: constraint.value,
            actual: tagValue,
            source: "tag"
          }
        };
      }
    }
  }
  
  // Step 4: If no structured facets exist and no tag facets, allow token fallback
  const hasStructuredFacets = Array.isArray(candidate.variants) && candidate.variants.length > 0 &&
    candidate.variants.some((v: any) => Array.isArray(v.selectedOptions) && v.selectedOptions.length > 0);
  const hasTagFacets = tagConstraints.length > 0;
  
  if (!hasStructuredFacets && !hasTagFacets) {
    // No structured or tag facets - use token containment fallback
    const indexedText = [
      candidate.title || "",
      candidate.handle || "",
      candidate.productType || "",
      tags.join(" "),
      candidate.vendor || "",
      candidate.searchText || "",
    ].join(" ").toLowerCase();
    
    let tokenFallbackMatch = true;
    for (const constraint of constraints) {
      const constraintValue = constraint.value.toLowerCase().trim();
      if (!indexedText.includes(constraintValue)) {
        tokenFallbackMatch = false;
        break;
      }
    }
    
    if (tokenFallbackMatch) {
      return { ok: true };
    }
  }
  
  // Step 5: If structured facets exist but didn't match and no tag match, reject
  return { ok: false };
}

/**
 * Industry-agnostic: Infer canonical type from product (consistent across bundle operations)
 * Uses indexedText/title/handle/tags (not just productType)
 * Supports singular/plural (trouser/trousers, shirt/shirts, suit/suits) with same tokenization as gating
 */
function inferCanonicalType(candidate: { title?: string | null; productType?: string | null; handle?: string; tags?: string[]; vendor?: string | null; searchText?: string | null }): string {
  // Build searchable text from all relevant fields
  const searchableText = [
    candidate.title || "",
    candidate.productType || "",
    candidate.handle || "",
    (candidate.tags || []).join(" "),
    candidate.vendor || "",
    candidate.searchText || "",
  ].join(" ").toLowerCase();
  
  // Tokenize using same logic as gating
  const tokens = tokenize(searchableText);
  const tokenSet = new Set(tokens);
  
  // Industry-agnostic: Extract canonical type from product metadata
  // Priority: productType > first significant token from title > first token from tags > "unknown"
  // No hardcoded patterns - works for any industry
  
  // First, try productType (most reliable)
  if (candidate.productType) {
    const normalized = normalizeItemLabel(candidate.productType);
    if (normalized && normalized !== "unknown") {
      return normalized;
    }
  }
  
  // Second, use first significant token from title (industry-agnostic)
  // Filter out common non-product words
  const nonProductWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had",
    "new", "old", "used", "vintage", "modern", "classic", "premium", "luxury", "basic",
    "black", "white", "red", "blue", "green", "yellow", "orange", "purple", "pink", "brown",
    "small", "medium", "large", "xl", "xxl", "men", "women", "mens", "womens", "unisex"
  ]);
  
  const significantTokens = tokens.filter(t => 
    t.length >= 3 && 
    !nonProductWords.has(t) && 
    !/^\d+$/.test(t)
  );
  
  if (significantTokens.length > 0) {
    return significantTokens[0];
  }
  
  // Last resort: use first token (even if short)
  if (tokens.length > 0) {
    return tokens[0];
  }
  
  return "unknown";
}

/**
 * Industry-agnostic: Check if a term is a contextual modifier (occasion/style/use-case) not a product type
 */
function isContextualModifier(term: string): boolean {
  const normalized = normalizeItemLabel(term);
  const contextualPatterns = [
    /^(wedding|party|event|occasion|ceremony|meeting|interview|date|dinner|work|office|home|outdoor|indoor|formal|casual|sport|exercise|gym|beach|vacation|travel|business|professional|gift|for\s+my\s+\w+|for\s+\w+)$/i,
    /^(complete|full|entire|whole|outfit|ensemble|set|kit|bundle|package|collection|combo|combination)$/i,
    /^(budget|price|cost|spend|spending|total|maximum|max|under|below|less|up|to)$/i,
  ];
  return contextualPatterns.some(pattern => pattern.test(normalized));
}

/**
 * Industry-agnostic: Extract structured bundle items from query
 * Returns array of { label, quantity, constraints, rawTextSpan }
 */
function extractStructuredBundleItems(userIntent: string): Array<{
  label: string;
  quantity: number;
  constraints: {
    priceCeiling?: number | null;
    color?: string | null;
    size?: string | null;
    material?: string | null;
    tags?: string[];
  };
  rawTextSpan?: string;
}> {
  const items: Array<{
    label: string;
    quantity: number;
    constraints: {
      priceCeiling?: number | null;
      color?: string | null;
      size?: string | null;
      material?: string | null;
      tags?: string[];
    };
    rawTextSpan?: string;
  }> = [];
  
  // Extract contextual modifiers as tags (not items)
  const contextualTags: string[] = [];
  const words = userIntent.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (isContextualModifier(word)) {
      contextualTags.push(word);
    }
  }
  
  // Use existing parseBundleIntentGeneric to get items, then normalize and filter
  const bundleResult = parseBundleIntentGeneric(userIntent);
  if (!bundleResult.isBundle) {
    return [];
  }
  
  for (const item of bundleResult.items) {
    const label = item.hardTerms[0] || "";
    const normalizedLabel = normalizeItemLabel(label);
    
    // Skip if label is a contextual modifier
    if (isContextualModifier(normalizedLabel)) {
      continue;
    }
    
    // Extract constraints
    const constraints: {
      priceCeiling?: number | null;
      color?: string | null;
      size?: string | null;
      material?: string | null;
      tags?: string[];
    } = {};
    
    if (item.constraints?.priceCeiling) {
      constraints.priceCeiling = item.constraints.priceCeiling;
    }
    if (item.constraints?.optionConstraints?.color) {
      constraints.color = item.constraints.optionConstraints.color;
    }
    if (item.constraints?.optionConstraints?.size) {
      constraints.size = item.constraints.optionConstraints.size;
    }
    if (item.constraints?.optionConstraints?.material) {
      constraints.material = item.constraints.optionConstraints.material;
    }
    if (contextualTags.length > 0) {
      constraints.tags = contextualTags;
    }
    
    items.push({
      label: normalizedLabel,
      quantity: item.quantity || 1,
      constraints,
      rawTextSpan: label,
    });
  }
  
  return items;
}

/**
 * Parse bundle intent: detect multi-item queries (e.g., "3 piece suit, shirt and trousers")
 * Industry-agnostic bundle detection with per-item constraint extraction
 */
function parseBundleIntentGeneric(userIntent: string): {
  isBundle: boolean;
  items: Array<{ 
    hardTerms: string[]; 
    quantity: number;
    constraints?: {
      optionConstraints?: { 
        size?: string | null; 
        color?: string | null; 
        material?: string | null;
        allowValues?: Record<string, string[]>; // OR allow-list: attribute -> array of allowed values
      };
      priceCeiling?: number | null;
      userCurrency?: string | null; // User-specified currency (from input)
      includeTerms?: string[];
      excludeTerms?: string[];
    };
  }>;
  totalBudget: number | null;
  totalBudgetCurrency: string | null; // Currency detected from total budget
} {
  const lowerText = userIntent.toLowerCase();
  
  // Category lexicon (industry-agnostic: Fashion, Beauty, Home & Garden, Health & Wellness, Electronics, etc.)
  const categoryPhrases = [
    // Fashion & Apparel
    "suit", "dress", "shirt", "pants", "jeans", "jacket", "coat", "sweater", "hoodie", "t-shirt", "tshirt",
    "shorts", "skirt", "blouse", "polo", "tank", "blazer", "cardigan", "vest", "jumpsuit", "romper", "trousers",
    "chinos", "sweatpants", "leggings", "activewear", "athleisure",
    // Beauty & Cosmetics
    "serum", "moisturizer", "cleanser", "toner", "face mask", "lipstick", "foundation", "mascara", "eyeliner",
    "perfume", "cologne", "shampoo", "conditioner", "body wash", "soap", "lotion", "cream", "sunscreen",
    "makeup", "concealer", "blush", "bronzer", "highlighter", "eyeshadow", "lip balm", "nail polish",
    "skincare", "anti-aging", "exfoliant", "essence", "ampoule", "sheet mask",
    // Home & Garden
    "sofa", "couch", "chair", "table", "desk", "bed", "mattress", "pillow", "blanket", "curtain", "rug",
    "lamp", "vase", "mirror", "shelf", "cabinet", "drawer", "plant", "lawn mower", "mower", "shed",
    "fence", "garden tool", "watering can", "pot", "planter", "outdoor furniture", "coffee table",
    "dining table", "side table", "end table", "bookshelf", "wardrobe", "dresser", "nightstand",
    "dining chair", "office chair", "armchair", "recliner", "ottoman", "bench", "stool",
    "throw pillow", "cushion", "comforter", "duvet", "bedding", "bed sheet", "towel", "bath mat",
    "wall art", "picture frame", "decor", "candle", "diffuser", "plant pot", "garden planter",
    // Health & Wellness
    "treadmill", "dumbbell", "yoga mat", "resistance band", "exercise bike", "rowing machine", "elliptical",
    "supplement", "vitamin", "protein", "probiotic", "omega", "multivitamin", "fish oil", "collagen supplement",
    "massage gun", "foam roller", "kettlebell", "barbell", "weight", "fitness tracker", "smart scale",
    "essential oil", "aromatherapy", "meditation cushion", "yoga block", "pilates ball",
    // Electronics
    "phone", "laptop", "tablet", "headphone", "speaker", "camera", "watch", "smartwatch",
    "monitor", "keyboard", "mouse", "printer", "router", "charger", "cable",
    // General/Accessories
    "book", "bag", "backpack", "wallet", "jewelry", "necklace", "ring", "earring", "bracelet",
    "shoe", "boot", "sneaker", "sandals", "flip flop", "slipper", "hat", "cap", "scarf", "gloves",
  ];
  
  // Industry-agnostic: NO synonym expansion
  // Use only the exact terms the user provides to avoid industry-specific assumptions
  const categorySynonyms: Record<string, string[]> = {};
  
  // Soft words that are NOT categories (ignore these)
  const softWords = new Set(["complete", "outfit", "set", "kit", "bundle", "package", "collection"]);
  
  // Industry-agnostic bundle detection: extract items from query, not just predefined categories
  const foundCategories: Array<{ term: string; position: number }> = [];
  
  // Check for bundle indicators FIRST (industry-agnostic approach)
  // If bundle indicators are present, extract items generically from query segments
  const bundleIndicators = [
    /,\s*and\s+/i,           // "suit, and shirt"
    /,\s+/,                  // "suit, shirt"
    /\s+and\s+/i,            // "suit and shirt"
    /\s+\+\s+/,              // "suit + shirt"
    /\s+plus\s+/i,           // "suit plus shirt"
    /\s+with\s+/i,           // "suit with shirt"
    /\s+&\s+/,               // "suit & shirt"
  ];
  
  // Also check for list patterns (numbered lists, bullet points, etc.)
  const listPatterns = [
    /\d+\.\s+\w+/,           // "1. suit 2. shirt"
    /-\s+\w+/,               // "- suit - shirt"
    /\*\s+\w+/,              // "* suit * shirt"
  ];
  
  let hasBundleIndicator = false;
  for (const pattern of bundleIndicators) {
    if (pattern.test(userIntent)) {
      hasBundleIndicator = true;
      break;
    }
  }
  
  // Check for list patterns
  if (!hasBundleIndicator) {
    for (const pattern of listPatterns) {
      if (pattern.test(userIntent)) {
        hasBundleIndicator = true;
        break;
      }
    }
  }
  
  // Industry-agnostic bundle detection:
  // If bundle indicators are present, extract items generically from query segments
  // Don't require items to match predefined category list
  let matchingSeparator: RegExp | null = null;
  if (hasBundleIndicator) {
    // Find which separator matched
    for (const pattern of bundleIndicators) {
      if (pattern.test(userIntent)) {
        matchingSeparator = pattern;
        break;
      }
    }
    
    // Split query by bundle indicators to extract potential items (industry-agnostic)
    if (matchingSeparator) {
      // Remove price/budget information before splitting
      let intentForSplitting = userIntent;
      const priceBudgetPatterns = [
        /\b(?:budget|price|cost|spend|spending|total|maximum|max)\s+(?:is|of)?\s*[£$€]?\s*\d+(?:[.,]\d+)?/gi,
        /\b[£$€]\s*\d+(?:[.,]\d+)?\s+(?:budget|total|for\s+all|for\s+everything)/gi,
        /\b(?:under|below|less\s+than|up\s+to)\s+[£$€]?\s*\d+(?:[.,]\d+)?/gi,
        /\bmy\s+budget/gi,
      ];
      for (const pattern of priceBudgetPatterns) {
        intentForSplitting = intentForSplitting.replace(pattern, " ");
      }
      
      // Split by separator, but also handle nested "and" within segments
      // Industry-agnostic: works for any product type (e.g., "laptop, mouse and keyboard", "sofa, table and chair")
      let segments = intentForSplitting.split(matchingSeparator).map(s => s.trim()).filter(s => s.length > 0);
      
      // CRITICAL FIX: If a segment contains "and", split it further
      // This handles cases like "trousers and Shirt" or "mouse and keyboard" which should be separate items
      // Track which segments came from splitting to ensure single-word extraction
      const expandedSegments: string[] = [];
      const wasSplitFromAnd = new Set<number>(); // Track indices of segments that came from splitting by "and"
      
      for (const segment of segments) {
        // Check if segment contains "and" (case-insensitive)
        const andPattern = /\s+and\s+/i;
        if (andPattern.test(segment)) {
          // Split by "and" and add each part as a separate segment
          const parts = segment.split(andPattern).map(p => p.trim()).filter(p => p.length > 0);
          console.log(`[Bundle] Splitting segment "${segment}" by "and" into:`, parts);
          
          // Mark all resulting parts as coming from splitting
          const startIdx = expandedSegments.length;
          expandedSegments.push(...parts);
          for (let i = startIdx; i < expandedSegments.length; i++) {
            wasSplitFromAnd.add(i);
          }
        } else {
          expandedSegments.push(segment);
        }
      }
      segments = expandedSegments;
      
      console.log(`[Bundle] Final segments after splitting:`, segments);
      console.log(`[Bundle] Segments split by "and" (indices):`, Array.from(wasSplitFromAnd));
      
      // Abstract collection terms that should NOT be treated as bundle items
      const abstractCollectionPatterns = [
        /^(complete|full|entire|whole)\s+(outfit|ensemble|set|kit|bundle|package|collection|combo|combination)$/i,
        /^(outfit|ensemble|set|kit|bundle|package|collection|combo|combination)$/i,
      ];
      
      // Extract meaningful terms from each segment (industry-agnostic)
      if (segments.length >= 2) {
        let currentPos = 0;
        let concreteItemsFound = 0;
        
        for (let segIdx = 0; segIdx < segments.length; segIdx++) {
          const segment = segments[segIdx];
          
          // CRITICAL FIX: Skip segments that contain negative/avoid patterns (industry-agnostic)
          // These should be handled by avoid terms extraction, not bundle item extraction
          // Industry-agnostic examples: "no patterns", "not red", "without logos", "avoid floral", "don't want prints"
          // Works for any industry: "no batteries", "not wireless", "without warranty", "avoid plastic", etc.
          const negativePatterns = [
            /\bno\s+/i,                    // "no X" - any industry
            /\bnot\s+/i,                   // "not X" - any industry
            /\bwithout\s+/i,                // "without X" - any industry
            /\bavoid\s+/i,                 // "avoid X" - any industry
            /\bdon'?t\s+(?:want|like|need|prefer)\s+/i,  // "don't want/like/need/prefer X" - any industry
            /\bexclude\s+/i,               // "exclude X" - any industry
            /\bexcept\s+/i,                // "except X" - any industry (when used as exclusion)
            /\bexcluding\s+/i,             // "excluding X" - any industry
          ];
          const hasNegativePattern = negativePatterns.some(pattern => pattern.test(segment));
          if (hasNegativePattern) {
            // This segment contains negative/avoid patterns - skip it for bundle extraction
            // The avoid terms will be extracted by parseIntentGeneric (industry-agnostic)
            console.log(`[Bundle] Skipping segment "${segment}" - contains negative/avoid patterns`);
            currentPos += segment.length + 10;
            continue;
          }
          
          // CRITICAL FIX: Skip segments that contain preference phrases (industry-agnostic)
          // These express preferences/constraints on the main item, not separate bundle items
          // Industry-agnostic examples: "i want plain", "i need wireless", "looking for organic", "prefer blue"
          // Works for any industry: "i want rechargeable", "i need waterproof", "looking for eco-friendly", etc.
          const segmentLower = segment.toLowerCase().trim();
          const preferencePatterns = [
            /^i\s+(?:want|need|prefer|like)\s+/i,        // "i want X", "i need X", "i prefer X", "i like X" (at start)
            /\b(?:want|need|prefer|like)\s+(?:a|an|the)?\s*\w+/i,  // "want X", "need X", "prefer X", "like X" (anywhere)
            /\blooking\s+for\s+/i,         // "looking for X"
            /^prefer\s+/i,                 // "prefer X" (at start)
            /\bwould\s+like\s+/i,          // "would like X"
            /\bhoping\s+for\s+/i,          // "hoping for X"
            /\bseeking\s+/i,               // "seeking X"
          ];
          const hasPreferencePattern = preferencePatterns.some(pattern => pattern.test(segmentLower));
          if (hasPreferencePattern) {
            // This segment contains preference phrases - skip it for bundle extraction
            // The preference terms will be extracted by parseIntentGeneric as constraints/preferences
            // This prevents "i want plain" from being treated as a bundle item "plain"
            console.log(`[Bundle] Skipping segment "${segment}" - contains preference/constraint patterns`);
            currentPos += segment.length + 10;
            continue;
          }
          
          // Check if segment is an abstract collection term (skip it, but count it for bundle detection)
          let isAbstract = false;
          for (const pattern of abstractCollectionPatterns) {
            if (pattern.test(segment.trim())) {
              isAbstract = true;
              break;
            }
          }
          
          if (isAbstract) {
            // Skip abstract collection terms - they're not actual product items
            // But we still count them as "mentions" for bundle detection
            currentPos += segment.length + 10;
            continue;
          }
          
          // Extract meaningful noun phrases - remove stop words and get core product terms
          // CRITICAL: Clean segment more aggressively to extract only product terms
          let cleaned = segment.toLowerCase().trim();
          
          // Remove common phrases that aren't product terms
          cleaned = cleaned.replace(/\b(give\s+me|i\s+want|i\s+need|looking\s+for|need\s+some|want\s+some|get\s+me|find\s+me)\b/gi, " ");
          cleaned = cleaned.replace(/\b(some|any|few|several|couple|pair|pairs)\b/gi, " ");
          
          const stopWords = new Set(["a", "an", "the", "and", "or", "for", "in", "on", "at", "to", "of", "with", "i", "want", "need", "looking", "go", "my", "give", "me", "get", "find", "some", "any"]);
          const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w) && !/^\d+$/.test(w));
          
          if (words.length > 0) {
            // Use the most significant words (longer words first, up to 2 words for multi-word terms)
            // Filter out abstract terms from the words
            const concreteWords = words.filter(w => {
              const wLower = w.toLowerCase();
              // Filter out abstract collection terms, price/budget terms, and occasion/context terms
              // Occasion/context terms describe when/where/why, not what product (industry-agnostic)
              return !/^(complete|full|entire|whole|outfit|ensemble|set|kit|bundle|package|collection|combo|combination|budget|price|cost|spend|spending|total|maximum|max|under|below|less|up|to|give|me|want|need|looking|get|find|wedding|party|event|occasion|ceremony|meeting|interview|date|dinner|work|office|home|outdoor|indoor|formal|casual|sport|exercise|gym|beach|vacation|travel|business|professional)$/i.test(wLower);
            });
            
            if (concreteWords.length > 0) {
              // Sort by length (longer = more specific) and take up to 2 words max
              // Industry-agnostic: works for any product type
              const significantWords = concreteWords
                .sort((a, b) => b.length - a.length)
                .slice(0, 2); // Max 2 words for multi-word product names (e.g., "yoga mat", "coffee maker", "business suit")
              
              // CRITICAL FIX: If this segment came from splitting by "and", use only the first word
              // This ensures separate items stay separate (e.g., "trousers" and "shirt", not "trousers shirt")
              // Industry-agnostic: applies to any product type (e.g., "mouse" and "keyboard", not "mouse keyboard")
              let term = wasSplitFromAnd.has(segIdx)
                ? significantWords[0] // Segment was split by "and" - use only first word to keep items separate
                : significantWords.join(" ").trim(); // Multi-word product name - use up to 2 words
              
              // Clean punctuation from term (remove trailing periods, commas, etc.)
              term = term.replace(/[.,;:!?]+$/, "").trim();
              
              // Only add if term is not empty and has at least 2 characters
              if (term.length >= 2) {
                foundCategories.push({ term, position: currentPos });
                concreteItemsFound++;
                console.log(`[Bundle] Extracted term from segment "${segment}": "${term}" (wasSplitFromAnd=${wasSplitFromAnd.has(segIdx)})`);
              }
            } else {
              // If all words were filtered out, try to extract at least one meaningful word
              // This prevents 0 candidates when segments only contain abstract terms
              const fallbackWords = words.filter(w => {
                const wLower = w.toLowerCase();
                // Only filter out the most obvious abstract terms and occasion/context terms, keep others
                return !/^(complete|full|entire|whole|outfit|ensemble|set|kit|bundle|package|collection|combo|combination|give|me|want|need|looking|get|find|wedding|party|event|occasion|ceremony|meeting|interview|date|dinner|work|office|home|outdoor|indoor|formal|casual|sport|exercise|gym|beach|vacation|travel|business|professional)$/i.test(wLower);
              });
              
              if (fallbackWords.length > 0) {
                let term = fallbackWords[0]; // Use first non-abstract word
                // Clean punctuation from term
                term = term.replace(/[.,;:!?]+$/, "").trim();
                if (term.length >= 2) {
                  foundCategories.push({ term, position: currentPos });
                  concreteItemsFound++;
                }
              }
            }
          }
          currentPos += segment.length + 10; // Approximate position
        }
        
        // If we found at least 1 concrete item, it's a valid bundle (even if other segments were abstract)
        // This handles cases like "blue suit and a complete outfit" - we extract "blue suit" as the item
        if (concreteItemsFound === 0 && foundCategories.length === 0) {
          // No concrete items found - don't treat as bundle
          foundCategories.length = 0;
        }
      }
    }
  }
  
  // Fallback: If no bundle indicators or generic extraction failed, use category matching
  // This helps with single-item queries or queries without clear separators
  // BUT: Only use this fallback if we have bundle indicators but no items found
  // For true industry-agnostic behavior, we should extract terms generically even without categoryPhrases
  if (foundCategories.length === 0 && hasBundleIndicator) {
    // Try generic extraction one more time with less filtering
    // Extract any meaningful noun phrases from segments (industry-agnostic)
    if (matchingSeparator) {
      const segments = userIntent.split(matchingSeparator).map(s => s.trim()).filter(s => s.length > 0);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const cleaned = segment.toLowerCase().trim();
        const stopWords = new Set(["a", "an", "the", "and", "or", "for", "in", "on", "at", "to", "of", "with", "i", "want", "need", "looking", "for", "go", "my", "to", "go", "with", "the"]);
        const words = cleaned.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w) && !/^\d+$/.test(w));
        
        if (words.length > 0) {
          // Use first 2-3 meaningful words as a term (industry-agnostic)
          const term = words.slice(0, 2).join(" ").trim();
          if (term.length >= 3) {
            foundCategories.push({ term, position: i * 50 }); // Approximate position
          }
        }
      }
    }
    
    // Last resort: use categoryPhrases (but this is less industry-agnostic)
    if (foundCategories.length === 0) {
      for (const phrase of categoryPhrases) {
        const regex = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi");
        let match;
        while ((match = regex.exec(lowerText)) !== null) {
          // Check if it's not part of a soft word
          const before = lowerText.substring(Math.max(0, match.index - 10), match.index);
          const after = lowerText.substring(match.index + match[0].length, Math.min(lowerText.length, match.index + match[0].length + 10));
          const context = (before + " " + after).toLowerCase();
          
          // Skip if it's part of a soft word phrase
          let isSoftWord = false;
          for (const soft of softWords) {
            if (context.includes(soft)) {
              isSoftWord = true;
              break;
            }
          }
          
          if (!isSoftWord) {
            foundCategories.push({ term: phrase, position: match.index });
          }
        }
      }
    }
  }
  
  // Bundle detected if: ≥2 distinct items found (either from categories or extracted segments)
  // CRITICAL FIX: Require at least 2 concrete product items for bundle detection
  // This prevents single-item queries with preferences (e.g., "blue shirt, i want plain") from being treated as bundles
  
  // FINAL GUARD: Filter out items that came from avoid/preference segments
  // Never treat negative constraints ("no X", "without X", "avoid X", "not X") or preference adjectives as bundle items
  const preferenceAdjectives = new Set(["plain", "simple", "classic", "minimal", "basic", "standard", "regular", "normal", "typical", "common", "usual"]);
  const validCategories = foundCategories.filter(cat => {
    const termLower = cat.term.toLowerCase();
    // Filter out preference adjectives
    if (preferenceAdjectives.has(termLower)) {
      return false;
    }
    // Filter out avoid terms (these should be in avoidTerms, not bundle items)
    // Check if the term appears in negative context in the original query
    const termIndex = userIntent.toLowerCase().indexOf(termLower);
    if (termIndex >= 0) {
      const beforeTerm = userIntent.substring(Math.max(0, termIndex - 20), termIndex).toLowerCase();
      const afterTerm = userIntent.substring(termIndex + termLower.length, Math.min(userIntent.length, termIndex + termLower.length + 20)).toLowerCase();
      // Check for negative patterns before/after the term
      if (/\b(no|not|without|avoid|don't|dont|exclude|excluding|except)\s+/i.test(beforeTerm) ||
          /\b(no|not|without|avoid|don't|dont|exclude|excluding|except)\s+/i.test(afterTerm)) {
        return false; // This is an avoid term, not a bundle item
      }
    }
    return true;
  });
  
  const uniqueCategories = Array.from(new Set(validCategories.map(c => c.term)));
  const categoryCounts = new Map<string, number>();
  for (const { term } of validCategories) {
    categoryCounts.set(term.toLowerCase(), (categoryCounts.get(term.toLowerCase()) || 0) + 1);
  }
  const hasRepeatedMentions = Array.from(categoryCounts.values()).some(count => count >= 2);
  
  // Bundle if: (≥2 REAL product items found) AND (bundle indicators present OR repeated mentions)
  // Industry-agnostic: requires at least 2 concrete product items to be a bundle
  // This ensures "blue shirt, i want plain" is NOT treated as a bundle (only 1 product item, "plain" is filtered)
  // But "blue shirt, trousers" IS treated as a bundle (2 product items)
  const isBundle = uniqueCategories.length >= 2 && (hasBundleIndicator || hasRepeatedMentions);

  if (!isBundle) {
    return { isBundle: false, items: [], totalBudget: null, totalBudgetCurrency: null };
  }
  
  // Extract items with quantities and per-item constraints
  const items: Array<{ 
    hardTerms: string[]; 
    quantity: number;
    constraints?: {
      optionConstraints?: { 
        size?: string | null; 
        color?: string | null; 
        material?: string | null;
        allowValues?: Record<string, string[]>; // OR allow-list: attribute -> array of allowed values
      };
      priceCeiling?: number | null;
      userCurrency?: string | null; // User-specified currency (from input)
      includeTerms?: string[];
      excludeTerms?: string[];
    };
  }> = [];
  const seenTerms = new Set<string>();
  
  // Use validCategories (filtered to exclude avoid/preference terms) instead of foundCategories
  for (const { term, position } of validCategories) {
    if (seenTerms.has(term.toLowerCase())) continue;
    seenTerms.add(term.toLowerCase());
    
    // Check for quantity prefix (e.g., "3 piece suit")
    const quantityMatch = lowerText.match(new RegExp(`(\\d+)\\s*(?:piece|pc|pcs)?\\s*${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    const quantity = quantityMatch ? parseInt(quantityMatch[1], 10) : 1;
    
    // Industry-agnostic: use only the exact term, no synonym expansion
    const hardTerms = [term];
    
    // Extract per-item constraints scoped to this item
    // Look for constraints near this item's position in the text
    const itemContextStart = Math.max(0, position - 100);
    const itemContextEnd = Math.min(userIntent.length, position + term.length + 100);
    const itemContext = userIntent.substring(itemContextStart, itemContextEnd);
    const itemContextLower = itemContext.toLowerCase();
    
    // Extract option constraints (size, color, material) scoped to this item
    // Patterns: "suit in size 42", "suit color blue", "suit material cotton"
    const itemConstraints: {
      optionConstraints?: { 
        size?: string | null; 
        color?: string | null; 
        material?: string | null;
        allowValues?: Record<string, string[]>; // OR allow-list: attribute -> array of allowed values
      };
      priceCeiling?: number | null;
      userCurrency?: string | null; // User-specified currency (from input)
      includeTerms?: string[];
      excludeTerms?: string[];
    } = {};
    
    // Extract size constraint scoped to this item (with OR allow-list support)
    const sizePatterns = [
      new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:in\\s+)?size\\s+(.+?)(?:\\s|,|$|\\b)`, "i"),
      new RegExp(`size\\s+(.+?)\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    ];
    
    const sizeMap: Record<string, string> = {
      "xxs": "XXS", "xs": "XS", "small": "Small", "s": "S",
      "medium": "Medium", "m": "M", "large": "Large", "l": "L",
      "xl": "XL", "xxl": "XXL",
    };
    const sizeValues = Object.keys(sizeMap);
    
    // Try to extract OR allow-list for size first
    const sizeAllowList = extractAllowList(itemContext, sizeValues);
    let itemSize: string | null = null;
    if (sizeAllowList && sizeAllowList.length > 0) {
      // Store allow-list in constraints (convert to mapped values)
      const mappedSizeAllowList = sizeAllowList.map(s => {
        const key = s.toLowerCase();
        return sizeMap[key] || s;
      });
      if (!itemConstraints.optionConstraints) {
        itemConstraints.optionConstraints = {};
      }
      if (!itemConstraints.optionConstraints.allowValues) {
        itemConstraints.optionConstraints.allowValues = {};
      }
      itemConstraints.optionConstraints.allowValues.size = mappedSizeAllowList;
      const sourceMatch = itemContext.match(/\b(?:size)?\s*(?:in\s+)?(?:either\s+)?\w+\s+(?:or|\/)\s+\w+/i);
      if (sourceMatch) {
        console.log("[Constraints] allow_list", { attribute: "size", values: mappedSizeAllowList, sourceTextSnippet: sourceMatch[0] });
      }
    } else {
      // Fall back to single value extraction
      for (const pattern of sizePatterns) {
        const match = itemContextLower.match(pattern);
        if (match && match[1]) {
          const sizeValue = match[1].trim();
          // Check for single size value (before "or" or "/")
          const singleSize = sizeValue.split(/\s+(?:or|\/)\s+/i)[0].trim();
          itemSize = sizeMap[singleSize.toLowerCase()] || `Size ${singleSize}`;
          break;
        }
      }
    }
    
    // Extract color constraint scoped to this item (with OR allow-list support)
    const colorPatterns = [
      new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:in\\s+)?(?:color|colour)\\s+(.+?)(?:\\s|,|$|\\b)`, "i"),
      new RegExp(`(?:color|colour)\\s+(.+?)\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    ];
    const colors = ["black", "white", "grey", "gray", "navy", "blue", "green", "red", "pink", "purple",
      "beige", "cream", "brown", "tan", "orange", "yellow", "gold", "silver", "khaki"];
    
    // Try to extract OR allow-list for color first
    const colorAllowList = extractAllowList(itemContext, colors);
    let itemColor: string | null = null;
    if (colorAllowList && colorAllowList.length > 0) {
      // Store allow-list in constraints
      if (!itemConstraints.optionConstraints) {
        itemConstraints.optionConstraints = {};
      }
      if (!itemConstraints.optionConstraints.allowValues) {
        itemConstraints.optionConstraints.allowValues = {};
      }
      itemConstraints.optionConstraints.allowValues.color = colorAllowList;
      const sourceMatch = itemContext.match(/\b(?:color|colour)?\s*(?:in\s+)?(?:either\s+)?\w+\s+(?:or|\/)\s+\w+/i);
      if (sourceMatch) {
        console.log("[Constraints] allow_list", { attribute: "color", values: colorAllowList, sourceTextSnippet: sourceMatch[0] });
      }
    } else {
      // Fall back to single value extraction
      for (const pattern of colorPatterns) {
        const match = itemContextLower.match(pattern);
        if (match && match[1]) {
          const colorValue = match[1].trim().toLowerCase();
          // Check for single color value (before "or" or "/")
          const singleColor = colorValue.split(/\s+(?:or|\/)\s+/i)[0].trim();
          if (colors.includes(singleColor)) {
            itemColor = singleColor[0].toUpperCase() + singleColor.slice(1);
            break;
          }
        }
      }
    }
    
    // Extract material constraint scoped to this item (with OR allow-list support)
    const materialPatterns = [
      new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:in\\s+)?(?:material|fabric)\\s+(.+?)(?:\\s|,|$|\\b)`, "i"),
      new RegExp(`(?:material|fabric)\\s+(.+?)\\s+${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    ];
    const materials = ["cotton", "linen", "silk", "wool", "leather", "denim", "polyester", "viscose", "nylon", "cashmere",
      "spandex", "elastane", "retinol", "hyaluronic acid", "vitamin c", "wood", "metal", "glass", "ceramic", "plastic"];
    
    // Try to extract OR allow-list for material first
    const materialAllowList = extractAllowList(itemContext, materials);
    let itemMaterial: string | null = null;
    if (materialAllowList && materialAllowList.length > 0) {
      // Store allow-list in constraints
      if (!itemConstraints.optionConstraints) {
        itemConstraints.optionConstraints = {};
      }
      if (!itemConstraints.optionConstraints.allowValues) {
        itemConstraints.optionConstraints.allowValues = {};
      }
      itemConstraints.optionConstraints.allowValues.material = materialAllowList;
      const sourceMatch = itemContext.match(/\b(?:material|fabric)?\s*(?:in\s+)?(?:either\s+)?\w+(?:\s+\w+)?\s+(?:or|\/)\s+\w+/i);
      if (sourceMatch) {
        console.log("[Constraints] allow_list", { attribute: "material", values: materialAllowList, sourceTextSnippet: sourceMatch[0] });
      }
    } else {
      // Fall back to single value extraction
      for (const pattern of materialPatterns) {
        const match = itemContextLower.match(pattern);
    if (match && match[1]) {
          const materialValue = match[1].trim().toLowerCase();
          // Check for single material value (before "or" or "/")
          const singleMaterial = materialValue.split(/\s+(?:or|\/)\s+/i)[0].trim();
          if (materials.some(m => singleMaterial.includes(m))) {
            itemMaterial = singleMaterial.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
        break;
          }
        }
      }
    }
    
    // Extract price ceiling scoped to this item (e.g., "suit under $100")
    const itemPriceCeilingResult = parsePriceCeiling(itemContext);
    
    // Build option constraints if any found
    if (itemSize || itemColor || itemMaterial) {
      itemConstraints.optionConstraints = {
        size: itemSize || null,
        color: itemColor || null,
        material: itemMaterial || null,
      };
    }
    
    // Add price ceiling if found (currency handling will be done later)
    if (itemPriceCeilingResult !== null) {
      itemConstraints.priceCeiling = itemPriceCeilingResult.value;
      // Store currency for later conversion if needed
      if (itemPriceCeilingResult.currency) {
        itemConstraints.userCurrency = itemPriceCeilingResult.currency;
      }
    }
    
    // Only add constraints object if it has any constraints
    const itemWithConstraints: {
      hardTerms: string[];
      quantity: number;
      constraints?: typeof itemConstraints;
    } = { hardTerms, quantity };
    
    if (Object.keys(itemConstraints).length > 0) {
      itemWithConstraints.constraints = itemConstraints;
    }
    
    items.push(itemWithConstraints);
  }
  
  // Extract total budget if mentioned using improved numeric constraint parsing
  const totalBudgetResult = parsePriceCeiling(userIntent);
  const totalBudget = totalBudgetResult?.value ?? null;
  const totalBudgetCurrency = totalBudgetResult?.currency ?? null;
  
  // Log bundle detection
  console.log("[Bundle] detected", {
    itemCount: items.length,
    totalBudgetOrCeiling: totalBudget !== null ? totalBudget : "none",
    totalBudgetCurrency: totalBudgetCurrency || "none"
  });
  
  // Log per-item constraints
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.constraints) {
      const constraintsPreview: any = {};
      if (item.constraints.optionConstraints) {
        constraintsPreview.optionConstraints = item.constraints.optionConstraints;
      }
      if (item.constraints.priceCeiling !== undefined && item.constraints.priceCeiling !== null) {
        constraintsPreview.priceCeiling = item.constraints.priceCeiling;
      }
      if (item.constraints.includeTerms && item.constraints.includeTerms.length > 0) {
        constraintsPreview.includeTerms = item.constraints.includeTerms;
      }
      if (item.constraints.excludeTerms && item.constraints.excludeTerms.length > 0) {
        constraintsPreview.excludeTerms = item.constraints.excludeTerms;
      }
      
      console.log("[Bundle] itemConstraints", {
        itemIndex: i,
        label: item.hardTerms[0] || "unknown",
        constraintsPreview
      });
    }
  }
  
  return { isBundle: true, items, totalBudget, totalBudgetCurrency: totalBudgetCurrency || null };
}

function mergeConstraints(a: VariantConstraints, b: VariantConstraints): VariantConstraints {
  // a has priority over b
  // Merge allowValues: a's allowValues take priority, but merge if both exist for same attribute
  const allowValues: Record<string, string[]> = {};
  if (a.allowValues) {
    Object.assign(allowValues, a.allowValues);
  }
  if (b.allowValues) {
    for (const [key, values] of Object.entries(b.allowValues)) {
      if (!allowValues[key]) {
        allowValues[key] = values;
      }
    }
  }
  
  const result: VariantConstraints = {
    size: a.size ?? b.size,
    color: a.color ?? b.color,
    material: a.material ?? b.material,
  };
  
  if (Object.keys(allowValues).length > 0) {
    result.allowValues = allowValues;
  }
  
  return result;
}

type VariantPreferences = Record<string, string>;

function normKey(key: string): string {
  return key.trim().replace(/\s+/g, " ");
}

function equalKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findCanonicalOptionName(rawKey: string, knownOptionNames: string[]): string | null {
  const k = rawKey.trim().toLowerCase();
  for (const name of knownOptionNames) {
    if (name.trim().toLowerCase() === k) return name; // return canonical casing from store
  }

  // lightweight synonyms (industry-friendly)
  const synonyms: Record<string, string[]> = {
    color: ["colour", "shade", "tone"],
    shade: ["colour", "color"],
    size: ["sizing", "pack size", "capacity", "volume"],
    material: ["fabric", "composition"],
  };

  for (const [canonical, alts] of Object.entries(synonyms)) {
    if (k === canonical || alts.includes(k)) {
      for (const name of knownOptionNames) {
        const nn = name.trim().toLowerCase();
        if (nn === canonical || alts.includes(nn)) return name;
      }
    }
  }

  return null;
}

function mergePreferences(primary: VariantPreferences, secondary: VariantPreferences): VariantPreferences {
  // primary wins
  return { ...secondary, ...primary };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePreferencesFromAnswers(answersJson: any, knownOptionNames: string[]): VariantPreferences {
  const root = answersJson?.answers ?? answersJson ?? {};
  const prefs: VariantPreferences = {};

  // Case 1: simple object { Size: "Small", Color: "Green" }
  if (root && typeof root === "object" && !Array.isArray(root)) {
    for (const [rawK, rawV] of Object.entries(root)) {
      if (typeof rawV !== "string" || !rawV.trim()) continue;

      const canonical = findCanonicalOptionName(String(rawK), knownOptionNames);
      if (!canonical) continue;

      prefs[normKey(canonical)] = rawV.trim();
    }
  }

  // Case 2: array answers [{ question, answer }] (best-effort)
  if (Array.isArray(root)) {
    for (const item of root) {
      const label =
        (typeof item?.question === "string" && item.question) ||
        (typeof item?.label === "string" && item.label) ||
        (typeof item?.name === "string" && item.name);

      const value =
        (typeof item?.answer === "string" && item.answer) ||
        (typeof item?.value === "string" && item.value) ||
        (typeof item?.selected === "string" && item.selected);

      if (!label || !value) continue;

      const canonical = findCanonicalOptionName(label, knownOptionNames);
      if (!canonical) continue;

      prefs[normKey(canonical)] = value.trim();
    }
  }

  return prefs;
}

function parsePreferencesFromText(text: string, knownOptionNames: string[]): VariantPreferences {
  const prefs: VariantPreferences = {};
  const t = (text || "").trim();
  if (!t) return prefs;

  // Try "OptionName: value" / "OptionName=value" / "OptionName value"
  for (const optionName of knownOptionNames) {
    const re = new RegExp(
      `\\b${escapeRegExp(optionName)}\\b\\s*(?:[:=]|is|in)?\\s*([A-Za-z0-9][A-Za-z0-9 &/\\-]{0,30})`,
      "i"
    );
    const m = t.match(re);
    if (m?.[1]) prefs[normKey(optionName)] = m[1].trim();
  }

  // Fallback: keep Patch 2's size/color/material inference (optional)
  // If you already have parseConstraintsFromText(), reuse it:
  // - map size->Size, color->Color, material->Material if those option names exist.
  return prefs;
}

/**
 * Unified handler for session/start route
 * @param args - React Router LoaderFunctionArgs or ActionFunctionArgs
 */
export async function appProxySessionStart(
  args: { request: Request }
): Promise<Response> {
  const { request } = args;
  const routePath = "/session/start";
  
  if (request.method === "GET" || request.method === "HEAD") {
    return proxySessionStartLoader(request, routePath);
  }
  
  if (request.method === "OPTIONS") {
    return proxySessionStartOptions(request, routePath);
  }
  
  // POST request
  return proxySessionStartAction(request, routePath);
}

/**
 * Shared loader function for session/start endpoint
 * @param request - The incoming request
 * @param routePath - The route path for logging (e.g., "/apps/editmuse/session/start" or "/session/start")
 */
export async function proxySessionStartLoader(
  request: Request,
  routePath: string
): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams;
  const shopDomain = getShopFromAppProxy(query) || query.get("shop") || undefined;

  return withProxyLogging(
    async () => {
      return Response.json({ 
        ok: true, 
        route: "session/start",
        method: request.method,
        pathname: url.pathname,
        note: "This endpoint requires POST. Use POST to start a session or fetch questions.",
        troubleshooting: "If POST requests return 404, check Shopify app proxy configuration in Partners dashboard."
      });
    },
    request,
    routePath,
    shopDomain
  );
}

/**
 * Shared OPTIONS handler for CORS preflight
 * @param request - The incoming request
 * @param routePath - The route path for logging
 */
export async function proxySessionStartOptions(
  request: Request,
  routePath: string
): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams;
  const shopDomain = getShopFromAppProxy(query) || query.get("shop") || undefined;

  return withProxyLogging(
    async () => {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    },
    request,
    routePath,
    shopDomain
  );
}

/**
 * Shared action function for session/start endpoint
 * @param request - The incoming request
 * @param routePath - The route path for logging (e.g., "/apps/editmuse/session/start" or "/session/start")
 */
export async function proxySessionStartAction(
  request: Request,
  routePath: string
): Promise<Response> {
  console.log("[App Proxy] ========== POST REQUEST RECEIVED ==========");
  console.log(`[App Proxy] POST ${routePath}`);
  console.log("[App Proxy] Request URL:", request.url);
  console.log("[App Proxy] Request method:", request.method);
  console.log("[App Proxy] Request headers:", Object.fromEntries(request.headers.entries()));

  if (request.method !== "POST") {
    console.log("[App Proxy] Method not allowed:", request.method);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const query = url.searchParams;
  console.log("[App Proxy] Query params:", {
    shop: query.get("shop"),
    signature: query.has("signature") ? "present" : "missing",
    timestamp: query.get("timestamp"),
  });

  // Parse JSON body early to determine if this is a question-only request
  let body;
  try {
    body = await request.json();
  } catch (error) {
    console.error("[App Proxy] Failed to parse JSON body:", error);
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { experienceId, clientRequestId } = body;
  let answers = body.answers;
  const messages = (body as any).messages; // Conversation messages (for chat mode)
  // NOTE: resultCount is ignored - Experience.resultCount is the ONLY source of truth
  const bodyResultCount = (body as any).resultCount; // Only for logging
  
  // Log answers preview (first 200 chars) for debugging - safe substring
  let answersPreview = "none";
  try {
    if (answers !== undefined && answers !== null) {
      if (Array.isArray(answers)) {
        const jsonStr = JSON.stringify(answers);
        answersPreview = `array[${answers.length}]: ${jsonStr.substring(0, Math.min(200, jsonStr.length))}`;
      } else if (typeof answers === "string") {
        answersPreview = `string: ${answers.substring(0, Math.min(200, answers.length))}`;
      } else {
        const str = String(answers);
        answersPreview = `other: ${str.substring(0, Math.min(200, str.length))}`;
      }
    }
  } catch (e) {
    answersPreview = "error_logging";
  }
  
  console.log("[App Proxy] Request body:", {
    experienceId,
    bodyResultCount, // Log only, not used
    hasAnswers: !!answers,
    answersPreview, // Show what answers were provided
    clientRequestId,
  });

  // For question-only requests (no answers), signature validation is optional
  // This allows storefront JavaScript to fetch questions directly
  const hasAnswers = answers !== undefined && answers !== null && 
    ((Array.isArray(answers) && answers.length > 0) || (typeof answers === "string" && answers.trim() !== ""));
  const isQuestionOnlyRequest = !hasAnswers;

  // Validate HMAC signature (required for session creation, optional for question fetching)
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const hasSignature = query.has("signature");
  
  let shopDomain: string | null = null;
  
  if (hasSignature) {
    const isValid = validateAppProxySignature(query, secret);
    console.log("[App Proxy] Signature validation:", isValid ? "PASSED" : "FAILED");

    if (!isValid) {
      if (isQuestionOnlyRequest) {
        console.log("[App Proxy] Invalid signature for question-only request - attempting to continue with experienceId");
        // For question-only requests, try to get shop from experienceId instead (below)
      } else {
        console.log("[App Proxy] Invalid signature - returning 401");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }
    } else {
      // Signature is valid, get shop from query
      shopDomain = getShopFromAppProxy(query);
    }
  } else {
    console.log("[App Proxy] No signature in query - this is okay for question-only requests");
  }

  // If we don't have shop domain yet, try to get it from experienceId (especially for question-only requests)
  if (!shopDomain && experienceId) {
    try {
      const experience = await prisma.experience.findUnique({
        where: { id: experienceId },
        include: { shop: true },
      });
      if (experience?.shop?.domain) {
        shopDomain = experience.shop.domain;
        console.log("[App Proxy] Got shop domain from experience:", shopDomain);
      }
    } catch (error) {
      console.error("[App Proxy] Error fetching experience for shop domain:", error);
    }
  }

  // For question-only requests without shop domain, get shop from experience
  if (!shopDomain && experienceId) {
    try {
      const experience = await prisma.experience.findUnique({
        where: { id: experienceId },
        include: { shop: true },
      });
      if (experience?.shop?.domain) {
        shopDomain = experience.shop.domain;
        console.log("[App Proxy] Determined shop domain from experience:", shopDomain);
      }
    } catch (error) {
      console.error("[App Proxy] Error fetching experience for shop domain:", error);
    }
  }

  // For question-only requests without shop domain, get shop from experience first
  if (!shopDomain && isQuestionOnlyRequest && experienceId) {
    try {
      const experienceForShop = await prisma.experience.findUnique({
        where: { id: experienceId },
        include: { shop: true },
      });
      if (experienceForShop?.shop?.domain) {
        shopDomain = experienceForShop.shop.domain;
        console.log("[App Proxy] Got shop domain from experience for question-only request:", shopDomain);
      }
    } catch (error) {
      console.error("[App Proxy] Error fetching experience for shop domain:", error);
    }
  }

  // If we still don't have shop domain, we can't proceed
  if (!shopDomain) {
    console.log("[App Proxy] Cannot determine shop domain - returning error");
    return Response.json({ error: "Cannot determine shop domain. Please provide shop parameter or valid experienceId." }, { status: 400 });
  }

  console.log("[App Proxy] Shop domain:", shopDomain);

  // Upsert shop (create if doesn't exist, but don't create infinite new shops)
  // At this point shopDomain is guaranteed to be non-null
  const shop = await prisma.shop.upsert({
    where: { domain: shopDomain },
    create: {
      domain: shopDomain,
      accessToken: "", // Placeholder - should be set via OAuth
    },
    update: {},
  });

  // Idempotency check: if clientRequestId exists, check for existing session
  // NOTE: After schema change, run: npx prisma db push && npx prisma generate
  if (clientRequestId && typeof clientRequestId === "string" && clientRequestId.trim() !== "") {
    const existing = await prisma.conciergeSession.findFirst({
      where: { shopId: shop.id, clientRequestId: clientRequestId.trim() } as any,
      include: { result: true },
    });
    
    if (existing) {
      console.log("[App Proxy] Idempotency hit - returning existing session", { clientRequestId: clientRequestId.trim(), sessionId: existing.publicToken, status: existing.status });
      
      // Build response with existing session data
      const responseData: any = {
        ok: true,
        sid: existing.publicToken,
        sessionId: existing.publicToken, // Keep for backward compatibility
        status: existing.status === ConciergeSessionStatus.COMPLETE ? "COMPLETE" : 
                existing.status === ConciergeSessionStatus.FAILED ? "ERROR" : "PENDING",
        resultCount: existing.resultCount || 8,
        idempotent: true,
      };
      
      // If COMPLETE and result exists, include handles/reasoning
      if (existing.status === ConciergeSessionStatus.COMPLETE && existing.result) {
        const productHandles = Array.isArray(existing.result.productHandles) 
          ? existing.result.productHandles 
          : (typeof existing.result.productHandles === "string" ? JSON.parse(existing.result.productHandles) : []);
        responseData.productHandles = productHandles;
        responseData.reasoning = existing.result.reasoning || null;
      }
      
      // Return immediately (don't start duplicate processing)
      return Response.json(responseData);
    }
  }

  let experience;
  let experienceIdUsed: string;
  let wasDefaultCreated = false;
  let experienceIdSource: string;

  // If experienceId provided, try to use it
  if (experienceId) {
    experienceIdSource = "provided";
    console.log("[App Proxy] ExperienceId provided in request:", experienceId);
    experience = await prisma.experience.findFirst({
      where: {
        id: experienceId,
        shopId: shop.id,
      },
    });

    if (!experience) {
      console.log("[App Proxy] Provided experienceId not found or does not belong to shop, falling back to default experience");
      experienceIdSource = "fallback_to_default";
      // Fall through to fallback logic - DO NOT return 404
    } else {
      console.log("[App Proxy] Using provided experienceId:", experienceId, "name:", experience.name);
    }
  } else {
    experienceIdSource = "missing_using_default";
    console.log("[App Proxy] No experienceId provided in request, using default experience");
  }

  // Fallback: if no experienceId provided OR provided one was invalid
  if (!experience) {
    // Try default experience
    console.log("[App Proxy] Looking for shop's default experience (isDefault = true)");
    experience = await prisma.experience.findFirst({
      where: {
        shopId: shop.id,
        isDefault: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    // If no default exists, create one with sensible defaults
    if (!experience) {
      console.log("[App Proxy] No default experience found, creating new default experience");
      
      // Sensible default questions matching the JS fallback
      const defaultQuestionsJson = JSON.stringify([
        {
          type: "text",
          question: "What are you looking for?",
          placeholder: "e.g., A casual outfit for the weekend"
        },
        {
          type: "select",
          question: "What's your budget range?",
          options: [
            { value: "under-50", label: "Under $50" },
            { value: "50-100", label: "$50 - $100" },
            { value: "100-200", label: "$100 - $200" },
            { value: "200-500", label: "$200 - $500" },
            { value: "500-plus", label: "$500+" }
          ]
        },
        {
          type: "text",
          question: "Any specific preferences?",
          placeholder: "e.g., Prefer sustainable materials, specific colors, sizes..."
        }
      ]);

      experience = await prisma.experience.create({
        data: {
          shopId: shop.id,
          name: "Default Concierge",
          mode: "hybrid",
          resultCount: 8,
          includedCollections: "[]",
          excludedTags: "[]",
          inStockOnly: false,
          isDefault: true,
          questionsJson: defaultQuestionsJson,
        },
      });
      
      wasDefaultCreated = true;
      console.log("[App Proxy] ✅ Created default experience:", experience.id, "with", JSON.parse(defaultQuestionsJson).length, "default questions");
    } else {
      console.log("[App Proxy] Found existing default experience:", experience.id, "name:", experience.name);
    }
  }

  experienceIdUsed = experience.id;
  console.log("[App Proxy] ✅ FINAL: Using experienceId:", experienceIdUsed, "| Source:", experienceIdSource, "| Was default created:", wasDefaultCreated, "| Name:", experience.name);

  // Experience.resultCount is the ONLY source of truth for number of results
  const finalResultCount = Number(experience.resultCount ?? 8);
  console.log("[ResultCount] chosen=", finalResultCount, "ignoredBody=", bodyResultCount, "experienceId=", experienceIdUsed);

  // Validate and determine mode (must be quiz/chat/hybrid, fallback to hybrid)
  const validModes = ["quiz", "chat", "hybrid"];
  const modeUsed = validModes.includes(experience.mode) ? experience.mode : "hybrid";
  console.log("[App Proxy] Using mode:", modeUsed);

  // Parse and return questions for the experience (always do this)
  let questions: any[] = [];
  try {
    const questionsJson = (experience as any).questionsJson || "[]";
    console.log("[App Proxy] Parsing questionsJson (length:", questionsJson.length, "chars)");
    questions = JSON.parse(questionsJson);
    if (!Array.isArray(questions)) {
      console.warn("[App Proxy] questionsJson is not an array, got:", typeof questions);
      questions = [];
    }
    
    console.log("[App Proxy] Parsed", questions.length, "questions from JSON");
    
    // Log questions count for chat mode
    if (modeUsed === "chat") {
      console.log("[Experience] chat_mode_questions_count=" + questions.length);
    }
    
    // Normalize questions format: use "question" field, ensure select options have {value, label}
    questions = questions.map((q: any) => {
      const normalized: any = { ...q };
      
      // Normalize "prompt" to "question" for backward compatibility
      if (normalized.prompt && !normalized.question) {
        normalized.question = normalized.prompt;
        delete normalized.prompt;
      }
      
      // Normalize type: single_select -> select
      if (normalized.type === "single_select") {
        normalized.type = "select";
      }
      
      // Normalize select options to {value, label} format
      if (normalized.type === "select" && normalized.options && Array.isArray(normalized.options)) {
        normalized.options = normalized.options.map((opt: any) => {
          if (typeof opt === "string") {
            return { value: opt, label: opt };
          }
          if (typeof opt === "object" && opt.value !== undefined) {
            return { value: String(opt.value), label: String(opt.label || opt.value) };
          }
          return { value: String(opt), label: String(opt) };
        });
      }
      
      return normalized;
    });
    
    console.log("[App Proxy] After normalization:", questions.length, "questions");
  } catch (e) {
    console.error("[App Proxy] Failed to parse questionsJson:", e);
    questions = [];
  }
  
  // Log final questions array
  console.log("[App Proxy] Final questions array length:", questions.length);
  if (questions.length > 0) {
    console.log("[App Proxy] First question:", JSON.stringify(questions[0]).substring(0, 100));
  }

  // Get entitlements early for billing info (needed in both early return and full processing)
  // Wrap in try-catch to ensure questions are returned even if billing fails
  let entitlements;
  try {
    entitlements = await getEntitlements(shop.id);
  } catch (error) {
    console.error("[App Proxy] Error getting entitlements (non-blocking):", error);
    // Use default entitlements if billing check fails (TRIAL plan defaults)
    entitlements = {
      planTier: "TRIAL" as const,
      includedCreditsX2: 0,
      addonCreditsX2: 0,
      usedCreditsX2: 0,
      totalCreditsX2: 0,
      remainingX2: 0,
      experiencesLimit: 1,
      candidateCap: 100,
      canBasicReporting: true,
      canMidReporting: false,
      canAdvancedReporting: false,
      overageRatePerCredit: 0.12,
      showTrialBadge: true,
    };
  }

  // Check if answers are provided - if not, just return questions without creating a session
  // Exception: chat mode with 0 questions can start session with empty answers
  // Note: hasAnswers was already calculated earlier as isQuestionOnlyRequest = !hasAnswers
  const isChatModeWithZeroQuestions = modeUsed === "chat" && questions.length === 0;
  
  if (!hasAnswers && !isChatModeWithZeroQuestions) {
    console.log("[App Proxy] No answers provided - returning questions only");

    console.log("[App Proxy] Returning questions-only response:", {
      ok: true,
      experienceIdUsed,
      modeUsed,
      finalResultCount: finalResultCount,
      questionsCount: questions.length,
      planTier: entitlements.planTier,
    });
    
    return Response.json({
      ok: true,
      experienceIdUsed: experienceIdUsed,
      modeUsed: modeUsed,
      finalResultCount: finalResultCount,
      questions: questions, // Always return array, even if empty
      billing: {
        planTier: entitlements.planTier,
        candidateCap: entitlements.candidateCap,
        creditsBurned: null,
        overageCredits: 0,
        showTrialBadge: entitlements.showTrialBadge,
      },
    });
  }
  
  // For chat mode with 0 questions, allow empty answers
  if (isChatModeWithZeroQuestions && !hasAnswers) {
    console.log("[App Proxy] Chat mode with 0 questions - allowing session start with empty answers");
    // Set answers to empty array for processing
    answers = [];
  }

  // CRITICAL FIX: Check if both answersJson and conversation messages are empty
  // If so, do NOT create a session - return early with NO_QUERY status
  const hasMessages = messages !== undefined && messages !== null && 
    ((Array.isArray(messages) && messages.length > 0) || (typeof messages === "string" && messages.trim() !== ""));
  const answersJsonCheck = Array.isArray(answers) 
    ? (answers.length === 0 || answers.every(a => !a || (typeof a === "string" && a.trim() === "")))
    : (typeof answers === "string" ? answers.trim() === "" : !answers);
  
  if (answersJsonCheck && !hasMessages) {
    console.log("[App Proxy] NO_QUERY detected - answersJson empty AND conversation messages empty - returning early without creating session");
    console.log("[App Proxy] No billing, no Shopify fetch, no AI calls, no DB writes");
    
    return Response.json({
      ok: true,
      status: "NO_QUERY",
      sid: null,
      sessionId: null,
      questions: questions, // Still return questions for UI
      experienceIdUsed: experienceIdUsed,
      modeUsed: modeUsed,
      finalResultCount: finalResultCount,
    });
  }

  // Answers or messages provided - proceed with session creation and result processing
  console.log("[App Proxy] Answers or messages provided - creating session and processing");

  // Block access if subscription is cancelled or trial expired
  if (entitlements.planTier === "TRIAL" && !entitlements.showTrialBadge) {
    // If planTier is TRIAL but trial has expired (showTrialBadge is false), block access
    return Response.json({
      ok: false,
      error: "Subscription required to use EditMuse. Please subscribe via the app admin.",
      errorCode: "SUBSCRIPTION_REQUIRED",
    }, { status: 403 });
  }

  // Calculate dynamic AI window - SMALL-FIRST approach
  // Single-item: 20 candidates for first AI attempt (was 40)
  // Bundle: 15 per item for first AI attempt (was 25)
  // Pre-AI gating/ranking still uses larger pools for quality
  // No hard terms: max 30 candidates (was 60)
  const singleItemWindow = 40; // For top-up and other uses
  const SINGLE_ITEM_AI_WINDOW = 20; // Small-first: first AI attempt only
  const MAX_BUNDLE_PRE_AI_PER_ITEM = 60; // Max candidates per item for bundle mode pre-AI gating/ranking
  const MAX_BUNDLE_AI_PER_ITEM = 15; // Small-first: first AI attempt only (was 25)
  const noHardTermsWindow = 30;
  const baseAiWindow = Math.min(entitlements.candidateCap, singleItemWindow);
  
  // Parse intent early to check for hardTerms (before actual parsing, we'll adjust after intent parsing)
  // For now, calculate base window, then adjust after intent parsing
  let aiWindow = baseAiWindow;
  console.log("[App Proxy] Base AI window:", aiWindow, "(singleItemWindow:", singleItemWindow, ", candidateCap:", entitlements.candidateCap, ")");

  // Store answers as JSON
  const answersJson = Array.isArray(answers) 
    ? JSON.stringify(answers) 
    : (typeof answers === "string" ? answers : "[]");
  
  try {
    console.log("[App Proxy] Storing answers as JSON:", {
      answersLength: Array.isArray(answers) ? answers.length : (typeof answers === "string" ? answers.length : 0),
      answersJsonLength: answersJson.length,
      answersJsonPreview: answersJson.substring(0, Math.min(200, answersJson.length)),
      isEmpty: answersJson === "[]" || answersJson.trim() === "",
    });
  } catch (e) {
    // Logging error - non-critical, continue
    console.log("[App Proxy] Storing answers as JSON (logging error)");
  }

  // Create session with PROCESSING status (will be updated to COMPLETE/FAILED by background processing)
  const sessionToken = await createConciergeSession({
    shopId: shop.id,
    experienceId: experience.id,
    resultCount: finalResultCount,
    answersJson,
    clientRequestId: clientRequestId && typeof clientRequestId === "string" ? clientRequestId.trim() : null,
  });

  // CRITICAL: Save answers as conversation messages for all modes (Quiz, Hybrid, Chat)
  // This ensures conversation context is available for AI ranking in all modes
  // For Quiz mode: answers are question-answer pairs
  // For Hybrid mode: quiz answers + chat messages
  // For Chat mode: chat messages only (may already be saved via /session/message endpoint)
  if (Array.isArray(answers) && answers.length > 0) {
    try {
      const session = await prisma.conciergeSession.findUnique({
        where: { publicToken: sessionToken },
        select: { id: true }
      });
      
      if (session) {
        // Save each answer as a USER message
        // This creates conversation history for Quiz and Hybrid modes
        // Chat mode messages may already exist, but this ensures all answers are captured
        for (const answer of answers) {
          if (answer !== null && answer !== undefined) {
            const answerText = typeof answer === "string" 
              ? answer.trim() 
              : (answer.question && answer.answer 
                  ? `${answer.question}: ${answer.answer}`.trim()
                  : String(answer).trim());
            
            if (answerText.length > 0) {
              try {
                await addConciergeMessage({
                  sessionToken,
                  role: ConciergeRole.USER,
                  text: answerText,
                  imageUrl: null,
                });
              } catch (msgError) {
                // Non-critical: log but continue (message might already exist in chat mode)
                console.log(`[App Proxy] Could not save answer as message (non-critical):`, msgError instanceof Error ? msgError.message : String(msgError));
              }
            }
          }
        }
        
        console.log(`[App Proxy] Saved ${answers.length} answers as conversation messages for mode: ${modeUsed}`);
      }
    } catch (error) {
      // Non-critical: conversation context enhancement failed, but answersJson still works
      console.log(`[App Proxy] Could not save answers as messages (non-critical, will use answersJson fallback):`, error instanceof Error ? error.message : String(error));
    }
  }

  // CRITICAL: Ensure messages are committed to database before starting background processing
  // This prevents race condition where background processing starts before messages are saved
  // Small delay to ensure database commit completes (messages are saved asynchronously)
  await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay to ensure DB commit

  // Update status to PROCESSING immediately
  await prisma.conciergeSession.update({
    where: { publicToken: sessionToken },
    data: { status: ConciergeSessionStatus.PROCESSING },
  });

  // Track usage: session started
  await trackUsageEvent(shop.id, "SESSION_STARTED" as UsageEventType, {
    sessionToken,
    experienceId: experience.id,
    resultCount: finalResultCount,
  });

  console.log("[App Proxy] Session created:", sessionToken, "mode:", modeUsed, "experienceId:", experienceIdUsed);
  console.log("[App Proxy] Returning PENDING immediately", { sid: sessionToken, resultCount: finalResultCount });

  // Start background processing asynchronously
  setImmediate(async () => {
    const startTime = Date.now();
    console.log("[App Proxy] Background processing started", { sid: sessionToken });
    
    try {
      await processSessionInBackground({
        sessionToken,
        shop,
        shopDomain,
        experience,
        experienceIdUsed,
        finalResultCount,
        answersJson,
        includedCollections: JSON.parse(experience.includedCollections || "[]") as string[],
        excludedTags: JSON.parse(experience.excludedTags || "[]") as string[],
        entitlements,
        modeUsed,
        baseAiWindow: Math.min(entitlements.candidateCap, 40), // Single-item window
      });
      
      const durationMs = Date.now() - startTime;
      console.log("[App Proxy] Background processing completed", { sid: sessionToken, durationMs });
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      console.error("[App Proxy] Background processing failed", { sid: sessionToken, durationMs, error: error instanceof Error ? error.message : String(error) });
      
      // Mark session as FAILED
      await prisma.conciergeSession.update({
        where: { publicToken: sessionToken },
        data: { status: ConciergeSessionStatus.FAILED },
      }).catch(() => {});
      
      // Save error result
      await saveConciergeResult({
        sessionToken,
        productHandles: [],
        productIds: null,
        reasoning: error instanceof Error ? error.message : "Error processing request. Please try again.",
      }).catch(() => {});
    }
  });

  // Return immediately with PENDING status - processing will happen in background
  return Response.json({
    ok: true,
    sid: sessionToken,
    sessionId: sessionToken, // Keep for backward compatibility
    status: "PENDING",
    resultCount: finalResultCount,
  });
}

/**
 * Background processing function - runs the full pipeline asynchronously
 * NOTE: Billing is NOT performed here - will be handled separately
 */
async function processSessionInBackground({
  sessionToken,
  shop,
  shopDomain,
  experience,
  experienceIdUsed,
  finalResultCount,
  answersJson,
  includedCollections,
  excludedTags,
  entitlements,
  modeUsed,
  baseAiWindow,
}: {
  sessionToken: string;
  shop: { id: string; domain: string };
  shopDomain: string;
  experience: any;
  experienceIdUsed: string;
  finalResultCount: number;
  answersJson: string;
  includedCollections: string[];
  excludedTags: string[];
  entitlements: any;
  modeUsed: string;
  baseAiWindow: number;
}): Promise<void> {
  // Track total processing duration for safety clamp
  const processStartTime = performance.now();

    // Fetch conversation messages for full context
    // CRITICAL: Retry fetching messages if none found (handles race condition where messages are still being saved)
    let session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' } // Order by creation time for conversation flow
      }
    }
  });

  // If no messages found, wait a bit and retry (handles race condition)
  if (!session?.messages || session.messages.length === 0) {
    console.log(`[Conversation] No messages found on first fetch, waiting 200ms and retrying...`);
    await new Promise(resolve => setTimeout(resolve, 200));
    session = await prisma.conciergeSession.findUnique({
      where: { publicToken: sessionToken },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
  }

  // Format conversation messages for OpenAI (industry-agnostic)
  type ConversationMessage = { role: "system" | "user" | "assistant"; content: string };
  const conversationMessages: ConversationMessage[] = [];
  
  if (session?.messages && session.messages.length > 0) {
    // Add conversation messages (DO NOT add system message here - it will be added in rankProductsWithAI)
    // This ensures the system prompt is properly combined with conversation context
    for (const msg of session.messages) {
      if (!msg.text || msg.text.trim().length === 0) continue;
      
      // Map ConciergeRole to OpenAI role
      let role: "user" | "assistant" = "user";
      if (msg.role === "ASSISTANT" || msg.role === "SYSTEM") {
        role = "assistant";
      }
      
      conversationMessages.push({
        role,
        content: msg.text.trim()
      });
    }
    
    console.log(`[Conversation] ✅ Loaded ${conversationMessages.length} messages (${session.messages.length} from DB) for AI ranking`);
    if (conversationMessages.length > 0) {
      const preview = conversationMessages.slice(0, 3).map(m => {
        const content = m.content || "";
        return `${m.role}: ${content.substring(0, 50)}${content.length > 50 ? "..." : ""}`;
      });
      console.log(`[Conversation] Message preview:`, preview);
    }
  } else {
    console.log(`[Conversation] ⚠️  No conversation messages found - will use answersJson fallback`);
  }

  // Parse answers from JSON (fallback for backward compatibility)
  let answers: any[] = [];
  try {
    const parsed = JSON.parse(answersJson);
    answers = Array.isArray(parsed) ? parsed : (typeof parsed === "string" ? [parsed] : []);
  } catch (e) {
    console.error("[App Proxy] Failed to parse answersJson in background processing:", e);
  }
  
  // If we have conversation messages but no answers, extract from conversation
  if (conversationMessages.length > 0 && answers.length === 0) {
    const userMessages = conversationMessages.filter(m => m.role === "user");
    answers = userMessages.map(m => m.content);
    console.log(`[Conversation] Extracted ${answers.length} user messages from conversation`);
  }

  // BUG FIX #1: Early return for empty chat requests (no query, no answers, no messages)
  // If conversation messages are empty AND answersJson is empty -> save NO_QUERY result
  if (conversationMessages.length === 0 && answers.length === 0) {
    console.log(`[App Proxy] NO_QUERY detected - conversation messages empty and answersJson empty - returning early`);
    
    await saveConciergeResult({
      sessionToken,
      productHandles: [],
      productIds: null,
      reasoning: "No query provided. Please enter a search term or question.",
    });
    
    await prisma.conciergeSession.update({
      where: { publicToken: sessionToken },
      data: { status: ConciergeSessionStatus.COMPLETE },
    });
    
    console.log("[App Proxy] NO_QUERY result saved - session marked COMPLETE with 0 products (no Shopify fetch, no AI ranking, no billing)");
    return; // Exit early - DO NOT fetch products, DO NOT call AI ranking, DO NOT bill
  }

  // Parse answers to extract price/budget range if present
  // Industry-agnostic: supports per-item budgets in bundle mode, most restrictive for single-item
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  let userCurrency: string | null = null; // Track user-specified currency from answers
  const detectedBudgets: Array<{ min: number | null; max: number | null; currency: string | null; source: string }> = []; // Track all detected budgets
  
  // Issue 2/3 fix: Initialize per-item budgets array early (before global budget resolution)
  // This will be populated from conversation messages and answers array
  const perItemBudgets: Array<{ itemType: string; itemTerms: string[]; min: number | null; max: number | null; currency: string | null; source: string }> = [];
  
  // Helper to extract meaningful item terms from text (industry-agnostic)
  // Removes stopwords and extracts nouns/meaningful phrases before budget indicators
  function extractItemTerms(text: string): string[] {
    const stopwords = new Set([
      "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
      "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had", "do", "does", "did",
      "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those",
      "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
      "what", "which", "who", "whom", "where", "when", "why", "how", "if", "then", "else",
      "about", "above", "after", "before", "below", "between", "during", "through", "under", "over",
      "up", "down", "out", "off", "away", "back", "here", "there", "where", "everywhere", "nowhere",
      "some", "any", "all", "both", "each", "every", "few", "many", "most", "other", "such",
      "no", "not", "none", "nothing", "nobody", "nowhere", "never", "neither", "nor",
      "less", "than", "more", "most", "least", "fewer", "greater"
    ]);
    
    // Remove budget-related words
    const budgetWords = new Set(["for", "less", "than", "then", "under", "over", "above", "below", "plus", "and", "or"]);
    
    // Tokenize and filter
    const tokens = text.toLowerCase()
      .split(/\s+/)
      .map(t => t.replace(/[^\w]/g, ""))
      .filter(t => t.length >= 2 && !stopwords.has(t) && !budgetWords.has(t) && !/^\d+$/.test(t));
    
    // Extract meaningful phrases (2-3 word combinations that might be product types)
    const phrases: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      // Single meaningful token (3+ chars, not a number)
      if (tokens[i].length >= 3) {
        phrases.push(tokens[i]);
      }
      // Two-word phrase
      if (i < tokens.length - 1 && tokens[i].length >= 2 && tokens[i + 1].length >= 2) {
        phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
      }
      // Three-word phrase (for compound product types)
      if (i < tokens.length - 2 && tokens[i].length >= 2 && tokens[i + 1].length >= 2 && tokens[i + 2].length >= 2) {
        phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
      }
    }
    
    // Return unique phrases, prioritizing shorter ones first
    return Array.from(new Set(phrases)).sort((a, b) => a.length - b.length);
  }
  
  // Issue 2/3 fix: Parse per-item budgets from answers array BEFORE global budget resolution
  // This handles cases like ["Suit", "Black", "100-250", "Any", "And Shirt For Less Than $50"]
  // where "100-250" should be treated as a per-item budget for the suit, not a global budget
  // Industry-agnostic: Uses quiz question metadata to map budgets to items
  // CRITICAL: This must happen BEFORE global budget resolution (line 3798) so perItemBudgets is populated
  if (Array.isArray(answers) && answers.length > 0) {
    // Parse questionsJson to get question metadata (industry-agnostic)
    let questions: Array<{ type?: string; question?: string; options?: Array<{ value?: string; label?: string }> }> = [];
    try {
      if (experience.questionsJson && typeof experience.questionsJson === "string") {
        questions = JSON.parse(experience.questionsJson);
      } else if (Array.isArray(experience.questionsJson)) {
        questions = experience.questionsJson;
      }
    } catch (e) {
      console.warn("[Budget] Failed to parse questionsJson for budget mapping:", e);
    }
    
    // Check if this looks like a bundle query (multiple items mentioned)
    const answersText = answers.join(" ").toLowerCase();
    const likelyBundleFromAnswers = /\b(and|&|,)\s+\w+/i.test(answersText) || 
                                    answers.some((a: any) => typeof a === "string" && /\b(and|&|,)\s+\w+/i.test(String(a)));
    
    // If bundle-like, try to parse per-item budgets from answers using question metadata
    if (likelyBundleFromAnswers) {
      // Look for range patterns that might be per-item (e.g., "100-250" for first item)
      for (let i = 0; i < answers.length; i++) {
        const answerStr = String(answers[i]).trim();
        
        // Check if this answer is a range (e.g., "100-250", "100 to 250", "100 and 250") and might be item-specific
        const rangeMatch = answerStr.match(/^\$?(\d+)[\s\-]+(?:to|and|-)?\s*\$?(\d+)$/i);
        if (rangeMatch) {
          const minAmount = parseFloat(rangeMatch[1]);
          const maxAmount = parseFloat(rangeMatch[2]);
          
          // Industry-agnostic: Try to find the item type using question metadata
          // Look for the question that corresponds to this answer index
          let itemType: string | null = null;
          const itemTerms: string[] = [];
          
          // Strategy 1: Check if this question is a budget question (has options with price ranges)
          // If so, look for the previous "What are you looking for" type question
          const currentQuestion = questions[i];
          const isBudgetQuestion = currentQuestion && (
            (currentQuestion.question && /budget|price|cost/i.test(currentQuestion.question)) ||
            (currentQuestion.options && currentQuestion.options.some((opt: any) => 
              opt.value && /\d+/.test(String(opt.value))
            ))
          );
          
          if (isBudgetQuestion) {
            // Look backwards for product type question (industry-agnostic)
            for (let j = Math.max(0, i - 3); j < i; j++) {
              const prevQuestion = questions[j];
              const prevAnswer = String(answers[j]).trim().toLowerCase();
              
              // Skip generic answers and budget answers
              if (prevAnswer === "any" || prevAnswer === "all" || /^\d+/.test(prevAnswer)) continue;
              
              // Check if previous question is a product type question (industry-agnostic)
              const isProductTypeQuestion = prevQuestion && (
                (prevQuestion.question && /what.*looking|what.*need|what.*want|product|item|type/i.test(prevQuestion.question)) ||
                (prevQuestion.type === "select" && prevQuestion.options && prevQuestion.options.length > 0)
              );
              
              if (isProductTypeQuestion) {
                // Extract meaningful terms from the answer to this product type question
                const terms = extractItemTerms(String(answers[j]));
                if (terms.length > 0) {
                  itemType = terms[0];
                  itemTerms.push(...terms);
                  break;
                }
              }
            }
          }
          
          // Strategy 2: Fallback - look at previous answers for product type (original logic)
          if (!itemType) {
            for (let j = Math.max(0, i - 3); j < i; j++) {
              const prevAnswer = String(answers[j]).trim().toLowerCase();
              // Skip generic answers
              if (prevAnswer === "any" || prevAnswer === "all" || /^\d+/.test(prevAnswer)) continue;
              
              // Extract meaningful terms
              const terms = extractItemTerms(String(answers[j]));
              if (terms.length > 0) {
                itemType = terms[0];
                itemTerms.push(...terms);
                break;
              }
            }
          }
          
          // If we found an item type, add as per-item budget
          if (itemType && minAmount > 0 && maxAmount > 0 && minAmount <= maxAmount) {
            const currency = detectCurrencySymbol(answerStr) || (answerStr.includes("$") ? "USD" : null);
            perItemBudgets.push({
              itemType,
              itemTerms,
              min: minAmount,
              max: maxAmount,
              currency,
              source: answerStr
            });
            console.log(`[Budget] per_item_detected_from_answers itemType=${itemType} min=${minAmount} max=${maxAmount} itemTerms=[${itemTerms.join(", ")}] source="${answerStr}" questionIndex=${i}`);
          }
        }
      }
    }
  }
  
  // Helper to detect currency symbol in answer string
  function detectCurrencySymbol(s: string): string | null {
    if (s.includes("£")) return "GBP";
    if (s.includes("$")) return "USD";
    if (s.includes("€")) return "EUR";
    return null;
  }
  
  if (Array.isArray(answers)) {
    // Look for budget/price range answers - check if any answer matches common budget patterns
    for (const answer of answers) {
      const answerStr = String(answer);
      let detectedMin: number | null = null;
      let detectedMax: number | null = null;
      let detectedCurrency: string | null = null;
      
      // First, try to extract price ceiling using improved parsing
      const priceCeilingResult = parsePriceCeiling(answerStr);
      if (priceCeilingResult !== null) {
        detectedMax = priceCeilingResult.value;
        detectedCurrency = priceCeilingResult.currency || null;
        detectedBudgets.push({ min: null, max: detectedMax, currency: detectedCurrency, source: answerStr });
        continue; // Found ceiling, move to next answer
      }
      
      // Fallback to legacy range parsing for backward compatibility
      const answerLower = answerStr.toLowerCase().trim();
      
      // Handle "under-50" or "under 50" format (legacy)
      if (answerLower.startsWith("under")) {
        const match = answerLower.match(/under[-\s]*\$?(\d+)/);
        if (match) {
          detectedMax = parseFloat(match[1]) - 0.01; // Under $50 means < $50, so max is 49.99
          detectedCurrency = detectCurrencySymbol(answerStr);
          detectedBudgets.push({ min: null, max: detectedMax, currency: detectedCurrency, source: answerStr });
        }
      } 
      // Handle "500-plus" or "500+" format
      else if (answerLower.includes("-plus") || answerLower.match(/\d+[\s]*\+/)) {
        const match = answerLower.match(/(\d+)[-\s]*plus|(\d+)[\s]*\+/i);
        const amount = match ? parseFloat(match[1] || match[2]) : null;
        if (amount) {
          detectedMin = amount;
          detectedCurrency = detectCurrencySymbol(answerStr);
          detectedBudgets.push({ min: detectedMin, max: null, currency: detectedCurrency, source: answerStr });
        }
      } 
      // Handle range like "50-100" or "$50 - $100"
      else if (answerLower.match(/\d+[-\s]+\d+/)) {
        const match = answerLower.match(/\$?(\d+)[-\s]+\$?(\d+)/);
        if (match) {
          detectedMin = parseFloat(match[1]);
          detectedMax = parseFloat(match[2]);
          detectedCurrency = detectCurrencySymbol(answerStr);
          detectedBudgets.push({ min: detectedMin, max: detectedMax, currency: detectedCurrency, source: answerStr });
        }
      }
      // Handle "plus" or "+" with amount before it (e.g., "$500+", "500 and above")
      else if (answerLower.includes("plus") || answerLower.includes("+") || answerLower.includes("and above")) {
        const match = answerLower.match(/\$?(\d+)[-\s]*plus|\$?(\d+)[-\s]*\+|\$?(\d+)[-\s]*and\s*above/i);
        const amount = match ? parseFloat(match[1] || match[2] || match[3]) : null;
        if (amount) {
          detectedMin = amount;
          detectedCurrency = detectCurrencySymbol(answerStr);
          detectedBudgets.push({ min: detectedMin, max: null, currency: detectedCurrency, source: answerStr });
        }
      }
    }
  }
  
  // Resolve multiple budgets: per-item in bundle mode (will be set later), most restrictive for single-item
  // For single-item mode: use most restrictive (highest min, lowest max)
  // CRITICAL: Filter out budgets that were already parsed as per-item budgets to avoid overwriting
  const globalBudgetsOnly = detectedBudgets.filter(budget => {
    // Check if this budget was already parsed as a per-item budget
    return !perItemBudgets.some(perItem => {
      const budgetSourceLower = budget.source.toLowerCase();
      const perItemSourceLower = perItem.source.toLowerCase();
      // If sources match or budget source is contained in per-item source, it's already handled
      return budgetSourceLower === perItemSourceLower || 
             perItemSourceLower.includes(budgetSourceLower) ||
             budgetSourceLower.includes(perItemSourceLower);
    });
  });
  
  if (globalBudgetsOnly.length > 0) {
    // Find most restrictive min (highest) and max (lowest) from GLOBAL budgets only
    let mostRestrictiveMin: number | null = null;
    let mostRestrictiveMax: number | null = null;
    let resolvedCurrency: string | null = null;
    
    for (const budget of globalBudgetsOnly) {
      if (budget.min !== null) {
        if (mostRestrictiveMin === null || budget.min > mostRestrictiveMin) {
          mostRestrictiveMin = budget.min;
        }
      }
      if (budget.max !== null) {
        if (mostRestrictiveMax === null || budget.max < mostRestrictiveMax) {
          mostRestrictiveMax = budget.max;
        }
      }
      if (budget.currency && !resolvedCurrency) {
        resolvedCurrency = budget.currency;
      }
    }
    
    // Validate: if min > max, use only the constraint that makes sense
    if (mostRestrictiveMin !== null && mostRestrictiveMax !== null && mostRestrictiveMin > mostRestrictiveMax) {
      // Issue 2 fix: If per-item budgets exist, don't set global budget (let per-item budgets handle it)
      if (perItemBudgets.length > 0) {
        // Invalid range but per-item budgets exist - don't set global budget
        priceMax = null;
        priceMin = null;
        console.log(`[Budget] multiple_constraints_detected min=${mostRestrictiveMin} max=${mostRestrictiveMax} invalid_range=true globalBudgetIgnoredBecausePerItemBudgets=true perItemBudgetsCount=${perItemBudgets.length} reason=per_item_budgets_exist`);
      } else {
        // Invalid range - prefer max (ceiling) as it's typically more restrictive for user intent
        // Example: "100-250" and "less than $50" -> use max=50 only
        priceMax = mostRestrictiveMax;
        priceMin = null; // Clear min to avoid invalid range
        console.log(`[Budget] multiple_constraints_detected min=${mostRestrictiveMin} max=${mostRestrictiveMax} invalid_range=true using_max_only=${priceMax} reason=min_gt_max`);
      }
    } else {
      priceMin = mostRestrictiveMin;
      priceMax = mostRestrictiveMax;
      if (globalBudgetsOnly.length > 1) {
        console.log(`[Budget] multiple_constraints_detected count=${globalBudgetsOnly.length} resolved_min=${priceMin ?? "null"} resolved_max=${priceMax ?? "null"} using=most_restrictive (per_item_budgets_excluded=${detectedBudgets.length - globalBudgetsOnly.length})`);
      }
    }
    
    userCurrency = resolvedCurrency;
  }
  
  // Issue 2/3 fix: Parse per-item budgets from BOTH conversation messages AND answers array (industry-agnostic)
  // Look for patterns like "Suit Less Than $250 and A Shirt Less Than $50" or "100-250" (range for first item)
  // Industry-agnostic: extracts meaningful terms before budget indicators, not hardcoded product types
  // Note: extractItemTerms function is already defined above (before global budget resolution)
  
  // Parse per-item budgets from conversation messages
  if (conversationMessages && conversationMessages.length > 0) {
    for (const msg of conversationMessages) {
      if (msg.role === "user" && msg.content) {
        const content = msg.content.trim();
        const contentLower = content.toLowerCase();
        
        // Look for patterns like "X for less than $Y" or "X less than $Y" or "X under $Y"
        // Split by common conjunctions: "and", "&", ","
        const parts = content.split(/\s+(and|&|,)\s+/i);
        
        for (const part of parts) {
          const partTrimmed = part.trim();
          if (partTrimmed.length === 0) continue;
          
          // Try to extract item type and budget from this part
          // Pattern 1: "itemType [for] less than/then $amount" or "itemType [for] under $amount" (industry-agnostic)
          // Note: Handles typo "less then" as well as "less than"
          const lessThanMatch = partTrimmed.match(/(.+?)\s+(?:for\s+)?(?:less\s+(?:than|then)|under)\s+\$?(\d+)/i);
          if (lessThanMatch) {
            const itemPart = lessThanMatch[1].trim();
            const amount = parseFloat(lessThanMatch[2]);
            const currency = detectCurrencySymbol(partTrimmed) || (partTrimmed.includes("$") ? "USD" : null);
            
            // Extract item terms using industry-agnostic approach
            const itemTerms = extractItemTerms(itemPart);
            
            if (itemTerms.length > 0 && amount > 0) {
              // Use the first (shortest) meaningful term as the primary itemType
              const primaryItemType = itemTerms[0];
              perItemBudgets.push({
                itemType: primaryItemType,
                itemTerms,
                min: null,
                max: amount,
                currency,
                source: partTrimmed
              });
              console.log(`[Budget] per_item_detected itemType=${primaryItemType} max=${amount} itemTerms=[${itemTerms.join(", ")}] source="${partTrimmed.substring(0, 50)}"`);
            }
            continue; // Skip other patterns if this matched
          }
          
          // Pattern 2: "itemType [for] $min-$max" or "itemType [for] $min to $max" (range)
          const rangeMatch = partTrimmed.match(/(.+?)\s+(?:for\s+)?\$?(\d+)[\s\-]+(?:to|and|-)\s+\$?(\d+)/i);
          if (rangeMatch) {
            const itemPart = rangeMatch[1].trim();
            const minAmount = parseFloat(rangeMatch[2]);
            const maxAmount = parseFloat(rangeMatch[3]);
            const currency = detectCurrencySymbol(partTrimmed) || (partTrimmed.includes("$") ? "USD" : null);
            
            // Extract item terms using industry-agnostic approach
            const itemTerms = extractItemTerms(itemPart);
            
            if (itemTerms.length > 0 && minAmount > 0 && maxAmount > 0 && minAmount <= maxAmount) {
              const primaryItemType = itemTerms[0];
              perItemBudgets.push({
                itemType: primaryItemType,
                itemTerms,
                min: minAmount,
                max: maxAmount,
                currency,
                source: partTrimmed
              });
              console.log(`[Budget] per_item_detected itemType=${primaryItemType} min=${minAmount} max=${maxAmount} itemTerms=[${itemTerms.join(", ")}] source="${partTrimmed.substring(0, 50)}"`);
            }
            continue; // Skip other patterns if this matched
          }
          
          // Pattern 3: "itemType for $amount" pattern (exact price)
          const exactPriceMatch = partTrimmed.match(/(.+?)\s+for\s+\$?(\d+)/i);
          if (exactPriceMatch) {
            const itemPart = exactPriceMatch[1].trim();
            const amount = parseFloat(exactPriceMatch[2]);
            const currency = detectCurrencySymbol(partTrimmed) || (partTrimmed.includes("$") ? "USD" : null);
            
            // Extract item terms using industry-agnostic approach
            const itemTerms = extractItemTerms(itemPart);
            
            if (itemTerms.length > 0 && amount > 0) {
              const primaryItemType = itemTerms[0];
              perItemBudgets.push({
                itemType: primaryItemType,
                itemTerms,
                min: null,
                max: amount,
                currency,
                source: partTrimmed
              });
              console.log(`[Budget] per_item_detected itemType=${primaryItemType} max=${amount} itemTerms=[${itemTerms.join(", ")}] source="${partTrimmed.substring(0, 50)}"`);
            }
          }
        }
      }
    }
  }
  
  // Store detected budgets for per-item assignment in bundle mode (will be used later)
  // BUT: Filter out budgets that were already parsed as per-item budgets
  const detectedBudgetsForBundle = detectedBudgets.filter(budget => {
    // Check if this budget was already parsed as a per-item budget
    // (by comparing source text)
    return !perItemBudgets.some(perItem => {
      const budgetSourceLower = budget.source.toLowerCase();
      const perItemSourceLower = perItem.source.toLowerCase();
      // If sources match or budget source is contained in per-item source, it's already handled
      return budgetSourceLower === perItemSourceLower || 
             perItemSourceLower.includes(budgetSourceLower) ||
             budgetSourceLower.includes(perItemSourceLower);
    });
  });
  
  // Log budget detection summary - answers are the SINGLE source of truth
  if (priceMin !== null || priceMax !== null) {
    console.log(`[Budget] source=answers priceMin=${priceMin ?? "null"} priceMax=${priceMax ?? "null"} userCurrency=${userCurrency ?? "none"} ignore_llm_totalBudget=true`);
  }
  
  // Store per-item budgets for bundle mode
  const perItemBudgetsForBundle = perItemBudgets;

  // Get access token from Session table
  const accessToken = await getAccessTokenForShop(shopDomain);
  
  // Get shop currency (cached, fetched once)
  let shopCurrency: string | null = null;
  if (accessToken) {
    shopCurrency = await getShopCurrency(shopDomain, accessToken);
    console.log("[Currency] shop_currency", { shopCurrency: shopCurrency || "unknown" });
  }
  
  let productHandles: string[] = [];
  let aiCallCount = 0; // Track AI ranking calls per session (should be 0 or 1)
  let intentParseCallCount = 0; // Track intent parsing calls per session (should be 0 or 1)
  
  // Performance timing variables
  let shopifyFetchMs = 0;
  let enrichmentMs = 0;
  let gatingMs = 0;
  let bm25Ms = 0;
  let aiMs = 0; // Reset to 0 at start of each session background processing
  let saveMs = 0;
  
  // Declare finalHandlesGuaranteed early to ensure it's always in scope
  // Even if an exception occurs before its normal initialization
  let finalHandlesGuaranteed: string[] = [];
  
  // Track result source changes (for bundle mode validation fallback and refills)
  let usedValidationFallback = false;
  let usedRefillFromRemaining = false;
  let usedRefillFromBM25 = false;
  
  try {
    if (accessToken) {
      const shopifyFetchStart = performance.now();
      
      // ============================================
      // INTENT-FIRST SMART FETCH
      // ============================================
      let smartFetchProducts: any[] = [];
      let usingSmartFetch = false;
      const SMART_FETCH_CAP = 500;
      const SMART_FETCH_DESIRED_MIN = finalResultCount * 8;
      
      // Variable to store bundle fetch products (will be populated after intent parsing)
      let bundleFetchProductsForMerge: any[] = [];
      // Store per-item retrieval sets for building item pools (itemIndex -> products[])
      // This will be populated after intent parsing in bundle mode
      let bundleFetchByItemIndex: Map<number, any[]> = new Map();
      
      // Quick bundle pre-detection from userIntent (before full intent parsing)
      // Industry-agnostic: detect multi-item patterns like "X and Y", "X, Y", "X with Y"
      let likelyBundle = false;
      const userIntentText = conversationMessages
        .filter(m => m.role === "user" && m.content)
        .map(m => (m.content || "").trim())
        .join(" ") || (Array.isArray(answers) ? answers.join(" ") : String(answers || ""));
      
      if (userIntentText) {
        const lowerText = userIntentText.toLowerCase();
        // Detect bundle patterns: "X and Y", "X, Y", "X with Y", "X plus Y", "X & Y"
        const bundlePatterns = [
          /\b\w+\s+and\s+\w+/i, // "suit and shirt"
          /\b\w+,\s*\w+/i, // "suit, shirt"
          /\b\w+\s+with\s+\w+/i, // "suit with shirt"
          /\b\w+\s+plus\s+\w+/i, // "suit plus shirt"
          /\b\w+\s*&\s*\w+/i, // "suit & shirt"
        ];
        likelyBundle = bundlePatterns.some(pattern => pattern.test(lowerText));
      }
      
      // Extract fetch signals from answers and conversation
      const fetchSignals = extractSmartFetchSignals(answers, conversationMessages, modeUsed);
      
      if (fetchSignals.hasMeaningfulSignals) {
        console.log(`[SmartFetch] enabled=true mode=${modeUsed} reason=has_meaningful_signals likelyBundle=${likelyBundle}`);
        console.log(`[SmartFetch] signals keywords=${fetchSignals.keywords.length} selections=${fetchSignals.selections.length} rawPreview=${fetchSignals.rawPreview.substring(0, 100)}`);
        
        // For bundle mode: fetch per itemType (will be determined more precisely after intent parsing)
        // For now, use generic fetch but we'll enhance this after intent parsing
        if (likelyBundle) {
          console.log(`[SmartFetch] bundle_mode=true - will fetch per itemType after intent parsing`);
        }
        
        // Step A: Build targeted query
        let query = buildShopifySearchQuery(fetchSignals);
        
        if (query) {
          console.log(`[SmartFetch] keywords=[${fetchSignals.keywords.join(", ")}] query="${query}"`);
          console.log(`[SmartFetch] query_step=A query="${query.substring(0, 200)}${query.length > 200 ? "..." : ""}"`);
          
          try {
            // Step A: Targeted fetch
            const stepA = await fetchProductsByQueryPaginated(
              shopDomain,
              accessToken,
              query,
              SMART_FETCH_DESIRED_MIN,
              200
            );
            
            smartFetchProducts = stepA.products;
            const sampleTitles = stepA.products.slice(0, 5).map((p: any) => p.title || "").filter((t: string) => t.length > 0);
            console.log(`[SmartFetch] fetched=${stepA.products.length} sample_titles=[${sampleTitles.join(", ")}]`);
            console.log(`[SmartFetch] query_step=A fetched=${stepA.products.length} totalFetched=${stepA.totalFetched} hadMorePages=${stepA.hasMorePages}`);
            
            // Step B: Widen if insufficient (remove AND constraints, keep OR keywords)
            if (smartFetchProducts.length < SMART_FETCH_DESIRED_MIN && stepA.hasMorePages) {
              const widen1Query = buildShopifySearchQuery({
                keywords: fetchSignals.keywords,
                selections: [], // Drop selections for widening
                hasMeaningfulSignals: fetchSignals.keywords.length > 0,
              }, 400);
              
              if (widen1Query && widen1Query !== query) {
                console.log(`[SmartFetch] built_query="${widen1Query}"`);
                console.log(`[SmartFetch] widen_step=1 query="${widen1Query.substring(0, 200)}${widen1Query.length > 200 ? "..." : ""}"`);
                
                const stepB = await fetchProductsByQueryPaginated(
                  shopDomain,
                  accessToken,
                  widen1Query,
                  SMART_FETCH_DESIRED_MIN - smartFetchProducts.length,
                  200
                );
                
                const sampleTitlesB = stepB.products.slice(0, 5).map((p: any) => p.title || "").filter((t: string) => t.length > 0);
                console.log(`[SmartFetch] fetched=${stepB.products.length} sample_titles=[${sampleTitlesB.join(", ")}]`);
                
                // Deduplicate
                const seenHandles = new Set(smartFetchProducts.map((p: any) => p.handle));
                const newProducts = stepB.products.filter((p: any) => !seenHandles.has(p.handle));
                smartFetchProducts.push(...newProducts);
                
                console.log(`[SmartFetch] widen_step=1 fetchedTotal=${smartFetchProducts.length}`);
              }
            }
            
            // Step C: Paginate more if still insufficient
            if (smartFetchProducts.length < SMART_FETCH_DESIRED_MIN && smartFetchProducts.length < SMART_FETCH_CAP) {
              console.log(`[SmartFetch] widen_step=2 paginate=true`);
              
              const stepC = await fetchProductsByQueryPaginated(
                shopDomain,
                accessToken,
                query,
                SMART_FETCH_CAP - smartFetchProducts.length,
                200
              );
              
              // Deduplicate
              const seenHandles = new Set(smartFetchProducts.map((p: any) => p.handle));
              const newProducts = stepC.products.filter((p: any) => !seenHandles.has(p.handle));
              smartFetchProducts.push(...newProducts);
              
              console.log(`[SmartFetch] widen_step=2 fetchedTotal=${smartFetchProducts.length}`);
            }
            
            if (smartFetchProducts.length > 0) {
              usingSmartFetch = true;
              console.log(`[SmartFetch] final candidates=${smartFetchProducts.length} usingSmartFetch=true`);
            } else {
              console.log(`[SmartFetch] fallback_to_pool=true reason=insufficient_candidates`);
            }
          } catch (error) {
            console.error(`[SmartFetch] Error during smart fetch:`, error);
            console.log(`[SmartFetch] fallback_to_pool=true reason=query_error`);
            smartFetchProducts = [];
          }
        } else {
          console.log(`[SmartFetch] fallback_to_pool=true reason=no_keywords`);
        }
      } else {
        console.log(`[SmartFetch] fallback_to_pool=true reason=no_meaningful_signals`);
      }
      
      // Use smart fetch products if available, otherwise fall back to generic fetch
      let products: any[] = [];
      
      if (usingSmartFetch && smartFetchProducts.length > 0) {
        products = smartFetchProducts;
        console.log("[App Proxy] Using smart fetch products:", products.length);
      } else {
      console.log("[App Proxy] Fetching products from Shopify Admin API (two-stage fetch)");
      
        // STAGE 1: First fetch (200 products) - existing generic fetch
        products = await fetchShopifyProducts({
        shopDomain,
        accessToken,
        limit: PRODUCT_POOL_LIMIT_FIRST,
        collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
      });
      }

      const firstFetchCount = products.length;
      const mightHaveMorePages = usingSmartFetch ? false : (firstFetchCount === PRODUCT_POOL_LIMIT_FIRST);
      if (!usingSmartFetch) {
      console.log("[App Proxy] First fetch:", firstFetchCount, "products", mightHaveMorePages ? "(might have more pages)" : "");
      }

      // Apply initial filters
      // Filter out ARCHIVED and DRAFT products
      const beforeStatusFilter = products.length;
      products = products.filter(p => {
        const status = (p as any).status;
        return status !== "ARCHIVED" && status !== "DRAFT";
      });
      const afterStatusFilter = products.length;

      // Filter by excluded tags
      if (excludedTags.length > 0) {
        products = products.filter(p => {
          const productTags = p.tags || [];
          return !excludedTags.some(excludedTag => 
            productTags.some((tag: string) => tag.toLowerCase() === excludedTag.toLowerCase())
          );
        });
      }

      // Deduplicate by handle (in case collections overlap)
      const seen = new Set<string>();
      products = products.filter(p => {
        if (seen.has(p.handle)) return false;
        seen.add(p.handle);
        return true;
      });
      
      // Issue 1 fix: Single-item fallback - if SmartFetch returned insufficient products, do broader fallback BEFORE filtering/enrichment
      // Only for single-item mode (bundle mode has its own per-item retrieval)
      if (usingSmartFetch && products.length < finalResultCount * 8 && !likelyBundle && accessToken) {
        console.log(`[SmartFetch] single_item_fallback triggered product_count=${products.length} min_needed=${finalResultCount * 8} reason=insufficient_before_filtering`);
        
        try {
          // Broader fallback: fetch generic pool (no query constraints)
          const fallbackProducts = await fetchShopifyProducts({
            shopDomain,
            accessToken,
            limit: PRODUCT_POOL_LIMIT_FIRST,
            collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
          });
          
          // Merge with existing products (avoid duplicates)
          const existingHandles = new Set(products.map((p: any) => p.handle));
          const newFallbackProducts = fallbackProducts.filter((p: any) => !existingHandles.has(p.handle));
          
          if (newFallbackProducts.length > 0) {
            products = [...products, ...newFallbackProducts];
            console.log(`[SmartFetch] single_item_fallback merged=${newFallbackProducts.length} total_products=${products.length} BEFORE_filtering`);
            
            // Re-deduplicate after merge
            const seenAfterFallback = new Set<string>();
            products = products.filter(p => {
              if (seenAfterFallback.has(p.handle)) return false;
              seenAfterFallback.add(p.handle);
              return true;
            });
          }
        } catch (error) {
          console.error(`[SmartFetch] single_item_fallback error:`, error);
        }
      }
      
      // Merge bundle fetch products (if any were fetched before this point)
      // NOTE: For bundle mode, bundle retrieval happens AFTER intent parsing (which happens after this point),
      // so bundleFetchProductsForMerge is empty here. Bundle products are used directly via bundleFetchByItemIndex
      // in bundle item pool building, not merged into the main pool. This is intentional - bundle products
      // should be filtered per-item, not globally.
      if (bundleFetchProductsForMerge.length > 0) {
        const existingHandles = new Set(products.map((p: any) => p.handle));
        const newBundleProducts = bundleFetchProductsForMerge.filter((p: any) => !existingHandles.has(p.handle));
        products.push(...newBundleProducts);
        console.log(`[BundleRetrieval] merged=${newBundleProducts.length} BEFORE_filtering total_products=${products.length}`);
        bundleFetchProductsForMerge = []; // Clear after merge
        
        // Re-deduplicate after bundle merge
        const seenAfterBundle = new Set<string>();
        products = products.filter(p => {
          if (seenAfterBundle.has(p.handle)) return false;
          seenAfterBundle.add(p.handle);
          return true;
        });
      }

      // Create baseProducts set (filters that should NEVER relax)
      let baseProducts = products; // after status + excludedTags (+ dedupe) are applied

      const relaxNotes: string[] = [];

      let filteredProducts = [...baseProducts];

      // Apply inStockOnly (experience setting) - AFTER bundle merge
      if (experience.inStockOnly) {
        filteredProducts = filteredProducts.filter(p => p.available);
      }

      // Apply budget (derived from answers) - using price range overlap
      // CRITICAL: priceMin/priceMax from answers is the SINGLE source of truth
      // Do NOT use LLM totalBudget or priceCeiling for filtering
      const hadBudget = typeof priceMin === "number" || typeof priceMax === "number";
      if (hadBudget) {
        const beforeBudget = filteredProducts.length;
        let removedBelow = 0;
        let removedAbove = 0;
        
        filteredProducts = filteredProducts.filter(p => {
          // Get price range from product (prefer explicit min/max, fallback to single price)
          const productMin = (p as any).priceMinAmount ?? null;
          const productMax = (p as any).priceMaxAmount ?? null;
          const singlePrice = p.priceAmount ? parseFloat(String(p.priceAmount)) : (p.price ? parseFloat(String(p.price)) : NaN);
          
          // If we have explicit min/max, use range overlap logic
          if (productMin !== null || productMax !== null) {
            const prodMin = productMin ?? productMax ?? singlePrice;
            const prodMax = productMax ?? productMin ?? singlePrice;
            
            // Range overlap: productMax >= budgetMin AND productMin <= budgetMax
            // Only apply floor filter when priceMin is present
            if (typeof priceMin === "number" && prodMax < priceMin) {
              removedBelow++;
              return false;
            }
            // Only apply ceiling filter when priceMax is present
            if (typeof priceMax === "number" && prodMin > priceMax) {
              removedAbove++;
              return false;
            }
            return true;
          }
          
          // Fallback to single price logic for backwards compatibility
          if (!Number.isFinite(singlePrice)) return true; // don't drop unknown prices
          // Only apply floor filter when priceMin is present
          if (typeof priceMin === "number" && singlePrice < priceMin) {
            removedBelow++;
            return false;
          }
          // Only apply ceiling filter when priceMax is present
          if (typeof priceMax === "number" && singlePrice > priceMax) {
            removedAbove++;
            return false;
          }
          return true;
        });
        
        const afterBudget = filteredProducts.length;
        console.log(`[BudgetFilter] applied=true before=${beforeBudget} after=${afterBudget} min=${priceMin ?? "null"} max=${priceMax ?? "null"}`);
        console.log(`[BudgetConstraint] applied=true floor=${priceMin ?? "null"} ceiling=${priceMax ?? "null"} removedBelow=${removedBelow} removedAbove=${removedAbove}`);
      }

      const firstStageFilteredCount = filteredProducts.length;
      const minNeededAfterFilter = finalResultCount * 8;

      // STAGE 2: Fetch additional products if needed (only for generic fetch, not smart fetch)
      if (!usingSmartFetch && firstStageFilteredCount < minNeededAfterFilter && mightHaveMorePages && products.length < PRODUCT_POOL_LIMIT_MAX) {
        console.log("[App Proxy] Filtered candidates", firstStageFilteredCount, "<", minNeededAfterFilter, "- fetching up to", PRODUCT_POOL_LIMIT_MAX, "total products");
        
        // Fetch up to max limit (will fetch from beginning, but we'll deduplicate)
        const allProducts = await fetchShopifyProducts({
          shopDomain,
          accessToken,
          limit: PRODUCT_POOL_LIMIT_MAX,
          collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
        });

        const secondFetchCount = allProducts.length;
        console.log("[App Proxy] Second fetch:", secondFetchCount, "total products (will deduplicate)");

        // Merge with existing products (avoid duplicates by handle)
        const existingHandles = new Set(products.map(p => p.handle));
        const newProducts = allProducts.filter(p => !existingHandles.has(p.handle));
        products = [...products, ...newProducts];

        // Re-apply all filters to merged products
        // Filter out ARCHIVED and DRAFT products
        products = products.filter(p => {
          const status = (p as any).status;
          return status !== "ARCHIVED" && status !== "DRAFT";
        });

        // Filter by excluded tags
        if (excludedTags.length > 0) {
          products = products.filter(p => {
            const productTags = p.tags || [];
            return !excludedTags.some(excludedTag => 
              productTags.some((tag: string) => tag.toLowerCase() === excludedTag.toLowerCase())
            );
          });
        }

        // Deduplicate by handle
        const seen2 = new Set<string>();
        products = products.filter(p => {
          if (seen2.has(p.handle)) return false;
          seen2.add(p.handle);
          return true;
        });

        // Update baseProducts with merged and filtered products
        baseProducts = products;

        // Re-apply inStockOnly and budget filters
        filteredProducts = [...baseProducts];

        if (experience.inStockOnly) {
          filteredProducts = filteredProducts.filter(p => p.available);
        }

        if (hadBudget) {
          filteredProducts = filteredProducts.filter(p => {
            const price = p.priceAmount ? parseFloat(String(p.priceAmount)) : (p.price ? parseFloat(String(p.price)) : NaN);
            if (!Number.isFinite(price)) return true;
            if (typeof priceMin === "number" && price < priceMin) return false;
            if (typeof priceMax === "number" && price > priceMax) return false;
            return true;
          });
        }
      }

      // Performance logging
      const totalFetched = products.length;
      const totalFiltered = filteredProducts.length;
      
      console.log("[Perf] product_pool", {
        firstFetch: firstFetchCount,
        secondFetch: totalFetched > firstFetchCount ? totalFetched - firstFetchCount : 0,
        totalFetched,
        filtered: totalFiltered,
      });

      shopifyFetchMs = Math.round(performance.now() - shopifyFetchStart);

      // ---- COUNT-AWARE RELAXATION LADDER ----
      // Relax if results are less than minimum needed (not just zero)
      const minNeeded = Math.max(MIN_CANDIDATES_FOR_AI, MIN_CANDIDATES_FOR_DELIVERY, finalResultCount);
      
      // If too few results, relax budget first (keep stock preference if enabled)
      if (filteredProducts.length < minNeeded && hadBudget) {
        relaxNotes.push("Budget filter relaxed to show the closest matches.");
        filteredProducts = [...baseProducts];

        if (experience.inStockOnly) {
          filteredProducts = filteredProducts.filter(p => p.available);
        }
      }

      // If still too few and stock-only was enabled, relax stock-only
      if (filteredProducts.length < minNeeded && experience.inStockOnly) {
        relaxNotes.push("Showing out-of-stock items because no in-stock matches were found.");
        filteredProducts = [...baseProducts];

        // keep budget if it existed
        if (hadBudget) {
          filteredProducts = filteredProducts.filter(p => {
            const price = p.priceAmount ? parseFloat(String(p.priceAmount)) : (p.price ? parseFloat(String(p.price)) : NaN);
            if (!Number.isFinite(price)) return true;
            if (typeof priceMin === "number" && price < priceMin) return false;
            if (typeof priceMax === "number" && price > priceMax) return false;
            return true;
          });
        }
      }

      // If STILL too few, relax both (within baseProducts only)
      if (filteredProducts.length < minNeeded) {
        relaxNotes.push("Showing closest matches across the catalogue.");
        filteredProducts = [...baseProducts];
      }

      // Log budget pool filtering summary
      console.log(`[BudgetPool] base=${baseProducts.length} after_stock_and_budget=${filteredProducts.length} min=${priceMin ?? "null"} max=${priceMax ?? "null"} userCurrency=${userCurrency ?? "none"}`);

      // Budget diagnostic: Log suitish products in full pool (when budget is active)
      if (hadBudget && (priceMin !== null || priceMax !== null)) {
        const isSuitish = (p: any) => {
          const text = [
            p.title || "",
            p.handle || "",
            (p as any).productType || "",
            (Array.isArray(p.tags) ? p.tags.join(" ") : ""),
          ].join(" ").toLowerCase();
          return text.includes("suit");
        };
        
        const suitishProducts = baseProducts.filter(isSuitish);
        const suitishOverMin = suitishProducts.filter(p => {
          const productMax = (p as any).priceMaxAmount ?? (p as any).priceMinAmount ?? (p.priceAmount ? parseFloat(String(p.priceAmount)) : null);
          return productMax !== null && (priceMin === null || productMax >= priceMin);
        });
        
        const suitishSample = suitishProducts
          .map(p => ({
            handle: p.handle,
            title: p.title,
            productType: (p as any).productType || null,
            available: p.available,
            priceMinAmount: (p as any).priceMinAmount ?? null,
            priceMaxAmount: (p as any).priceMaxAmount ?? null,
            priceAmount: p.priceAmount || p.price || null,
          }))
          .sort((a, b) => {
            const aMax = a.priceMaxAmount ?? a.priceMinAmount ?? (a.priceAmount ? parseFloat(String(a.priceAmount)) : 0);
            const bMax = b.priceMaxAmount ?? b.priceMinAmount ?? (b.priceAmount ? parseFloat(String(b.priceAmount)) : 0);
            return bMax - aMax;
          })
          .slice(0, 15);
        
        console.log(`[BudgetDebug] suitish_in_pool total=${suitishProducts.length} overMin=${suitishOverMin.length} min=${priceMin ?? "null"} sample=${JSON.stringify(suitishSample)}`);
      }

      // Create known option names from catalogue
      const knownOptionNames = Array.from(
        new Set(
          filteredProducts
            .flatMap((p: any) => Object.keys(p.optionValues ?? {}))
            .filter(Boolean)
        )
      );

      // Build userIntent from answers (before building candidates, so we can use keywords for filtering)
      // Enhanced: Better context preservation and intent building
      // If we have conversation messages, use them for better context; otherwise fall back to answers
      let userIntent = "";
      
      if (conversationMessages.length > 0) {
        // Use conversation context: extract all user messages and combine them
        const userMessages = conversationMessages
          .filter(m => m.role === "user" && m.content)
          .map(m => (m.content || "").trim())
          .filter(c => c.length > 0);
        
        if (userMessages.length > 0) {
          // Join user messages with natural flow
          userIntent = userMessages.join(". ").trim();
          console.log(`[App Proxy] Built userIntent from ${userMessages.length} conversation messages`);
        }
      }
      
      // Fallback to answers if no conversation messages or userIntent is still empty
      if (!userIntent && Array.isArray(answers)) {
        // Filter out empty/null answers and preserve meaningful context
        const meaningfulAnswers = answers
          .filter(a => a !== null && a !== undefined && String(a).trim().length > 0)
          .map(a => String(a).trim());
        
        // Join with better separators to preserve context
        // Use ". " for natural flow instead of "; " which can feel mechanical
        userIntent = meaningfulAnswers.join(". ").trim();
      } else if (!userIntent && typeof answers === "string") {
        userIntent = String(answers).trim();
      }

      console.log("[App Proxy] User intent length:", userIntent.length);
      console.log("[App Proxy] User intent preview:", userIntent.substring(0, 200));

      // Extract includeTerms and avoidTerms from userIntent (before building candidates)
      function extractKeywords(text: string): { includeTerms: string[]; avoidTerms: string[] } {
        const includeTerms: string[] = [];
        const avoidTerms: string[] = [];
        
        // Common stopwords to exclude from includeTerms
        const stopwords = new Set([
          "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
          "from", "as", "is", "was", "are", "were", "been", "be", "have", "has", "had", "do", "does", "did",
          "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those",
          "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
          "what", "which", "who", "whom", "where", "when", "why", "how", "if", "then", "else",
          "about", "above", "after", "before", "below", "between", "during", "through", "under", "over",
          "up", "down", "out", "off", "away", "back", "here", "there", "where", "everywhere", "nowhere",
          "some", "any", "all", "both", "each", "every", "few", "many", "most", "other", "some", "such",
          "no", "not", "none", "nothing", "nobody", "nowhere", "never", "neither", "nor"
        ]);
        
        // Patterns for avoid terms: "no X", "not X", "without X", "avoid X"
        const avoidPatterns = [
          /\bno\s+([a-z]{3,})\b/gi,
          /\bnot\s+([a-z]{3,})\b/gi,
          /\bwithout\s+([a-z]{3,})\b/gi,
          /\bavoid\s+([a-z]{3,})\b/gi,
        ];
        
        const lowerText = text.toLowerCase();
        
        // Extract avoid terms
        for (const pattern of avoidPatterns) {
          let match;
          while ((match = pattern.exec(lowerText)) !== null) {
            const term = match[1].trim();
            if (term.length >= 3 && !stopwords.has(term)) {
              avoidTerms.push(term);
            }
          }
        }
        
        // Extract include terms (meaningful words, min length 3, excluding stopwords and avoid terms)
        const avoidSet = new Set(avoidTerms);
        const words = lowerText.split(/\s+/);
        for (const word of words) {
          const cleaned = word.replace(/[^\w]/g, "").trim();
          if (cleaned.length >= 3 && !stopwords.has(cleaned) && !avoidSet.has(cleaned)) {
            includeTerms.push(cleaned);
          }
        }
        
        // Remove duplicates
        return {
          includeTerms: Array.from(new Set(includeTerms)),
          avoidTerms: Array.from(new Set(avoidTerms)),
        };
      }
      
      // ============================================
      // 3-LAYER RECOMMENDATION PIPELINE
      // ============================================
      
      // LAYER 1: Initial candidate building (without descriptions for speed)
      // Descriptions will be fetched later only for AI candidate window
      const enrichmentStart = performance.now();
      console.log("[App Proxy] [Layer 1] Building initial candidates (descriptions deferred for speed)");
      
      // Parse indexMetafields from experience config
      let indexMetafields: Array<{ namespace: string; key: string }> = [];
      try {
        if (experience.indexMetafields && typeof experience.indexMetafields === "string") {
          indexMetafields = JSON.parse(experience.indexMetafields);
        } else if (Array.isArray(experience.indexMetafields)) {
          indexMetafields = experience.indexMetafields;
        }
      } catch (e) {
        console.warn("[Indexing] Failed to parse indexMetafields:", e);
      }
      
      let allCandidates = filteredProducts.map(p => {
        return {
        handle: p.handle,
        title: p.title,
        productType: (p as any).productType || null,
        productCategory: (p as any).productCategory || (p as any).category || null,
        taxonomy: (p as any).taxonomy || null,
        collections: (p as any).collections || null, // May be array of objects or strings
        variants: (p as any).variants || null, // May be array of variant objects
        tags: p.tags || [],
        vendor: (p as any).vendor || null,
        price: p.priceAmount || p.price || null,
        priceMinAmount: (p as any).priceMinAmount ?? null,
        priceMaxAmount: (p as any).priceMaxAmount ?? null,
        priceCurrency: (p as any).priceCurrency ?? (p as any).currencyCode ?? null,
        description: null as string | null, // Not fetched in initial query
          descPlain: "", // Will be populated later for AI candidates
          desc1000: "", // Will be populated later for AI candidates
        available: p.available,
        sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
        colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
        materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
        optionValues: (p as any).optionValues ?? {},
        metafields: (p as any).metafields || null, // Metafields object (namespace -> key -> value)
        };
      });
      
      // Build searchText for each candidate (without description for now)
      // Use extractSearchText which includes collections, variants, metafields
      type EnrichedCandidate = typeof allCandidates[0] & { searchText: string };
      const enrichedCandidates: EnrichedCandidate[] = allCandidates.map(c => {
        // Use extractSearchText which includes all fields including collections, variants, metafields
        const searchText = extractSearchText(c, indexMetafields);
        return {
          ...c,
          searchText,
        } as EnrichedCandidate;
      });
      // Use enrichedCandidates for all subsequent operations
      let allCandidatesEnriched: EnrichedCandidate[] = enrichedCandidates;
      
      // Build Type Lexicon from Shopify catalog (Primary Item-Type Anchor)
      const { 
        buildTypeLexicon, 
        parseTypeTermsVsAttributes, 
        selectPrimaryTypeAnchor,
        productMatchesTypeAnchor,
        generateTypeAnchorVariants
      } = await import("~/utils/type-lexicon.server");
      const typeLexicon = buildTypeLexicon(enrichedCandidates);
      console.log(`[TypeAnchor] lexicon_size=${typeLexicon.size} sample_terms=[${Array.from(typeLexicon).slice(0, 10).join(", ")}]`);
      
      // Discover facet vocabulary from candidate pool (industry-agnostic)
      const { discoverFacetVocabulary, normalizeOptionName } = await import("~/utils/facets.server");
      const facetVocabulary = discoverFacetVocabulary(enrichedCandidates);
      const discoveredOptionNames = Array.from(facetVocabulary.optionNames);
      const optionNameCounts: Record<string, number> = {};
      for (const optName of discoveredOptionNames) {
        const valueCount = facetVocabulary.optionNameToValues.get(optName)?.size || 0;
        optionNameCounts[optName] = valueCount;
      }
      console.log(`[Facets] discovered_options=[${discoveredOptionNames.join(", ")}] option_counts=${JSON.stringify(optionNameCounts)}`);
      
      // Store facetVocabulary for use in bundle gating
      const facetVocabularyForBundle = facetVocabulary;
      
      // Tokenize all candidates for indexing
      const candidateDocs = enrichedCandidates.map(c => ({
        candidate: c,
        tokens: tokenize(c.searchText),
      }));
      
      // Debug: Log indexed text preview for first N products
      const debugSampleSize = Math.min(5, enrichedCandidates.length);
      const indexedTextSample: Array<{ handle: string; indexedText: string; fields: string[] }> = [];
      for (let i = 0; i < debugSampleSize; i++) {
        const c = enrichedCandidates[i];
        const fields: string[] = [];
        if (c.title) fields.push(`title:${c.title.substring(0, 30)}`);
        if (c.handle) fields.push(`handle:${c.handle}`);
        if (c.productType) fields.push(`productType:${c.productType}`);
        if (c.tags && c.tags.length > 0) fields.push(`tags:${c.tags.slice(0, 3).join(",")}`);
        if (c.vendor) fields.push(`vendor:${c.vendor}`);
        indexedTextSample.push({
          handle: c.handle,
          indexedText: c.searchText.substring(0, 100),
          fields
        });
      }
      console.log(`[Indexing] indexedText preview (first ${debugSampleSize}):`, JSON.stringify(indexedTextSample));
      
      console.log("[App Proxy] [Layer 1] Enriched", candidateDocs.length, "candidates");
      enrichmentMs = Math.round(performance.now() - enrichmentStart);
      
      // LAYER 2: Intent Parsing + Local Indexing + Gating
      // LLM-FIRST APPROACH: Use OpenAI to understand intent, fallback to pattern-based if needed
      const gatingStart = performance.now();
      console.log("[App Proxy] [Layer 2] Parsing intent and building local index");
      
      // Try LLM intent parsing first (industry-agnostic, understands context)
      let hardTerms: string[] = [];
      let softTerms: string[] = [];
      let avoidTerms: string[] = [];
      let hardFacets: { size: string | null; color: string | null; material: string | null } = {
        size: null,
        color: null,
        material: null
      };
      // Issue 1 fix: Track degraded facets so validation can skip them
      let degradedFacetsForValidation: Array<{ facet: string; value: string; coverage: number }> = [];
      // Create a map for quick lookup of degraded facets
      let degradedFacetsMap: Map<string, boolean> = new Map();
      let bundleIntent: {
        isBundle: boolean;
        items: Array<{ 
          hardTerms: string[]; 
          quantity: number;
          constraints?: any;
        }>;
        totalBudget: number | null;
        totalBudgetCurrency: string | null;
      } = {
        isBundle: false,
        items: [],
        totalBudget: null,
        totalBudgetCurrency: null
      };
      let collectionIntent = false; // Multi-item intent flag (for single-item queries that want a mixed set)
      let llmIntentUsed = false;
      
      // Prepare conversation history for LLM (if available)
      const conversationHistoryForIntent = conversationMessages.length > 0
        ? conversationMessages.map(m => ({ role: m.role, content: m.content }))
        : undefined;
      
      // Try LLM intent parsing
      const llmIntentResult = await parseIntentWithLLM(userIntent, conversationHistoryForIntent);
      intentParseCallCount = llmIntentResult.fallbackUsed ? 0 : 1; // Track if LLM was used (not fallback)
      
      // Parse user text into type terms vs attribute terms (Primary Item-Type Anchor)
      const typeParseResult = parseTypeTermsVsAttributes(userIntent, typeLexicon);
      console.log(`[TypeAnchor] parsed type_terms=[${typeParseResult.typeTerms.join(", ")}] attribute_terms=[${typeParseResult.attributeTerms.join(", ")}]`);
      
      // Select primary type anchor for single-item queries (not bundles)
      let primaryTypeAnchor: string | null = null;
      let typeAnchorVariants: string[] = [];
      if (!llmIntentResult.intent?.isBundle && typeParseResult.typeTerms.length > 0) {
        primaryTypeAnchor = selectPrimaryTypeAnchor(typeParseResult.typeTerms, typeParseResult.typeTermMatches);
        if (primaryTypeAnchor) {
          typeAnchorVariants = generateTypeAnchorVariants(primaryTypeAnchor, typeLexicon);
          console.log(`[TypeAnchor] selected_anchor="${primaryTypeAnchor}" variants=[${typeAnchorVariants.join(", ")}]`);
        }
      }
      
      if (llmIntentResult.success && llmIntentResult.intent) {
        // Use LLM-parsed intent
        llmIntentUsed = true;
        const intent = llmIntentResult.intent;
        
        // Validate and normalize LLM output
        hardTerms = Array.isArray(intent.hardTerms) ? intent.hardTerms.filter(t => typeof t === "string" && t.trim().length > 0) : [];
        softTerms = Array.isArray(intent.softTerms) ? intent.softTerms.filter(t => typeof t === "string" && t.trim().length > 0) : [];
        avoidTerms = Array.isArray(intent.avoidTerms) ? intent.avoidTerms.filter(t => typeof t === "string" && t.trim().length > 0) : [];
        
        // SYNONYM EXPANSION: Expand hardTerms using Experience config (industry-agnostic)
        // Parse searchSynonymsJson from experience config
        let searchSynonyms: Record<string, string[]> = {};
        const hasSearchSynonymsJson = experience.searchSynonymsJson !== null && experience.searchSynonymsJson !== undefined;
        let synonymsKeysCount = 0;
        
        try {
          if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "string") {
            searchSynonyms = JSON.parse(experience.searchSynonymsJson);
            synonymsKeysCount = Object.keys(searchSynonyms).length;
          } else if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "object") {
            searchSynonyms = experience.searchSynonymsJson;
            synonymsKeysCount = Object.keys(searchSynonyms).length;
          }
        } catch (e) {
          console.warn("[Synonyms] Failed to parse searchSynonymsJson:", e);
        }
        
        console.log(`[Synonyms] loading exists=${hasSearchSynonymsJson} keys_count=${synonymsKeysCount}`);
        
        // Expand hardTerms with synonyms (one-hop expansion)
        const originalHardTerms = [...hardTerms];
        const expandedHardTerms = new Set<string>(hardTerms);
        const termProvenance = new Map<string, "original" | "synonym">();
        
        // Mark originals
        for (const term of hardTerms) {
          termProvenance.set(term.toLowerCase(), "original");
        }
        
        // Add synonyms
        for (const term of hardTerms) {
          const normalizedTerm = term.toLowerCase();
          const synonyms = searchSynonyms[normalizedTerm] || searchSynonyms[term] || [];
          for (const synonym of synonyms) {
            if (typeof synonym === "string" && synonym.trim().length > 0) {
              const normalizedSynonym = synonym.toLowerCase();
              if (!expandedHardTerms.has(normalizedSynonym)) {
                expandedHardTerms.add(normalizedSynonym);
                termProvenance.set(normalizedSynonym, "synonym");
              }
            }
          }
        }
        
        const expandedHardTermsArray = Array.from(expandedHardTerms);
        const synonymsApplied = expandedHardTermsArray.length > hardTerms.length;
        const expansionChangedTerms = synonymsApplied ? "true" : "false";
        
        console.log(`[Synonyms] applied=${synonymsApplied} expansion_changed_terms=${expansionChangedTerms} originalHardTerms=[${originalHardTerms.join(", ")}] expandedHardTerms=[${expandedHardTermsArray.join(", ")}]`);
        
        // Use expanded terms for gating (but keep original for logging/reasoning)
        hardTerms = expandedHardTermsArray;
        
        // Merge LLM-extracted facets with variant constraints from answers
        // This ensures we capture both LLM understanding and explicit user selections
        // EXPLICIT USER SELECTIONS ALWAYS WIN (variant constraints take precedence)
      const fromAnswersForIntent = parseConstraintsFromAnswers(answersJson);
      const fromTextForIntent = parseConstraintsFromText(userIntent);
      const variantConstraintsForIntent = mergeConstraints(fromAnswersForIntent, fromTextForIntent);
      
        // Convert LLM bundle structure to existing format
        // CRITICAL: Extract canonical_type (head noun) and facets per-item
        const isValidBundle = intent.isBundle === true && Array.isArray(intent.bundleItems) && intent.bundleItems.length >= 2;
        
        // Helper to extract canonical_type and facets from hardTerms using discovered facet vocabulary (industry-agnostic)
        // Import facet utilities (synchronous - already loaded)
        const { normalizeFacetValue, normalizeOptionName } = await import("~/utils/facets.server");
        
        function extractCanonicalTypeAndFacets(
          hardTerms: string[], 
          existingFacets?: { size?: string | null; color?: string | null; material?: string | null },
          facetVocab?: { optionNames: Set<string>; optionNameToValues: Map<string, Set<string>> }
        ): {
          canonicalType: string;
          facets: { size: string | null; color: string | null; material: string | null };
        } {
          
          // Build facet value sets from discovered vocabulary
          const discoveredColorValues = facetVocab?.optionNameToValues.get("color") || new Set<string>();
          const discoveredSizeValues = facetVocab?.optionNameToValues.get("size") || new Set<string>();
          const discoveredMaterialValues = facetVocab?.optionNameToValues.get("material") || new Set<string>();
          
          // Also check for common facet option names (shade, scent, finish, capacity, etc.)
          const colorOptionNames = new Set<string>(["color", "colour", "shade"]);
          const sizeOptionNames = new Set<string>(["size", "sizing", "capacity", "dimensions"]);
          const materialOptionNames = new Set<string>(["material", "fabric", "composition", "finish"]);
          
          // Check discovered option names for color/size/material
          for (const optName of facetVocab?.optionNames || []) {
            const normalized = normalizeOptionName(optName);
            if (normalized.includes("color") || normalized.includes("shade") || normalized.includes("colour")) {
              colorOptionNames.add(normalized);
            }
            if (normalized.includes("size") || normalized.includes("capacity") || normalized.includes("dimension")) {
              sizeOptionNames.add(normalized);
            }
            if (normalized.includes("material") || normalized.includes("fabric") || normalized.includes("finish")) {
              materialOptionNames.add(normalized);
            }
          }
          
          // Common facet value terms (fallback if vocab not available)
          const colorTerms = new Set([
            "red", "blue", "green", "yellow", "orange", "purple", "pink", "brown", "black", "white", "gray", "grey",
            "navy", "beige", "tan", "maroon", "burgundy", "crimson", "scarlet", "azure", "cyan", "teal", "lime",
            "olive", "khaki", "ivory", "cream", "silver", "gold", "bronze", "copper", "ruby", "coral", "mauve"
          ]);
          const sizeTerms = new Set([
            "xs", "s", "m", "l", "xl", "xxl", "xxxl", "small", "medium", "large", "extra", "one", "size"
          ]);
          const materialTerms = new Set([
            "cotton", "wool", "silk", "linen", "polyester", "nylon", "leather", "suede", "denim", "satin",
            "cashmere", "bamboo", "modal", "rayon", "spandex", "elastane", "acrylic", "viscose", "velvet"
          ]);
          
          const facets: { size: string | null; color: string | null; material: string | null } = {
            size: existingFacets?.size || null,
            color: existingFacets?.color || null,
            material: existingFacets?.material || null
          };
          
          // Extract facets from hardTerms using discovered vocabulary
          const remainingTerms: string[] = [];
          for (const term of hardTerms) {
            const normalized = normalizeFacetValue(term);
            let isFacet = false;
            
            // Check against discovered values first
            if (!facets.color && (discoveredColorValues.has(normalized) || colorTerms.has(normalized))) {
              facets.color = term; // Keep original case
              isFacet = true;
            } else if (!facets.size && (discoveredSizeValues.has(normalized) || sizeTerms.has(normalized))) {
              facets.size = term;
              isFacet = true;
            } else if (!facets.material && (discoveredMaterialValues.has(normalized) || materialTerms.has(normalized))) {
              facets.material = term;
              isFacet = true;
            }
            
            if (!isFacet) {
              remainingTerms.push(term);
            }
          }
          
          // Canonical type is the longest remaining term (likely the head noun)
          // If no terms remain, use the first hardTerm as fallback
          let canonicalType = "unknown";
          if (remainingTerms.length > 0) {
            // Prefer longer terms (more specific nouns)
            canonicalType = remainingTerms.reduce((longest, current) => 
              current.length > longest.length ? current : longest, remainingTerms[0]
            );
            // Normalize: lowercase, singularize if needed
            canonicalType = normalizeItemLabel(canonicalType);
          } else if (hardTerms.length > 0) {
            // Fallback: use first term if all were facets
            canonicalType = normalizeItemLabel(hardTerms[0]);
          }
          
          return { canonicalType, facets };
        }
        
        // Normalize bundle items: extract canonical_type and per-item facets
        const normalizedBundleItems: Array<{
          hardTerms: string[];
          canonicalType: string;
          quantity: number;
          constraints?: any;
          facets: { size: string | null; color: string | null; material: string | null };
        }> = [];
        
        if (isValidBundle) {
          for (const item of intent.bundleItems || []) {
            if (!item || !Array.isArray(item.hardTerms) || item.hardTerms.length === 0) continue;
            
            const filteredHardTerms = item.hardTerms.filter((t: string) => typeof t === "string" && t.trim().length > 0);
            if (filteredHardTerms.length === 0) continue;
            
            // Extract canonical_type and facets using discovered vocabulary
            const existingFacets = item.constraints?.optionConstraints || {};
            
            // Build facet value sets from discovered vocabulary (for repair logic)
            const discoveredColorValues = facetVocabularyForBundle.optionNameToValues.get("color") || new Set<string>();
            const discoveredSizeValues = facetVocabularyForBundle.optionNameToValues.get("size") || new Set<string>();
            const discoveredMaterialValues = facetVocabularyForBundle.optionNameToValues.get("material") || new Set<string>();
            
            // Common facet value terms (fallback if vocab not available)
            const colorTerms = new Set([
              "red", "blue", "green", "yellow", "orange", "purple", "pink", "brown", "black", "white", "gray", "grey",
              "navy", "beige", "tan", "maroon", "burgundy", "crimson", "scarlet", "azure", "cyan", "teal", "lime",
              "olive", "khaki", "ivory", "cream", "silver", "gold", "bronze", "copper", "ruby", "coral", "mauve"
            ]);
            const sizeTerms = new Set([
              "xs", "s", "m", "l", "xl", "xxl", "xxxl", "small", "medium", "large", "extra", "one", "size"
            ]);
            const materialTerms = new Set([
              "cotton", "wool", "silk", "linen", "polyester", "nylon", "leather", "suede", "denim", "satin",
              "cashmere", "bamboo", "modal", "rayon", "spandex", "elastane", "acrylic", "viscose", "velvet"
            ]);
            
            const { canonicalType: extractedCanonicalType, facets } = extractCanonicalTypeAndFacets(
              filteredHardTerms, 
              {
              size: existingFacets.size || null,
              color: existingFacets.color || null,
              material: existingFacets.material || null
              },
              facetVocabularyForBundle
            );
            
            // Server-side repair: prevent canonicalType from being a facet value
            // Priority: (a) item.itemType/canonicalType from LLM, (b) extracted non-facet term, (c) fallback
            let canonicalType = (item as any).itemType || (item as any).canonicalType || extractedCanonicalType;
            
            // Validate canonicalType is not a facet value
            const normalizedCanonical = normalizeFacetValue(canonicalType);
            const isFacetValue = 
              discoveredColorValues.has(normalizedCanonical) ||
              discoveredSizeValues.has(normalizedCanonical) ||
              discoveredMaterialValues.has(normalizedCanonical) ||
              colorTerms.has(normalizedCanonical) ||
              sizeTerms.has(normalizedCanonical) ||
              materialTerms.has(normalizedCanonical);
            
            if (isFacetValue || !canonicalType || canonicalType === "unknown") {
              // Repair: use first non-facet token from hardTerms
              const nonFacetTerms = filteredHardTerms.filter(term => {
                const normalized = normalizeFacetValue(term);
                return !discoveredColorValues.has(normalized) &&
                       !discoveredSizeValues.has(normalized) &&
                       !discoveredMaterialValues.has(normalized) &&
                       !colorTerms.has(normalized) &&
                       !sizeTerms.has(normalized) &&
                       !materialTerms.has(normalized);
              });
              
              if (nonFacetTerms.length > 0) {
                canonicalType = normalizeItemLabel(nonFacetTerms[0]);
                console.log(`[Bundle Normalization] repaired canonicalType from "${extractedCanonicalType}" to "${canonicalType}" (was facet value)`);
              } else {
                // Last resort: extract from userIntent text (e.g. "black suit", "white shirt")
                // Pattern: "<facet> <noun>" where facet matches the item's facet value
                let inferredFromUserText = false;
                if (userIntent && typeof userIntent === "string") {
                  const userTextLower = userIntent.toLowerCase();
                  const stopWords = new Set(["and", "with", "a", "an", "the", "in", "for", "under", "over", "on", "at", "to", "of"]);
                  
                  // Find facet value from item (color/size/material)
                  const itemFacetValue = facets.color || facets.size || facets.material || 
                                        existingFacets.color || existingFacets.size || existingFacets.material;
                  
                  if (itemFacetValue) {
                    const facetValueLower = itemFacetValue.toLowerCase().trim();
                    // Look for pattern: "<facet> <noun>" in userIntent
                    // Use regex to find facet followed by a non-stopword noun
                    const pattern = new RegExp(`\\b${facetValueLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([a-z]+(?:\\s+[a-z]+)?)`, "i");
                    const matches = userTextLower.match(pattern);
                    
                    if (matches && matches[1]) {
                      const potentialNoun = matches[1].trim();
                      const nounTokens = potentialNoun.split(/\s+/).filter(t => !stopWords.has(t) && t.length > 2);
                      
                      if (nounTokens.length > 0) {
                        // Use first non-stopword token as canonicalType
                        canonicalType = normalizeItemLabel(nounTokens[0]);
                        inferredFromUserText = true;
                        console.log(`[Bundle Normalization] inferred canonicalType from user text facet="${itemFacetValue}" noun="${nounTokens[0]}" itemIndex=${normalizedBundleItems.length}`);
                      }
                    }
                  }
                }
                
                if (!inferredFromUserText) {
                  // Final fallback: use the longest hardTerm
                  canonicalType = normalizeItemLabel(filteredHardTerms.reduce((longest, current) => 
                    current.length > longest.length ? current : longest, filteredHardTerms[0]
                  ));
                  console.log(`[Bundle Normalization] fallback canonicalType="${canonicalType}" (no non-facet terms found, userIntent extraction failed)`);
                }
              }
            }
            
            console.log(`[Bundle Normalization] item canonicalType="${canonicalType}" before_repair="${extractedCanonicalType}"`);
            
            // Helper to clean malformed facet values (remove JSON artifacts, trailing punctuation)
            const cleanFacetValue = (value: string | null | undefined): string | null => {
              if (!value || typeof value !== "string") return null;
              // Remove trailing JSON artifacts like `}},]` or `}}` or `,`
              let cleaned = value.trim();
              cleaned = cleaned.replace(/[}},]+$/, "").replace(/[,;]+$/, "").trim();
              return cleaned.length > 0 ? cleaned : null;
            };
            
            // Merge extracted facets with existing constraints (clean values to remove JSON artifacts)
            const mergedFacets = {
              size: cleanFacetValue(facets.size || existingFacets.size) || null,
              color: cleanFacetValue(facets.color || existingFacets.color) || null,
              material: cleanFacetValue(facets.material || existingFacets.material) || null
            };
            
            // Build constraints with per-item facets
            const constraints = item.constraints && typeof item.constraints === "object" ? {
              ...item.constraints,
              optionConstraints: {
                size: mergedFacets.size,
                color: mergedFacets.color,
                material: mergedFacets.material
              }
            } : {
              optionConstraints: mergedFacets,
              priceCeiling: null,
              includeTerms: [],
              excludeTerms: []
            };
            
            normalizedBundleItems.push({
              hardTerms: [canonicalType], // Use canonical_type as the main term
              canonicalType,
              quantity: typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1,
              constraints,
              facets: mergedFacets
            });
          }
          
          // Deduplicate: prevent duplicate bundle items with same canonical_type unless quantity>1
          const seenTypes = new Map<string, number>();
          const deduplicatedItems: typeof normalizedBundleItems = [];
          
          for (const item of normalizedBundleItems) {
            const existingIndex = seenTypes.get(item.canonicalType);
            if (existingIndex !== undefined) {
              // Duplicate canonical_type found - merge quantities if both are quantity=1
              const existing = deduplicatedItems[existingIndex];
              if (existing.quantity === 1 && item.quantity === 1) {
                // Merge: keep first, but this shouldn't happen if LLM is correct
                console.warn(`[Bundle Normalization] Duplicate canonical_type "${item.canonicalType}" detected - keeping first occurrence`);
              } else {
                // Different quantities - keep both (user explicitly requested multiples)
                deduplicatedItems.push(item);
              }
            } else {
              seenTypes.set(item.canonicalType, deduplicatedItems.length);
              deduplicatedItems.push(item);
            }
          }
          
          // Log normalized bundle items
          console.log(`[Bundle Normalization] bundleItems canonical_type + per-item facets:`, 
            deduplicatedItems.map(item => ({
              canonicalType: item.canonicalType,
              quantity: item.quantity,
              facets: item.facets,
              hardTerms: item.hardTerms
            }))
          );
          
          bundleIntent = {
            isBundle: deduplicatedItems.length >= 2,
            items: deduplicatedItems.map(item => ({
              hardTerms: item.hardTerms,
              quantity: item.quantity,
              constraints: item.constraints,
              canonicalType: item.canonicalType // Preserve canonicalType for robust matching
            })),
            totalBudget: typeof intent.totalBudget === "number" && intent.totalBudget > 0 ? intent.totalBudget : null,
            totalBudgetCurrency: typeof intent.totalBudgetCurrency === "string" ? intent.totalBudgetCurrency : null
          };
        } else {
          bundleIntent = {
            isBundle: false,
            items: [],
            totalBudget: typeof intent.totalBudget === "number" && intent.totalBudget > 0 ? intent.totalBudget : null,
            totalBudgetCurrency: typeof intent.totalBudgetCurrency === "string" ? intent.totalBudgetCurrency : null
          };
        }
        
        // If bundle validation failed, ensure isBundle is false
        if (bundleIntent.isBundle && bundleIntent.items.length < 2) {
          bundleIntent.isBundle = false;
          bundleIntent.items = [];
          console.log("[Intent Parsing] ⚠️  Bundle validation failed: less than 2 valid items, treating as single item");
        }
        
        // Merge LLM facets with variant constraints (AFTER bundle normalization)
        // For bundle mode: only set global facets if user explicitly indicates "all/everything/both items" share a facet
        // Check for global facet indicators in userIntent
        const globalFacetPatterns = [
          /\b(?:all|every|everything|both|each)\s+(?:items?|pieces?|things?|products?)\s+(?:are|is|in|should\s+be)\s+(\w+)/i,
          /\b(?:all|every|everything|both|each)\s+in\s+(\w+)/i,
          /\b(\w+)\s+(?:for|on)\s+(?:all|every|everything|both|each)/i
        ];
        
        let hasGlobalFacetIndicator = false;
        for (const pattern of globalFacetPatterns) {
          if (pattern.test(userIntent)) {
            hasGlobalFacetIndicator = true;
            break;
          }
        }
        
        // Merge LLM facets with variant constraints (variant constraints take precedence - explicit user selection wins)
        // For bundle mode: only use global facets if explicitly indicated, otherwise null
        if (bundleIntent.isBundle && !hasGlobalFacetIndicator) {
          // Bundle mode without global indicator: facets are per-item, not global
          hardFacets = {
            size: null,
            color: null,
            material: null
          };
          console.log(`[Bundle Normalization] global facets in bundle mode should be null unless explicitly global - hasGlobalIndicator=${hasGlobalFacetIndicator}`);
        } else {
          // Single-item mode OR bundle with global indicator: use global facets
          hardFacets = {
            size: variantConstraintsForIntent.size || intent.hardFacets?.size || null,
            color: variantConstraintsForIntent.color || intent.hardFacets?.color || null,
            material: variantConstraintsForIntent.material || intent.hardFacets?.material || null
          };
        }
        
        // Bundle mode: apply global hardFacets.size (and material if present) to every bundle item that lacks an explicit per-item size/material
        // Keep global color only when an explicit global indicator exists (do NOT force global color)
        if (bundleIntent.isBundle) {
          let globalSizeAppliedCount = 0;
          let globalMaterialAppliedCount = 0;
          
          // Apply global size to items that don't have explicit per-item size
          if (hardFacets.size) {
            for (let i = 0; i < bundleIntent.items.length; i++) {
              const item = bundleIntent.items[i];
              const itemSize = item.constraints?.optionConstraints?.size;
              if (!itemSize) {
                // Item lacks explicit size - apply global size
                if (!item.constraints) {
                  item.constraints = { optionConstraints: {} };
                }
                if (!item.constraints.optionConstraints) {
                  item.constraints.optionConstraints = {};
                }
                item.constraints.optionConstraints.size = hardFacets.size;
                globalSizeAppliedCount++;
              }
            }
          }
          
          // Apply global material to items that don't have explicit per-item material
          if (hardFacets.material) {
            for (let i = 0; i < bundleIntent.items.length; i++) {
              const item = bundleIntent.items[i];
              const itemMaterial = item.constraints?.optionConstraints?.material;
              if (!itemMaterial) {
                // Item lacks explicit material - apply global material
                if (!item.constraints) {
                  item.constraints = { optionConstraints: {} };
                }
                if (!item.constraints.optionConstraints) {
                  item.constraints.optionConstraints = {};
                }
                item.constraints.optionConstraints.material = hardFacets.material;
                globalMaterialAppliedCount++;
              }
            }
          }
          
          if (globalSizeAppliedCount > 0) {
            console.log(`[Bundle] global_size_applied_to_items count=${globalSizeAppliedCount}`);
          }
          if (globalMaterialAppliedCount > 0) {
            console.log(`[Bundle] global_material_applied_to_items count=${globalMaterialAppliedCount}`);
          }
        }
        
        // Merge preferences into softTerms if not already present
        if (Array.isArray(intent.preferences) && intent.preferences.length > 0) {
          for (const pref of intent.preferences) {
            if (typeof pref === "string" && pref.trim().length > 0) {
              const normalizedPref = pref.trim();
              if (!softTerms.includes(normalizedPref) && !hardTerms.includes(normalizedPref)) {
                softTerms.push(normalizedPref);
              }
            }
          }
        }
        
        console.log("[Intent Parsing] ✅ Using LLM-parsed intent (industry-agnostic)", {
          isBundle: bundleIntent.isBundle,
          bundleItemsCount: bundleIntent.items.length,
          hardTermsCount: hardTerms.length,
          softTermsCount: softTerms.length,
          avoidTermsCount: avoidTerms.length,
          preferencesCount: intent.preferences?.length || 0,
          explicitSelectionsWin: true // Log that explicit user selections take precedence
        });
        
        // Bundle retrieval: fetch per itemType if bundle mode
        if (bundleIntent.isBundle && bundleIntent.items.length >= 2 && accessToken) {
          console.log(`[BundleRetrieval] enabled=true itemCount=${bundleIntent.items.length}`);
          
          const bundleFetchProducts: any[] = [];
          const bundleFetchByItemType = new Map<string, any[]>(); // itemType -> products[]
          
          // Helper to detect budget strings (same as in extractSmartFetchSignals)
          const isBudgetStringLocal = (text: string): boolean => {
            const trimmed = text.trim();
            const lower = trimmed.toLowerCase();
            if (/[\$£€¥]/.test(trimmed)) return true;
            if (/under/i.test(lower) && /\d/.test(trimmed)) return true;
            if (/over/i.test(lower) && /\d/.test(trimmed)) return true;
            if (/and above/i.test(lower) && /\d/.test(trimmed)) return true;
            if (/plus/i.test(lower) && /\d/.test(trimmed)) return true;
            if (/[\+\-]/.test(trimmed) && /\d/.test(trimmed)) return true;
            if (/\d+[\s\-]+to[\s\-]+\d+/i.test(trimmed)) return true;
            if (/\d+[\s\-]+\d+/.test(trimmed)) return true;
            if (/^\$?\d+[\s\-]*(plus|\+|-|to|and above|under)/i.test(trimmed)) return true;
            return false;
          };
          
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
            const item = bundleIntent.items[itemIdx];
            const itemType = (item as any).canonicalType || item.hardTerms[0] || `item${itemIdx}`;
            const itemHardTerms = item.hardTerms || [];
            
            // Extract meaningful attributes (not stopwords, not price tokens)
            const meaningfulTerms = itemHardTerms.filter(term => {
              const lower = term.toLowerCase().trim();
              const stopwords = new Set(["and", "or", "add", "also", "with", "for", "less", "than", "under", "below", "over", "between", "to"]);
              if (stopwords.has(lower)) return false;
              if (/[\$£€¥]/.test(term) || isBudgetStringLocal(term)) return false; // Price tokens
              return term.length >= 3;
            });
            
            if (meaningfulTerms.length === 0) {
              console.log(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} skipped=no_meaningful_terms`);
              continue;
            }
            
            // Build query for this itemType
            const itemSignals = {
              keywords: meaningfulTerms,
              selections: meaningfulTerms.length > 1 ? [meaningfulTerms.join(" ")] : [],
              hasMeaningfulSignals: true
            };
            
            const itemQuery = buildShopifySearchQuery(itemSignals);
            
            if (itemQuery) {
              try {
                console.log(`[SmartFetch] built_query="${itemQuery}"`);
                console.log(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} query="${itemQuery.substring(0, 150)}${itemQuery.length > 150 ? "..." : ""}"`);
                
                const itemFetch = await fetchProductsByQueryPaginated(
                  shopDomain,
                  accessToken,
                  itemQuery,
                  Math.ceil(SMART_FETCH_DESIRED_MIN / bundleIntent.items.length),
                  100
                );
                
                const sampleTitlesItem = itemFetch.products.slice(0, 5).map((p: any) => p.title || "").filter((t: string) => t.length > 0);
                console.log(`[SmartFetch] fetched=${itemFetch.products.length} sample_titles=[${sampleTitlesItem.join(", ")}]`);
                
                // Tag products with itemType for later filtering
                const taggedProducts = itemFetch.products.map((p: any) => ({
                  ...p,
                  _bundleItemType: itemType,
                  _bundleItemIndex: itemIdx
                }));
                
                bundleFetchByItemType.set(itemType, taggedProducts);
                bundleFetchProducts.push(...taggedProducts);
                
                console.log(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} fetched=${taggedProducts.length}`);
                
                // If this itemType has 0 candidates, do broad fallback fetch (no facets/constraints)
                if (taggedProducts.length === 0) {
                  console.log(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} fallback=broad_fetch`);
                  
                  // Broad fallback: just the itemType term, no constraints
                  const fallbackQuery = buildShopifySearchQuery({
                    keywords: [itemType],
                    selections: [],
                    hasMeaningfulSignals: true
                  });
                  
                  if (fallbackQuery) {
                    console.log(`[SmartFetch] built_query="${fallbackQuery}"`);
                    const fallbackFetch = await fetchProductsByQueryPaginated(
                      shopDomain,
                      accessToken,
                      fallbackQuery,
                      50,
                      50
                    );
                    
                    const sampleTitlesFallback = fallbackFetch.products.slice(0, 5).map((p: any) => p.title || "").filter((t: string) => t.length > 0);
                    console.log(`[SmartFetch] fetched=${fallbackFetch.products.length} sample_titles=[${sampleTitlesFallback.join(", ")}]`);
                    
                    const fallbackTagged = fallbackFetch.products.map((p: any) => ({
                      ...p,
                      _bundleItemType: itemType,
                      _bundleItemIndex: itemIdx
                    }));
                    
                    bundleFetchByItemType.set(itemType, fallbackTagged);
                    bundleFetchProducts.push(...fallbackTagged);
                    
                    console.log(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} fallback_fetched=${fallbackTagged.length}`);
                  }
                }
              } catch (error) {
                console.error(`[BundleRetrieval] itemIndex=${itemIdx} itemType=${itemType} error:`, error);
              }
            }
          }
          
          // Deduplicate by handle across all bundle fetches
          const seenHandles = new Set<string>();
          const deduplicatedBundleProducts = bundleFetchProducts.filter((p: any) => {
            if (seenHandles.has(p.handle)) return false;
            seenHandles.add(p.handle);
            return true;
          });
          
          // Store bundle fetch products for merging
          // NOTE: Bundle retrieval happens AFTER initial filtering/enrichment, so these products
          // are NOT merged into the main pool. Instead, they're used directly in bundle item pool building
          // via bundleFetchByItemIndex. This is intentional - bundle products should be filtered per-item,
          // not globally. They will be enriched on-the-fly when building item pools.
          if (deduplicatedBundleProducts.length > 0) {
            bundleFetchProductsForMerge = deduplicatedBundleProducts;
            console.log(`[BundleRetrieval] prepared=${deduplicatedBundleProducts.length} will_use_in_item_pools (not merged - filtered per-item)`);
          }
          
          // Store per-item retrieval sets for building item pools (Issue 2/3 fix)
          // Map itemIndex -> products[] for this item
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
            const item = bundleIntent.items[itemIdx];
            const itemType = (item as any).canonicalType || item.hardTerms[0] || `item${itemIdx}`;
            const itemProducts = bundleFetchByItemType.get(itemType) || [];
            if (itemProducts.length > 0) {
              bundleFetchByItemIndex.set(itemIdx, itemProducts);
              console.log(`[BundleRetrieval] stored_itemPool itemIndex=${itemIdx} itemType=${itemType} count=${itemProducts.length}`);
            }
          }
          
          // Log per-itemType counts
          const perItemCounts = Array.from(bundleFetchByItemType.entries()).map(([type, prods]) => 
            `${type}=${prods.length}`
          ).join(" ");
          console.log(`[BundleRetrieval] per_itemType_counts ${perItemCounts}`);
        }
      } else {
        // Fallback to pattern-based parsing
        console.log("[Intent Parsing] ⚠️  LLM parsing failed, using pattern-based fallback:", llmIntentResult.error || "unknown error");
        
        // Get variant constraints for pattern-based parsing
        const fromAnswersForIntent = parseConstraintsFromAnswers(answersJson);
        const fromTextForIntent = parseConstraintsFromText(userIntent);
        const variantConstraintsForIntent = mergeConstraints(fromAnswersForIntent, fromTextForIntent);
        
        // Parse intent using pattern-based approach (fallback)
      const intentParse = parseIntentGeneric(userIntent, answersJson, variantConstraintsForIntent);
        hardTerms = intentParse.hardTerms;
        softTerms = intentParse.softTerms;
        avoidTerms = intentParse.avoidTerms;
        hardFacets = intentParse.hardFacets;
        
        // Parse bundle intent using pattern-based approach
        bundleIntent = parseBundleIntentGeneric(userIntent);
        
        // SYNONYM EXPANSION: Expand hardTerms using Experience config (industry-agnostic)
        // Parse searchSynonymsJson from experience config
        let searchSynonyms: Record<string, string[]> = {};
        const hasSearchSynonymsJson = experience.searchSynonymsJson !== null && experience.searchSynonymsJson !== undefined;
        let synonymsKeysCount = 0;
        
        try {
          if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "string") {
            searchSynonyms = JSON.parse(experience.searchSynonymsJson);
            synonymsKeysCount = Object.keys(searchSynonyms).length;
          } else if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "object") {
            searchSynonyms = experience.searchSynonymsJson;
            synonymsKeysCount = Object.keys(searchSynonyms).length;
          }
        } catch (e) {
          console.warn("[Synonyms] Failed to parse searchSynonymsJson:", e);
        }
        
        console.log(`[Synonyms] loading exists=${hasSearchSynonymsJson} keys_count=${synonymsKeysCount}`);
        
        // Expand hardTerms with synonyms (one-hop expansion)
        const originalHardTerms = [...hardTerms];
        const expandedHardTerms = new Set<string>(hardTerms);
        const termProvenance = new Map<string, "original" | "synonym">();
        
        // Mark originals
        for (const term of hardTerms) {
          termProvenance.set(term.toLowerCase(), "original");
        }
        
        // Add synonyms
        for (const term of hardTerms) {
          const normalizedTerm = term.toLowerCase();
          const synonyms = searchSynonyms[normalizedTerm] || searchSynonyms[term] || [];
          for (const synonym of synonyms) {
            if (typeof synonym === "string" && synonym.trim().length > 0) {
              const normalizedSynonym = synonym.toLowerCase();
              if (!expandedHardTerms.has(normalizedSynonym)) {
                expandedHardTerms.add(normalizedSynonym);
                termProvenance.set(normalizedSynonym, "synonym");
              }
            }
          }
        }
        
        const expandedHardTermsArray = Array.from(expandedHardTerms);
        const synonymsApplied = expandedHardTermsArray.length > hardTerms.length;
        const expansionChangedTerms = synonymsApplied ? "true" : "false";
        
        console.log(`[Synonyms] applied=${synonymsApplied} expansion_changed_terms=${expansionChangedTerms} originalHardTerms=[${originalHardTerms.join(", ")}] expandedHardTerms=[${expandedHardTermsArray.join(", ")}]`);
        
        // Use expanded terms for gating (but keep original for logging/reasoning)
        hardTerms = expandedHardTermsArray;
      }
      
      // Log intent parsing method used
      console.log(`[Intent Parsing] Method: ${llmIntentUsed ? "LLM" : "pattern-based"}, isBundle: ${bundleIntent.isBundle}, hardTerms: ${hardTerms.length}, avoidTerms: ${avoidTerms.length}`);
      
      // Bundle detection already logged above or in parseBundleIntentGeneric
      
      // ============================================
      // COLLECTION INTENT DETECTION (Multi-item intent for single-item queries)
      // ============================================
      // Only detect collection intent if NOT a bundle (isBundle=false)
      // Collection intent means user wants a mixed set (e.g., "outfit", "set", "kit") without explicit bundle items
      if (!bundleIntent.isBundle) {
        const lowerIntent = userIntent.toLowerCase();
        const collectionPhrases = [
          "outfit", "set", "kit", "bundle", "complete", "whole", "everything i need",
          "for a", "recommend me items for", "build me a", "put together", "create a",
          "full", "entire", "all", "combination", "collection", "ensemble"
        ];
        
        // Check for collection phrases
        const hasCollectionPhrase = collectionPhrases.some(phrase => lowerIntent.includes(phrase));
        
        // Check for event/context soft terms without explicit product type
        // If softTerms contain event/context words (wedding, dinner, interview, work, casual, formal, etc.)
        // AND hardTerms is empty or very minimal, treat as collection intent
        const eventContextTerms = [
          "wedding", "dinner", "interview", "work", "casual", "formal", "party", "event",
          "occasion", "meeting", "date", "business", "professional", "sport", "exercise",
          "travel", "vacation", "holiday", "celebration", "gift", "present"
        ];
        const hasEventContext = softTerms.some(term => 
          eventContextTerms.some(event => term.toLowerCase().includes(event))
        );
        const hasMinimalHardTerms = hardTerms.length <= 1; // Only generic terms like "blue" or "large"
        
        collectionIntent = hasCollectionPhrase || (hasEventContext && hasMinimalHardTerms);
        
        if (collectionIntent) {
          const reason = hasCollectionPhrase 
            ? `collection_phrase:${collectionPhrases.find(p => lowerIntent.includes(p))}`
            : `event_context_without_product_type:${softTerms.filter(t => eventContextTerms.some(e => t.toLowerCase().includes(e))).join(",")}`;
          console.log(`[CollectionIntent] enabled=true reason=${reason} isBundle=false`);
        }
      }
      
      // Log requested groups (normalized) for bundle mode
      if (bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        // Use canonical_type from normalized items (stored in hardTerms[0] after normalization)
        const requestedGroupsNormalized = bundleIntent.items.map((item, idx) => ({
          index: idx,
          label: normalizeItemLabel(item.hardTerms[0] || "unknown"), // This is now canonical_type
          quantity: item.quantity || 1,
        }));
        console.log("[Bundle] requestedGroupsNormalized", requestedGroupsNormalized);
        
        // Log requestedTypes derived from canonical_type (not colors)
        const requestedTypes = bundleIntent.items.map((item, idx) => ({
          index: idx,
          type: normalizeItemLabel(item.hardTerms[0] || "unknown"), // canonical_type
          quantity: item.quantity || 1,
        }));
        console.log("[Bundle] requestedTypes derived from canonical_type (not colors)", requestedTypes);
      }
      
      // Currency conversion: Convert user budget to shop currency
      let convertedPriceMax: number | null = priceMax;
      let convertedTotalBudget: number | null = bundleIntent.totalBudget;
      let currencyMismatch = false;
      
      if (shopCurrency && accessToken) {
        // Get user currency from bundle intent or answers
        const userCurrencyFromBundle = bundleIntent.totalBudgetCurrency || userCurrency;
        
        if (userCurrencyFromBundle && userCurrencyFromBundle !== shopCurrency) {
          currencyMismatch = true;
          const conversionRate = getCurrencyConversionRate(userCurrencyFromBundle, shopCurrency);
          
          if (conversionRate !== 1.0) {
            // Convert if rate available
            if (priceMax !== null) {
              convertedPriceMax = priceMax * conversionRate;
              console.log("[Currency] converted_priceMax", {
                userCurrency: userCurrencyFromBundle,
                shopCurrency,
                originalValue: priceMax,
                convertedValue: convertedPriceMax,
                conversionRate,
                currencyMismatch: true
              });
            }
            if (bundleIntent.totalBudget !== null) {
              convertedTotalBudget = bundleIntent.totalBudget * conversionRate;
              console.log("[Currency] converted_totalBudget", {
                userCurrency: userCurrencyFromBundle,
                shopCurrency,
                originalValue: bundleIntent.totalBudget,
                convertedValue: convertedTotalBudget,
                conversionRate,
                currencyMismatch: true
              });
            }
          } else {
            // No conversion rate - treat as numeric and log mismatch
            console.log("[Currency] currency_mismatch", {
              userCurrency: userCurrencyFromBundle,
              shopCurrency,
              originalValue: priceMax || bundleIntent.totalBudget,
              convertedValue: priceMax || bundleIntent.totalBudget,
              note: "Treating as numeric - no conversion rate available",
              currencyMismatch: true
            });
          }
        } else {
          // Currencies match or no user currency specified
          console.log("[Currency] currency_match", {
            userCurrency: userCurrencyFromBundle || "none",
            shopCurrency,
            note: "Currencies match or no user currency specified",
            currencyMismatch: false
          });
        }
      }
      
      // Use converted values
      priceMax = convertedPriceMax;
      if (bundleIntent.totalBudget !== null) {
        bundleIntent.totalBudget = convertedTotalBudget;
      }
      
      // Calculate dynamic AI window - SMALL-FIRST approach
      // Single-item: 20 candidates for first AI attempt (was 40)
      // Bundle: 15 per item for first AI attempt (was 25)
      // Pre-AI gating/ranking still uses larger pools for quality
      // No hard terms: max 30 candidates (was 60)
      const singleItemWindow = 40; // For top-up and other uses
      const SINGLE_ITEM_AI_WINDOW = 20; // Small-first: first AI attempt only
      const MAX_BUNDLE_PRE_AI_PER_ITEM = 60; // Max candidates per item for bundle mode pre-AI gating/ranking
      const MAX_BUNDLE_AI_PER_ITEM = 15; // Small-first: first AI attempt only (was 25)
      const noHardTermsWindow = 30;
      let aiWindow = Math.min(entitlements.candidateCap, singleItemWindow);
      
      // For bundle/hard-term queries that require AI ranking, process asynchronously to avoid timeouts
      // Check if we need async processing (bundle queries or queries with hard terms that will use AI)
      const willUseAI = bundleIntent.isBundle === true || hardTerms.length > 0;
      
      // Allocate budget per item if total budget provided
      type BundleItemWithBudget = { 
        hardTerms: string[]; 
        quantity: number; 
        budgetMin?: number; 
        budgetMax?: number;
        constraints?: {
          optionConstraints?: { 
        size?: string | null; 
        color?: string | null; 
        material?: string | null;
        allowValues?: Record<string, string[]>; // OR allow-list: attribute -> array of allowed values
      };
          priceCeiling?: number | null;
          includeTerms?: string[];
          excludeTerms?: string[];
        };
      };
      
      /**
       * Strict budget-aware bundle selection helper
       * Rules:
       * 1) Must select at least 1 item from each pool (if pool non-empty)
       * 2) For each itemIndex, first pick the best-ranked candidate WITH price <= allocatedBudget[itemIndex]
       * 3) After primaries, fill remaining slots round-robin, but only if budget constraints are met
       * 4) If totalBudget exists and we can't reach requestedCount, stop early OR fill with cheapest but flag budgetExceeded
       */
      function selectBundleWithinBudget(
        itemPools: Map<number, EnrichedCandidate[]>,
        allocatedBudgets: Map<number, number>,
        totalBudget: number | null,
        requestedCount: number,
        itemCount: number,
        rankedCandidatesByItem?: Map<number, EnrichedCandidate[]>,
        slotPlan?: Map<number, number>
      ): {
        handles: string[];
        trustFallback: boolean;
        budgetExceeded: boolean | null;
        totalPrice: number;
        chosenPrimaries: Map<number, string>;
      } {
        const handles: string[] = [];
        let trustFallback = false;
        let budgetExceeded: boolean | null = null; // null if totalBudget is null, boolean if totalBudget is a number
        let totalPrice = 0;
        const chosenPrimaries = new Map<number, string>();
        const used = new Set<string>();
        
        // Helper to get candidate price
        const getPrice = (c: EnrichedCandidate): number => {
          const price = c.price ? parseFloat(String(c.price)) : NaN;
          return Number.isFinite(price) ? price : Infinity;
        };
        
        // Step 1: Select primaries (at least 1 per itemIndex)
        // CRITICAL: Log item pool sizes for debugging
        console.log("[Bundle Selection] Step 1: Item pool sizes", Array.from({ length: itemCount }, (_, i) => ({
          itemIndex: i,
          poolSize: (itemPools.get(i) || []).length,
          hasPool: itemPools.has(i)
        })));
        
        for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
          const pool = itemPools.get(itemIdx) || [];
          if (pool.length === 0) {
            console.warn(`[Bundle Selection] ⚠️  Item ${itemIdx} has empty pool - skipping primary selection`);
            trustFallback = true;
            continue;
          }
          
          const allocatedBudget = allocatedBudgets.get(itemIdx);
          
          // Use ranked candidates if provided, otherwise use pool order
          const candidatesToCheck = rankedCandidatesByItem?.get(itemIdx) || pool;
          
          // Find best candidate (prefer within budget, but still select if none fit)
          let selected: EnrichedCandidate | null = null;
          if (allocatedBudget !== undefined && allocatedBudget !== null) {
            // Try to find candidate within allocated budget first
            for (const c of candidatesToCheck) {
              if (used.has(c.handle)) continue;
              const price = getPrice(c);
              if (price <= allocatedBudget) {
                selected = c;
                break;
              }
            }
            
            // If none fit, pick cheapest (budget is soft constraint)
            if (!selected) {
              const sorted = [...pool].filter(c => !used.has(c.handle)).sort((a, b) => getPrice(a) - getPrice(b));
              if (sorted.length > 0) {
                selected = sorted[0];
                trustFallback = true;
              }
            }
          } else {
            // No allocated budget, pick first available
            for (const c of candidatesToCheck) {
              if (!used.has(c.handle)) {
                selected = c;
                break;
              }
            }
          }
          
          if (selected) {
            const price = getPrice(selected);
            // Always add primary - budget is a soft constraint
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += price;
              chosenPrimaries.set(itemIdx, selected.handle);
            
            // Mark budget exceeded if needed, but still add the primary
            if (totalBudget !== null && typeof totalBudget === "number" && totalPrice > totalBudget) {
              budgetExceeded = true;
              trustFallback = true;
            }
          }
        }
        
        // Step 2: Fill remaining slots using proportional distribution from slotPlan
        const handlesByItem = new Map<number, string[]>();
        
        // Initialize handlesByItem with primaries
        for (const [itemIdx, handle] of chosenPrimaries) {
          handlesByItem.set(itemIdx, [handle]);
        }
        
        // Determine target counts per item based on slotPlan (proportional distribution)
        const targetCountsByItem = new Map<number, number>();
        if (slotPlan && slotPlan.size > 0) {
          // Use slotPlan for proportional distribution
          console.log("[Bundle Selection] Using slotPlan for proportional distribution", Array.from(slotPlan.entries()).map(([idx, slots]) => ({ itemIndex: idx, slots })));
          for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
            targetCountsByItem.set(itemIdx, slotPlan.get(itemIdx) || 0);
          }
        } else {
          // Fallback: distribute evenly if no slotPlan
          console.log("[Bundle Selection] No slotPlan - distributing evenly");
          const slotsPerItem = Math.floor(requestedCount / itemCount);
          const extraSlots = requestedCount % itemCount;
          for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
            targetCountsByItem.set(itemIdx, slotsPerItem + (itemIdx < extraSlots ? 1 : 0));
          }
        }
        
        console.log("[Bundle Selection] Target counts per item", Array.from(targetCountsByItem.entries()).map(([idx, count]) => ({ itemIndex: idx, targetCount: count })));
        
        // Fill each item type to its target count (proportional distribution)
        console.log("[Bundle Selection] Step 2: Starting proportional fill", {
          requestedCount,
          currentHandlesCount: handles.length,
          primariesCount: chosenPrimaries.size
        });
        
        for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
          const pool = itemPools.get(itemIdx) || [];
          const currentHandles = handlesByItem.get(itemIdx) || [];
          const targetCount = targetCountsByItem.get(itemIdx) || 0;
          const allocatedBudget = allocatedBudgets.get(itemIdx);
          
          console.log(`[Bundle Selection] Filling item ${itemIdx}: poolSize=${pool.length}, currentHandles=${currentHandles.length}, targetCount=${targetCount}`);
          
          // Fill up to target count for this item type
          while (currentHandles.length < targetCount && handles.length < requestedCount) {
            const candidatesToCheck = rankedCandidatesByItem?.get(itemIdx) || pool;
          let added = false;
            
            // First pass: try to find candidates within budget (prefer budget-friendly)
            for (const candidate of candidatesToCheck) {
            if (used.has(candidate.handle)) continue;
              if (currentHandles.length >= targetCount) break;
            
            const price = getPrice(candidate);
            
              // Prefer candidates within allocated budget, but don't require it
            if (allocatedBudget !== undefined && allocatedBudget !== null) {
                const currentSpent = currentHandles.reduce((sum, h) => {
                const c = pool.find(p => p.handle === h);
                return sum + (c ? getPrice(c) : 0);
                }, 0);
                const remainingAllocated = allocatedBudget - currentSpent;
                
                // Prefer within allocated budget, but still add if exceeds (soft constraint)
                if (price > remainingAllocated && currentHandles.length > 0) {
                  // Already have at least one, prefer budget-friendly but continue if needed
                  continue;
                }
              }
              
              // Add candidate (budget is soft - always fill slots)
            handles.push(candidate.handle);
            used.add(candidate.handle);
            totalPrice += price;
              currentHandles.push(candidate.handle);
            added = true;
            break;
          }
          
            // Second pass: if couldn't add within budget, add cheapest available (ensure we fill slots)
            if (!added && currentHandles.length < targetCount) {
              const available = pool.filter(c => !used.has(c.handle));
              if (available.length > 0) {
                const cheapest = available.sort((a, b) => getPrice(a) - getPrice(b))[0];
                handles.push(cheapest.handle);
                used.add(cheapest.handle);
                totalPrice += getPrice(cheapest);
                currentHandles.push(cheapest.handle);
                trustFallback = true;
                added = true; // Mark as added so we continue the loop
              } else {
                break; // No more candidates for this type
              }
            }
            
            if (!added) break; // Couldn't add any candidate for this iteration
          }
          
          handlesByItem.set(itemIdx, currentHandles);
        }
        
        // Step 3: If still under requestedCount, fill remaining slots round-robin (ensure full count)
        if (handles.length < requestedCount) {
          const itemIndices = Array.from({ length: itemCount }, (_, i) => i);
          let roundRobinIdx = 0;
          
          while (handles.length < requestedCount && roundRobinIdx < 200) {
            const currentItemIdx = itemIndices[roundRobinIdx % itemIndices.length];
            const pool = itemPools.get(currentItemIdx) || [];
            
            // Find any available candidate (budget is soft constraint)
            let added = false;
            for (const candidate of pool) {
              if (used.has(candidate.handle)) continue;
              if (handles.length >= requestedCount) break;
              
              // Add candidate regardless of budget (ensure full count)
              handles.push(candidate.handle);
              used.add(candidate.handle);
              totalPrice += getPrice(candidate);
              const currentHandles = handlesByItem.get(currentItemIdx) || [];
              currentHandles.push(candidate.handle);
              handlesByItem.set(currentItemIdx, currentHandles);
              added = true;
              break;
            }
            
            if (!added) break; // No more candidates available
          roundRobinIdx++;
          }
        }
        
        // Set budgetExceeded: null if totalBudget is null, boolean if totalBudget is a number
        if (totalBudget === null) {
          budgetExceeded = null;
        } else if (typeof totalBudget === "number") {
          budgetExceeded = totalPrice > totalBudget;
        }
        
        return { handles, trustFallback, budgetExceeded, totalPrice, chosenPrimaries };
      }
      
      /**
       * 3-pass bundle top-up ladder
       * PASS 1: Strict (only correct item pools, enforce per-item + total budget, prefer inStock, cheapest-first)
       * PASS 2: Relaxed allocation (ignore per-item caps, enforce only totalBudget, cheapest-first)
       * PASS 3: Relaxed substitutes (allow substitutes for small pools, enforce totalBudget if possible, else exceed with trustFallback)
       */
      function bundleTopUp3Pass(
        existingHandles: string[],
        bundleItemPools: Map<number, EnrichedCandidate[]>,
        allocatedBudgets: Map<number, number>,
        totalBudget: number | null,
        requestedCount: number,
        bundleItemsWithBudget: Array<{ 
          hardTerms: string[]; 
          quantity: number;
          constraints?: {
            optionConstraints?: {
              size?: string | null;
              color?: string | null;
              material?: string | null;
            };
          };
        }>,
        inStockOnly: boolean,
        experience: any
      ): {
        handles: string[];
        trustFallback: boolean;
        budgetExceeded: boolean | null;
        totalPrice: number;
        pass1Added: number;
        pass2Added: number;
        pass3Added: number;
      } {
        const used = new Set<string>(existingHandles);
        const handles = [...existingHandles];
        let trustFallback = false;
        let budgetExceeded: boolean | null = null; // null if totalBudget is null, boolean if totalBudget is a number
        let totalPrice = existingHandles.reduce((sum, handle) => {
          // Calculate existing total price from item pools
          for (const pool of bundleItemPools.values()) {
            const c = pool.find(p => p.handle === handle);
            if (c) {
              const price = c.price ? parseFloat(String(c.price)) : NaN;
              return sum + (Number.isFinite(price) ? price : 0);
            }
          }
          return sum;
        }, 0);
        
        let pass1Added = 0;
        let pass2Added = 0;
        let pass3Added = 0;
        
        const getPrice = (c: EnrichedCandidate): number => {
          const price = c.price ? parseFloat(String(c.price)) : NaN;
          return Number.isFinite(price) ? price : Infinity;
        };
        
        const isAvailable = (c: EnrichedCandidate): boolean => {
          if (!inStockOnly) return true;
          return c.available === true;
        };
        
        // PASS 1: Strict
        while (handles.length < requestedCount) {
          let added = false;
          const itemIndices = Array.from({ length: bundleItemsWithBudget.length }, (_, i) => i);
          
          // Round-robin across items
          for (const itemIdx of itemIndices) {
            if (handles.length >= requestedCount) break;
            const pool = bundleItemPools.get(itemIdx) || [];
            const allocatedBudget = allocatedBudgets.get(itemIdx);
            const bundleItem = bundleItemsWithBudget[itemIdx];
            const itemOptionConstraints = bundleItem?.constraints?.optionConstraints;
            const itemFacets = {
              size: itemOptionConstraints?.size ?? null,
              color: itemOptionConstraints?.color ?? null,
              material: itemOptionConstraints?.material ?? null,
            };
            
            // Filter candidates: available if needed, within allocated budget, within total budget, and per-item facets
            const candidates = pool
              .filter(c => !used.has(c.handle))
              .filter(c => isAvailable(c))
              .filter(c => {
                const price = getPrice(c);
                if (allocatedBudget !== undefined && allocatedBudget !== null) {
                  if (price > allocatedBudget) return false;
                }
                // Budget guard ONLY when totalBudget is a number
                if (totalBudget !== null && typeof totalBudget === "number") {
                  const projectedTotal = totalPrice + price;
                  if (projectedTotal > totalBudget) return false;
                }
                // Check per-item facets (size/color/material) if specified
                // Do NOT fail items when product has no extracted colors/sizes/materials
                if (itemFacets.size && c.sizes.length > 0) {
                  const sizeMatch = c.sizes.some((s: string) => 
                    normalizeText(s) === normalizeText(itemFacets.size) ||
                    normalizeText(s).includes(normalizeText(itemFacets.size)) ||
                    normalizeText(itemFacets.size).includes(normalizeText(s))
                  );
                  if (!sizeMatch) return false;
                }
                // If itemFacets.size is specified but candidate has no sizes, don't fail (passes check)
                
                if (itemFacets.color && c.colors.length > 0) {
                  const colorMatch = c.colors.some((col: string) => 
                    normalizeText(col) === normalizeText(itemFacets.color) ||
                    normalizeText(col).includes(normalizeText(itemFacets.color)) ||
                    normalizeText(itemFacets.color).includes(normalizeText(col))
                  );
                  if (!colorMatch) return false;
                }
                // If itemFacets.color is specified but candidate has no colors, don't fail (passes check)
                
                if (itemFacets.material && c.materials.length > 0) {
                  const materialMatch = c.materials.some((m: string) => 
                    normalizeText(m) === normalizeText(itemFacets.material) ||
                    normalizeText(m).includes(normalizeText(itemFacets.material)) ||
                    normalizeText(itemFacets.material).includes(normalizeText(m))
                  );
                  if (!materialMatch) return false;
                }
                // If itemFacets.material is specified but candidate has no materials, don't fail (passes check)
                
                return true;
              })
              .sort((a, b) => getPrice(a) - getPrice(b)); // cheapest first
            
            if (candidates.length > 0) {
              const selected = candidates[0];
              const candidatePrice = getPrice(selected);
              const projectedTotal = totalPrice + candidatePrice;
              
              // Budget guard: skip if adding would exceed budget
              if (totalBudget !== null && projectedTotal > totalBudget) {
                console.log("[Bundle TopUp] budget_guard", {
                  currentTotal: totalPrice,
                  candidatePrice,
                  projectedTotal,
                  budget: totalBudget,
                  added: false
                });
                continue; // Skip this candidate, try next
              }
              
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += candidatePrice;
              pass1Added++;
              added = true;
              console.log("[Bundle TopUp] budget_guard", {
                currentTotal: totalPrice - candidatePrice,
                candidatePrice,
                projectedTotal: totalPrice,
                budget: totalBudget,
                added: true
              });
              break; // One per round-robin cycle
            }
          }
          
          if (!added) break;
        }
        
        // PASS 2: Relaxed allocation (ignore per-item caps, enforce only totalBudget)
        while (handles.length < requestedCount) {
          let added = false;
          const itemIndices = Array.from({ length: bundleItemsWithBudget.length }, (_, i) => i);
          
          for (const itemIdx of itemIndices) {
            if (handles.length >= requestedCount) break;
            const pool = bundleItemPools.get(itemIdx) || [];
            
            // Filter: available if needed, within total budget only (ignore allocated budget)
            const candidates = pool
              .filter(c => !used.has(c.handle))
              .filter(c => isAvailable(c))
              .filter(c => {
                const price = getPrice(c);
                // Budget guard ONLY when totalBudget is a number
                if (totalBudget !== null && typeof totalBudget === "number") {
                  const projectedTotal = totalPrice + price;
                  if (projectedTotal > totalBudget) return false;
                }
                return true;
              })
              .sort((a, b) => getPrice(a) - getPrice(b));
            
            if (candidates.length > 0) {
              const selected = candidates[0];
              const candidatePrice = getPrice(selected);
              const projectedTotal = totalPrice + candidatePrice;
              
              // Budget guard: skip if adding would exceed budget
              if (totalBudget !== null && projectedTotal > totalBudget) {
                console.log("[Bundle TopUp] budget_guard", {
                  currentTotal: totalPrice,
                  candidatePrice,
                  projectedTotal,
                  budget: totalBudget,
                  added: false
                });
                continue; // Skip this candidate, try next
              }
              
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += candidatePrice;
              pass2Added++;
              added = true;
              console.log("[Bundle TopUp] budget_guard", {
                currentTotal: totalPrice - candidatePrice,
                candidatePrice,
                projectedTotal: totalPrice,
                budget: totalBudget,
                added: true
              });
              break;
            }
          }
          
          if (!added) break;
        }
        
        // PASS 3: Relaxed substitutes (allow substitutes, but never exceed budget)
        // Only proceed if we still need more items AND haven't exceeded budget (if budget exists)
        const shouldContinuePass3 = handles.length < requestedCount && 
          (totalBudget === null || typeof totalBudget !== "number" || totalPrice < totalBudget);
        
        if (shouldContinuePass3) {
          // Build substitute pools
          const substituteMap = new Map<number, string[]>(); // itemIdx -> substitute terms
          for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
            const item = bundleItemsWithBudget[itemIdx];
            // Industry-agnostic: No hardcoded substitutes
            // The system should rely on user-provided terms and linguistic patterns
            // Substitutes would introduce industry-specific assumptions
            // If needed, substitutes can be extracted from user query context, not hardcoded
            const substitutes: string[] = [];
            
            // Empty substitutes array - no industry-specific assumptions
            if (substitutes.length > 0) {
              substituteMap.set(itemIdx, substitutes);
            }
          }
          
          // Check if any item pool is too small (< 5 candidates)
          const needsSubstitutes = Array.from({ length: bundleItemsWithBudget.length }, (_, i) => {
            const pool = bundleItemPools.get(i) || [];
            const availableInPool = pool.filter(c => !used.has(c.handle)).length;
            return availableInPool < 5;
          });
          
          while (handles.length < requestedCount) {
          let added = false;
          const itemIndices = Array.from({ length: bundleItemsWithBudget.length }, (_, i) => i);
          
          for (const itemIdx of itemIndices) {
            if (handles.length >= requestedCount) break;
            const pool = bundleItemPools.get(itemIdx) || [];
            const substitutes = substituteMap.get(itemIdx) || [];
            const needsSubstitute = needsSubstitutes[itemIdx];
            
            // Build candidate list: primary pool first, then substitutes if needed
            let candidates: EnrichedCandidate[] = [];
            
            // Primary pool
            const primaryCandidates = pool
              .filter(c => !used.has(c.handle))
              .filter(c => !inStockOnly || c.available === true)
              .sort((a, b) => getPrice(a) - getPrice(b));
            
            candidates.push(...primaryCandidates);
            
            // If pool too small, add substitutes
            if (needsSubstitute && substitutes.length > 0) {
              // Find substitute candidates from other pools
              for (const subTerm of substitutes) {
                for (let otherIdx = 0; otherIdx < bundleItemsWithBudget.length; otherIdx++) {
                  if (otherIdx === itemIdx) continue;
                  const otherPool = bundleItemPools.get(otherIdx) || [];
                  const subCandidates = otherPool
                    .filter(c => !used.has(c.handle))
                    .filter(c => !inStockOnly || c.available === true)
                    .filter(c => {
                      const haystack = [
                        c.title || "",
                        c.productType || "",
                        (c.tags || []).join(" "),
                        c.vendor || "",
                        c.searchText || "",
                      ].join(" ").toLowerCase();
                      return haystack.includes(subTerm);
                    })
                    .sort((a, b) => getPrice(a) - getPrice(b));
                  candidates.push(...subCandidates);
                }
              }
            }
            
            // Remove duplicates
            candidates = candidates.filter((c, idx, arr) => arr.findIndex(x => x.handle === c.handle) === idx);
            
            // Try to respect totalBudget first (ONLY when totalBudget is a number)
            const withinBudget = candidates.filter(c => {
              const price = getPrice(c);
              if (totalBudget !== null && typeof totalBudget === "number") {
                const projectedTotal = totalPrice + price;
                return projectedTotal <= totalBudget;
              }
              return true;
            });
            
            // Only select candidates that fit within budget (never exceed intentionally)
            let selected: EnrichedCandidate | null = null;
            if (withinBudget.length > 0) {
              selected = withinBudget[0]; // Already sorted by price (cheapest first)
            }
            // Do NOT select candidates that would exceed budget - skip instead
            
            if (selected) {
              const candidatePrice = getPrice(selected);
              const projectedTotal = totalPrice + candidatePrice;
              
              // Budget guard: skip if adding would exceed budget
              if (totalBudget !== null && projectedTotal > totalBudget) {
                console.log("[Bundle TopUp] budget_guard", {
                  currentTotal: totalPrice,
                  candidatePrice,
                  projectedTotal,
                  budget: totalBudget,
                  added: false
                });
                continue; // Skip this candidate, try next item
              }
              
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += candidatePrice;
              pass3Added++;
              added = true;
              console.log("[Bundle TopUp] budget_guard", {
                currentTotal: totalPrice - candidatePrice,
                candidatePrice,
                projectedTotal: totalPrice,
                budget: totalBudget,
                added: true
              });
              break;
            }
          }
          
            if (!added) break;
          }
        }
        
        // Set budgetExceeded: null if totalBudget is null, boolean if totalBudget is a number
        // budgetExceeded should only be true if even the initial required set cannot fit budget
        // During top-up, we never intentionally exceed budget, so only check if initial set exceeded
        if (totalBudget === null) {
          budgetExceeded = null;
        } else if (typeof totalBudget === "number") {
          budgetExceeded = totalPrice > totalBudget;
        }
        
        return { handles, trustFallback, budgetExceeded, totalPrice, pass1Added, pass2Added, pass3Added };
      }
      
      function allocateBudgetPerItem(
        items: Array<{ hardTerms: string[]; quantity: number }>,
        totalBudget: number
      ): BundleItemWithBudget[] {
        if (items.length === 0) return [];
        
        const allocated: Array<{ hardTerms: string[]; quantity: number; budgetMin?: number; budgetMax?: number }> = [];
        
        if (items.length === 1) {
          // Single item gets full budget
          allocated.push({ ...items[0], budgetMax: totalBudget });
        } else if (items.length === 2) {
          // First item 70%, second 30%
          allocated.push({ ...items[0], budgetMax: totalBudget * 0.7 });
          allocated.push({ ...items[1], budgetMax: totalBudget * 0.3 });
        } else {
          // 3+ items: first 60%, rest split evenly
          const remainingPercent = 0.4 / (items.length - 1);
          allocated.push({ ...items[0], budgetMax: totalBudget * 0.6 });
          for (let i = 1; i < items.length; i++) {
            allocated.push({ ...items[i], budgetMax: totalBudget * remainingPercent });
          }
        }
        
        return allocated;
      }
      
      // Slot allocation: distribute resultCount across bundle items
      // Minimum 1 slot per type, distribute remaining evenly or weighted by prominence
      function allocateSlotsAcrossTypes(
        items: Array<{ hardTerms: string[]; quantity: number }>,
        totalSlots: number
      ): Map<number, number> {
        const slotPlan = new Map<number, number>();
        const itemCount = items.length;
        
        if (itemCount === 0) {
          return slotPlan;
        }
        
        // Minimum 1 slot per type
        const minSlotsPerType = 1;
        const reservedSlots = itemCount * minSlotsPerType;
        const remainingSlots = Math.max(0, totalSlots - reservedSlots);
        
        // Distribute minimum slots
        for (let i = 0; i < itemCount; i++) {
          slotPlan.set(i, minSlotsPerType);
        }
        
        // Distribute remaining slots: weight by quantity or evenly
        if (remainingSlots > 0) {
          const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
          
          if (totalQuantity > 0) {
            // Weighted by quantity (primary type prominence)
            for (let i = 0; i < itemCount; i++) {
              const weight = items[i].quantity / totalQuantity;
              const additionalSlots = Math.floor(remainingSlots * weight);
              slotPlan.set(i, slotPlan.get(i)! + additionalSlots);
            }
            
            // Distribute any remaining slots due to rounding errors
            const allocatedRemaining = Array.from(slotPlan.values()).reduce((sum, slots) => sum + slots, 0) - reservedSlots;
            const stillRemaining = remainingSlots - allocatedRemaining;
            if (stillRemaining > 0) {
              // Distribute to first items until exhausted
              for (let i = 0; i < stillRemaining && i < itemCount; i++) {
                slotPlan.set(i, slotPlan.get(i)! + 1);
              }
            }
          } else {
            // Even distribution if no quantities specified
            const slotsPerType = Math.floor(remainingSlots / itemCount);
            const extraSlots = remainingSlots % itemCount;
            
            for (let i = 0; i < itemCount; i++) {
              slotPlan.set(i, slotPlan.get(i)! + slotsPerType + (i < extraSlots ? 1 : 0));
            }
          }
        }
        
        return slotPlan;
      }
      
      const bundleItemsWithBudget: BundleItemWithBudget[] = bundleIntent.isBundle && bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number"
        ? allocateBudgetPerItem(bundleIntent.items, bundleIntent.totalBudget).map((item, idx) => ({
            ...item,
            constraints: bundleIntent.items[idx]?.constraints
          }))
        : bundleIntent.items.map(item => ({ 
            ...item,
            constraints: item.constraints
          }));
      
      // Slot allocation plan for bundle mode
      let slotPlan: Map<number, number> = new Map();
      if (bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        slotPlan = allocateSlotsAcrossTypes(bundleIntent.items, finalResultCount);
        
        // Log requestedTypes, slotPlan
        const requestedTypes = bundleIntent.items.map((item, idx) => ({
          index: idx,
          type: item.hardTerms[0] || "unknown",
          quantity: item.quantity,
          slots: slotPlan.get(idx) || 0
        }));
        
        console.log("[Bundle] requestedTypes", requestedTypes.map(r => ({
          index: r.index,
          type: r.type,
          quantity: r.quantity,
          slots: r.slots
        })));
        
        console.log("[Bundle] slotPlan", {
          totalRequested: finalResultCount,
          allocatedSlots: Array.from(slotPlan.entries()).map(([idx, slots]) => ({
            itemIndex: idx,
            type: bundleIntent.items[idx]?.hardTerms[0] || "unknown",
            slots
          })),
          totalAllocated: Array.from(slotPlan.values()).reduce((sum, slots) => sum + slots, 0)
        });
      }
      
      if (bundleIntent.isBundle) {
        // Log when no budget is provided
        if (bundleIntent.totalBudget === null) {
          console.log("[Bundle] no budget provided - skipping budget constraint");
        }
        const allocatedBudgetsMap = new Map<number, number>();
        bundleItemsWithBudget.forEach((item, idx) => {
          if (item.budgetMax !== undefined && item.budgetMax !== null) {
            allocatedBudgetsMap.set(idx, item.budgetMax);
          }
        });
        console.log("[Bundle Budget] totalBudget=", bundleIntent.totalBudget, "allocated=", 
          Array.from(allocatedBudgetsMap.entries()).map(([idx, budget]) => `item${idx}=${budget.toFixed(2)}`).join(" "));
      }
      
      console.log("[App Proxy] [Layer 2] Hard terms:", hardTerms);
      console.log("[App Proxy] [Layer 2] Soft terms:", softTerms);
      console.log("[App Proxy] [Layer 2] Avoid terms:", avoidTerms);
      console.log("[App Proxy] [Layer 2] Hard facets:", hardFacets);
      
      // Tokenize query terms
      const hardTermTokens = hardTerms.flatMap(t => tokenize(t));
      const softTermTokens = softTerms.flatMap(t => tokenize(t));
      const allQueryTokens = [...hardTermTokens, ...softTermTokens];
      
      // Build BM25 index
      const idf = calculateIDF(candidateDocs.map(d => ({ tokens: d.tokens })));
      const avgDocLen = candidateDocs.reduce((sum, d) => sum + d.tokens.length, 0) / candidateDocs.length || 1;
      
      // Initialize variantConstraints2 BEFORE gating (needed in filter callback)
      // Build variantPreferences with priority (Answers > Text) - needed for constraints
      const prefsFromAnswers = parsePreferencesFromAnswers(answersJson, knownOptionNames);
      
      // In bundle mode, only parse preferences from text if user explicitly indicates global constraints
      let prefsFromText: VariantPreferences = {};
      if (bundleIntent.isBundle) {
        // Check for global facet indicators in userIntent (same logic as hasGlobalFacetIndicator)
        const globalFacetPatterns = [
          /\b(?:all|every|everything|both|each)\s+(?:items?|pieces?|things?|products?)\s+(?:are|is|in|should\s+be)\s+(\w+)/i,
          /\b(?:all|every|everything|both|each)\s+in\s+(\w+)/i,
          /\b(\w+)\s+(?:for|on)\s+(?:all|every|everything|both|each)/i
        ];
        
        let hasGlobalFacetIndicator = false;
        for (const pattern of globalFacetPatterns) {
          if (pattern.test(userIntent)) {
            hasGlobalFacetIndicator = true;
            break;
          }
        }
        
        if (hasGlobalFacetIndicator) {
          prefsFromText = parsePreferencesFromText(userIntent, knownOptionNames);
        } else {
          // Bundle mode without global indicator: ignore parsePreferencesFromText for global constraints
          prefsFromText = {};
        }
      } else {
        prefsFromText = parsePreferencesFromText(userIntent, knownOptionNames);
      }
      
      const variantPreferences = mergePreferences(prefsFromAnswers, prefsFromText);
      
      // Build variant constraints for gating (with OR allow-list support)
      const sizeKey = knownOptionNames.find(n => n.toLowerCase() === "size") ?? null;
      const colorKey = knownOptionNames.find(n => ["color","colour","shade"].includes(n.toLowerCase())) ?? null;
      const materialKey = knownOptionNames.find(n => ["material","fabric"].includes(n.toLowerCase())) ?? null;

      // In bundle mode, disable global variant constraints unless explicitly global
      let derived = {
        size: sizeKey ? (variantPreferences[sizeKey] ?? null) : null,
        color: colorKey ? (variantPreferences[colorKey] ?? null) : null,
        material: materialKey ? (variantPreferences[materialKey] ?? null) : null,
      };
      
      if (bundleIntent.isBundle) {
        // Check for global facet indicators in userIntent
        const globalFacetPatterns = [
          /\b(?:all|every|everything|both|each)\s+(?:items?|pieces?|things?|products?)\s+(?:are|is|in|should\s+be)\s+(\w+)/i,
          /\b(?:all|every|everything|both|each)\s+in\s+(\w+)/i,
          /\b(\w+)\s+(?:for|on)\s+(?:all|every|everything|both|each)/i
        ];
        
        let hasGlobalFacetIndicator = false;
        for (const pattern of globalFacetPatterns) {
          if (pattern.test(userIntent)) {
            hasGlobalFacetIndicator = true;
            break;
          }
        }
        
        if (!hasGlobalFacetIndicator) {
          // Bundle mode without global indicator: set derived constraints to null
          derived = {
            size: null,
            color: null,
            material: null,
          };
          console.log("[Bundle] global_variant_constraints=false");
        }
      }

      const fromAnswersForVariant = parseConstraintsFromAnswers(answersJson);
      
      // In bundle mode, skip free-text-derived global variant constraints unless explicitly global
      let fromTextForVariant: VariantConstraints = { size: null, color: null, material: null };
      if (bundleIntent.isBundle) {
        // Check for global facet indicators in userIntent
        const globalFacetPatterns = [
          /\b(?:all|every|everything|both|each)\s+(?:items?|pieces?|things?|products?)\s+(?:are|is|in|should\s+be)\s+(\w+)/i,
          /\b(?:all|every|everything|both|each)\s+in\s+(\w+)/i,
          /\b(\w+)\s+(?:for|on)\s+(?:all|every|everything|both|each)/i
        ];
        
        let hasGlobalFacetIndicator = false;
        for (const pattern of globalFacetPatterns) {
          if (pattern.test(userIntent)) {
            hasGlobalFacetIndicator = true;
            break;
          }
        }
        
        if (hasGlobalFacetIndicator) {
          // Bundle mode with global indicator: allow free-text-derived constraints
          fromTextForVariant = parseConstraintsFromText(userIntent);
        } else {
          // Bundle mode without global indicator: skip free-text-derived constraints
          fromTextForVariant = { size: null, color: null, material: null };
          console.log("[Bundle] global_variant_constraints_skipped=true reason=\"bundle_mode\"");
        }
      } else {
        // Single-item mode: use free-text-derived constraints
        fromTextForVariant = parseConstraintsFromText(userIntent);
      }
      
      const variantConstraints = mergeConstraints(fromAnswersForVariant, fromTextForVariant);
      let variantConstraints2 = mergeConstraints(variantConstraints, derived);
      
      // Issue 1 fix: Set degraded facets to null in variantConstraints
      if (degradedFacetsMap.size > 0) {
        if (degradedFacetsMap.has("color")) variantConstraints2.color = null;
        if (degradedFacetsMap.has("size")) variantConstraints2.size = null;
        if (degradedFacetsMap.has("material")) variantConstraints2.material = null;
        const degradedList = Array.from(degradedFacetsMap.keys()).join(",");
        console.log(`[Degrade] variantConstraints cleared for degraded facets=${degradedList}`);
      }
      
      console.log("[App Proxy] Variant constraints:", variantConstraints2);
      
      // Calculate BM25 scores and apply gating
      console.log("[App Proxy] [Layer 2] Applying hard gating");
      
      // Gate 1: Hard facets (industry-agnostic: any facet type) - with OR allow-list support
      // STEP 1: Compute facet coverage before gating (for ALL facets, not just size/color/material)
      const beforeFacetGating = allCandidatesEnriched.length;
      const totalCandidates = allCandidatesEnriched.length;
      
      // Helper to clean malformed facet values (remove JSON artifacts, trailing punctuation)
      const cleanFacetValue = (value: string | null | undefined): string | null => {
        if (!value || typeof value !== "string") return null;
        // Remove trailing JSON artifacts like `}},]` or `}}` or `,`
        let cleaned = value.trim();
        // Remove trailing punctuation and JSON-like artifacts
        cleaned = cleaned.replace(/[}},]+$/, "").replace(/[,;]+$/, "").trim();
        return cleaned.length > 0 ? cleaned : null;
      };
      
      // Build a map of all constraints (from hardFacets + variantConstraints2.allowValues + bundle per-item constraints)
      // This makes it industry-agnostic - works for any facet type (size, color, material, scent, finish, capacity, etc.)
      const allConstraints = new Map<string, string>(); // facetName -> constraintValue
      
      // Add constraints from hardFacets (backwards compatibility for size/color/material)
      if (hardFacets.size) {
        const cleaned = cleanFacetValue(hardFacets.size);
        if (cleaned) allConstraints.set("size", cleaned);
      }
      if (hardFacets.color) {
        const cleaned = cleanFacetValue(hardFacets.color);
        if (cleaned) allConstraints.set("color", cleaned);
      }
      if (hardFacets.material) {
        const cleaned = cleanFacetValue(hardFacets.material);
        if (cleaned) allConstraints.set("material", cleaned);
      }
      
      // Add constraints from variantConstraints2.allowValues (generic, works for any facet)
      if (variantConstraints2.allowValues) {
        for (const [facetName, allowedValues] of Object.entries(variantConstraints2.allowValues)) {
          // For allowValues, we use the first value as the primary constraint (OR logic handled in gating)
          if (Array.isArray(allowedValues) && allowedValues.length > 0) {
            const normalizedFacetName = normalizeOptionName(facetName);
            const cleaned = cleanFacetValue(allowedValues[0]);
            if (cleaned && !allConstraints.has(normalizedFacetName)) {
              allConstraints.set(normalizedFacetName, cleaned);
            }
          }
        }
      }
      
      // Add constraints from bundle per-item facets (for bundle mode coverage calculation)
      if (bundleIntent.isBundle && bundleIntent.items.length > 0) {
        for (const item of bundleIntent.items) {
          const itemOptionConstraints = item.constraints?.optionConstraints;
          if (itemOptionConstraints) {
            if (itemOptionConstraints.size) {
              const cleaned = cleanFacetValue(itemOptionConstraints.size);
              if (cleaned && !allConstraints.has("size")) {
                allConstraints.set("size", cleaned); // Use first item's size for coverage
              }
            }
            if (itemOptionConstraints.color) {
              const cleaned = cleanFacetValue(itemOptionConstraints.color);
              if (cleaned && !allConstraints.has("color")) {
                allConstraints.set("color", cleaned); // Use first item's color for coverage
              }
            }
            if (itemOptionConstraints.material) {
              const cleaned = cleanFacetValue(itemOptionConstraints.material);
              if (cleaned && !allConstraints.has("material")) {
                allConstraints.set("material", cleaned); // Use first item's material for coverage
              }
            }
          }
        }
      }
      
      // Compute coverage for each constraint using facetVocabulary (industry-agnostic)
      const facetCoverage = new Map<string, number>(); // facetName -> coverage (0.0 to 1.0)
      const facetCoverageLog: Record<string, number> = {};
      
      if (totalCandidates > 0) {
        for (const [facetName, constraintValue] of allConstraints.entries()) {
          // Count candidates that have this facet in structured data (variants/options)
          let candidatesWithFacet = 0;
          
          for (const candidate of allCandidatesEnriched) {
            // Check if candidate has this facet in variants/options
            let hasFacet = false;
            
            // Check variants' selectedOptions
            if (Array.isArray(candidate.variants)) {
              for (const variant of candidate.variants) {
                if (Array.isArray(variant.selectedOptions)) {
                  for (const option of variant.selectedOptions) {
                    const normalizedOptionName = normalizeOptionName(option.name || "");
                    if (normalizedOptionName === facetName) {
                      hasFacet = true;
                      break;
                    }
                  }
                  if (hasFacet) break;
                }
              }
            }
            
            // Also check optionValues (REST API format)
            if (!hasFacet && candidate.optionValues && typeof candidate.optionValues === "object") {
              for (const optName of Object.keys(candidate.optionValues)) {
                const normalizedOptName = normalizeOptionName(optName);
                if (normalizedOptName === facetName) {
                  hasFacet = true;
                  break;
                }
              }
            }
            
            // Legacy support: check c.colors, c.sizes, c.materials for backwards compatibility
            if (!hasFacet) {
              if (facetName === "color" && candidate.colors && candidate.colors.length > 0) hasFacet = true;
              if (facetName === "size" && candidate.sizes && candidate.sizes.length > 0) hasFacet = true;
              if (facetName === "material" && candidate.materials && candidate.materials.length > 0) hasFacet = true;
            }
            
            // Fix: Also check tag-derived facets (cf-color-*, cf-size-*, cf-material-*) for accurate coverage
            if (!hasFacet && Array.isArray(candidate.tags)) {
              const normalizedFacetName = facetName.toLowerCase();
              for (const tag of candidate.tags) {
                if (typeof tag === "string") {
                  const tagLower = tag.toLowerCase();
                  if ((normalizedFacetName === "color" && tagLower.startsWith("cf-color-")) ||
                      (normalizedFacetName === "size" && tagLower.startsWith("cf-size-")) ||
                      (normalizedFacetName === "material" && tagLower.startsWith("cf-material-"))) {
                    hasFacet = true;
                    break;
                  }
                }
              }
            }
            
            if (hasFacet) candidatesWithFacet++;
          }
          
          const coverage = candidatesWithFacet / totalCandidates;
          facetCoverage.set(facetName, coverage);
          facetCoverageLog[facetName] = coverage;
        }
      }
      
      console.log(`[FacetCoverage] ${JSON.stringify(facetCoverageLog)} totals=${totalCandidates}`);
      
      // STEP 2: Confidence rule - if coverage < 0.25, move facet to softTerms instead of enforcing
      // This works for ANY facet type (size, color, material, scent, finish, capacity, etc.)
      const enforcedFacets: { size: string | null; color: string | null; material: string | null } = {
        size: null,
        color: null,
        material: null
      };
      const enforcedConstraints = new Map<string, string>(); // Generic map for any facet type
      // Issue 1 fix: Use outer scope variable for degraded facets (declared earlier)
      degradedFacetsForValidation = []; // Reset for this gating pass
      degradedFacetsMap = new Map(); // Reset map
      
      for (const [facetName, constraintValue] of allConstraints.entries()) {
        const coverage = facetCoverage.get(facetName) || 0;
        
        if (coverage < 0.25) {
          // Low coverage - move to softTerms
          softTerms.push(constraintValue);
          degradedFacetsForValidation.push({ facet: facetName, value: constraintValue, coverage });
          degradedFacetsMap.set(facetName.toLowerCase(), true);
          console.log(`[Degrade] reason=low_facet_coverage facet=${facetName} selected=${constraintValue} coverage=${coverage.toFixed(3)} moved_to_softTerms=true`);
        } else {
          // High enough coverage - enforce as hard constraint
          enforcedConstraints.set(facetName, constraintValue);
          
          // Also set in enforcedFacets for backwards compatibility (size/color/material)
          if (facetName === "size") enforcedFacets.size = constraintValue;
          if (facetName === "color") enforcedFacets.color = constraintValue;
          if (facetName === "material") enforcedFacets.material = constraintValue;
        }
      }
      
      // Log degraded facets map
      if (degradedFacetsMap.size > 0) {
        const degradedList = Array.from(degradedFacetsMap.keys()).join(",");
        console.log(`[Degrade] degradedFacets=${degradedList}`);
      }
      
      // STEP 3: Apply facet gating with fallback matching for missing structured facets
      let gatedCandidates: EnrichedCandidate[] = allCandidatesEnriched.filter(c => {
        // Helper to check if a facet value matches (structured OR indexedText fallback)
        // For color constraints: also check variants - do NOT reject products if any variant matches
        const checkFacetMatch = (facetValue: string | null, structuredValues: string[], indexedText: string, facetName: string, candidate: EnrichedCandidate): boolean => {
          if (!facetValue) return true; // No constraint
          
          // First try structured matching
          if (structuredValues.length > 0) {
            const hasStructuredMatch = structuredValues.some((val: string) => {
              const normalizedVal = normalizeText(val);
              const normalizedFacet = normalizeText(facetValue);
              return normalizedVal === normalizedFacet ||
                     normalizedVal.includes(normalizedFacet) ||
                     normalizedFacet.includes(normalizedVal);
            });
            if (hasStructuredMatch) return true;
          }
          
          // For color constraints: check variants if product-level doesn't match
          // Do NOT reject products at product-level if any variant matches
          if (facetName === "color" && Array.isArray(candidate.variants)) {
            const normalizedFacet = normalizeText(facetValue);
            for (const variant of candidate.variants) {
              if (Array.isArray(variant.selectedOptions)) {
                for (const option of variant.selectedOptions) {
                  const normalizedOptionName = normalizeOptionName(option.name || "");
                  if (normalizedOptionName === "color" && option.value) {
                    const normalizedVal = normalizeText(option.value);
                    if (normalizedVal === normalizedFacet ||
                        normalizedVal.includes(normalizedFacet) ||
                        normalizedFacet.includes(normalizedVal)) {
                      console.log(`[VariantMatch] product=${candidate.handle} variant_color="${option.value}" matches_constraint="${facetValue}"`);
                      return true; // Variant matches - keep product
                    }
                  }
                }
              }
            }
          }
          
          // Fallback: check indexedText if structured facet is missing
          const facetLower = normalizeText(facetValue);
          if (indexedText.includes(facetLower)) {
            return true; // Found in indexedText
          }
          
          return false;
        };
        
        // Helper to extract structured values for a facet from candidate (industry-agnostic)
        const getStructuredValuesForFacet = (candidate: EnrichedCandidate, facetName: string): string[] => {
          const values: string[] = [];
          
          // Check variants' selectedOptions
          if (Array.isArray(candidate.variants)) {
            for (const variant of candidate.variants) {
              if (Array.isArray(variant.selectedOptions)) {
                for (const option of variant.selectedOptions) {
                  const normalizedOptionName = normalizeOptionName(option.name || "");
                  if (normalizedOptionName === facetName && option.value) {
                    values.push(option.value);
                  }
                }
              }
            }
          }
          
          // Also check optionValues (REST API format)
          if (candidate.optionValues && typeof candidate.optionValues === "object") {
            for (const [optName, optValues] of Object.entries(candidate.optionValues)) {
              const normalizedOptName = normalizeOptionName(optName);
              if (normalizedOptName === facetName && Array.isArray(optValues)) {
                values.push(...optValues.filter(v => typeof v === "string"));
              }
            }
          }
          
          // Legacy support: check c.colors, c.sizes, c.materials for backwards compatibility
          if (facetName === "color" && candidate.colors) values.push(...candidate.colors);
          if (facetName === "size" && candidate.sizes) values.push(...candidate.sizes);
          if (facetName === "material" && candidate.materials) values.push(...candidate.materials);
          
          return values;
        };
        
        const indexedText = unifiedNormalize(c.searchText || extractSearchText(c, indexMetafields));
        
        // Check ALL enforced constraints (industry-agnostic: works for any facet type)
        for (const [facetName, constraintValue] of enforcedConstraints.entries()) {
          const structuredValues = getStructuredValuesForFacet(c, facetName);
          if (!checkFacetMatch(constraintValue, structuredValues, indexedText, facetName, c)) {
            return false;
          }
        }
        
        // Legacy: Also check enforcedFacets for backwards compatibility (size/color/material)
        if (enforcedFacets.size) {
          if (!checkFacetMatch(enforcedFacets.size, c.sizes || [], indexedText, "size", c)) {
            return false;
          }
        }
        
        if (enforcedFacets.color) {
          if (!checkFacetMatch(enforcedFacets.color, c.colors || [], indexedText, "color", c)) {
            return false;
          }
        }
        
        if (enforcedFacets.material) {
          if (!checkFacetMatch(enforcedFacets.material, c.materials || [], indexedText, "material", c)) {
            return false;
          }
        }
        
        // Check allowValues (OR logic) with fallback - industry-agnostic: works for any facet type
        // For color constraints: also check variants - do NOT reject products if any variant matches
        const allowValues = variantConstraints2.allowValues;
        
        if (allowValues) {
          for (const [facetName, allowedValues] of Object.entries(allowValues)) {
            if (!Array.isArray(allowedValues) || allowedValues.length === 0) continue;
            
            const normalizedFacetName = normalizeOptionName(facetName);
            
            // Skip if this facet is already enforced (don't double-check)
            if (enforcedConstraints.has(normalizedFacetName)) continue;
            
            // Get structured values for this facet
            const structuredValues = getStructuredValuesForFacet(c, normalizedFacetName);
            
            // Check if any allowed value matches (structured OR indexedText)
            let hasMatch = structuredValues.some((val: string) => 
              allowedValues.some(allowedValue => {
                const normalizedVal = normalizeText(val);
                const normalizedAllowed = normalizeText(allowedValue);
                return normalizedVal === normalizedAllowed ||
                       normalizedVal.includes(normalizedAllowed) ||
                       normalizedAllowed.includes(normalizedVal);
              })
            ) || allowedValues.some(allowedValue => 
              indexedText.includes(normalizeText(allowedValue))
            );
            
            // For color constraints: also check variants if product-level doesn't match
            if (!hasMatch && normalizedFacetName === "color" && Array.isArray(c.variants)) {
              for (const variant of c.variants) {
                if (Array.isArray(variant.selectedOptions)) {
                  for (const option of variant.selectedOptions) {
                    const normalizedOptionName = normalizeOptionName(option.name || "");
                    if (normalizedOptionName === "color" && option.value) {
                      const normalizedVal = normalizeText(option.value);
                      const variantHasMatch = allowedValues.some((allowed: string) => {
                        const normalizedAllowed = normalizeText(allowed);
                        return normalizedVal === normalizedAllowed ||
                               normalizedVal.includes(normalizedAllowed) ||
                               normalizedAllowed.includes(normalizedVal);
                      });
                      if (variantHasMatch) {
                        console.log(`[VariantMatch] product=${c.handle} variant_color="${option.value}" matches_allowValues=[${allowedValues.join(", ")}]`);
                        hasMatch = true;
                        break;
                      }
                    }
                  }
                }
                if (hasMatch) break;
              }
            }
            
            if (!hasMatch) return false;
          }
        }
        
        // Check availability (only if experience.inStockOnly is true)
        // Don't filter by availability here if coverage is high - let it pass through for fallback matching
        if (experience.inStockOnly) {
          const hasAvailableVariant = c.available === true || 
            (c.variants && Array.isArray(c.variants) && c.variants.some((v: any) => 
              v.available === true || v.availableForSale === true
            ));
          if (!hasAvailableVariant) {
            // Log detailed rejection reason for debugging
            const availableStatus = c.available;
            const variantCount = Array.isArray(c.variants) ? c.variants.length : 0;
            const variantAvailableCount = Array.isArray(c.variants) ? 
              c.variants.filter((v: any) => v.available === true || v.availableForSale === true).length : 0;
            console.log(`[Availability] rejected handle=${c.handle} productAvailable=${availableStatus} variantCount=${variantCount} variantAvailableCount=${variantAvailableCount} reason=inStockOnly_required`);
            return false; // Reject due to availability requirement
          }
        }
        
        return true;
      });
      
      const afterFacetGating = gatedCandidates.length;
      const facetGatingReduction = beforeFacetGating - afterFacetGating;
      
      // Log degradation if facets were moved to softTerms
      if (degradedFacetsForValidation.length > 0) {
        for (const degraded of degradedFacetsForValidation) {
          console.log(`[Degrade] reason=low_facet_coverage facet=${degraded.facet} selected=${degraded.value} before=${beforeFacetGating} after=${afterFacetGating}`);
        }
      }
      
      if (enforcedFacets.size || enforcedFacets.color || enforcedFacets.material) {
        console.log(`[App Proxy] [Layer 2] After facet gating: ${afterFacetGating} candidates (reduced by ${facetGatingReduction} from ${beforeFacetGating})`);
      } else {
      console.log("[App Proxy] [Layer 2] After facet gating:", gatedCandidates.length, "candidates");
      }
      
      // Denylist for common false positives (word that contains the term but isn't the term)
      const DENYLIST: Record<string, string[]> = {
        "suit": ["suitcase", "suitable", "suited", "suiting"],
      };
      
      // Helper function for word-boundary matching of hard terms
      // Matches terms with word boundaries to prevent false positives (e.g., "suit" matches " suit " but not "suitable")
      function matchesHardTermWithBoundary(searchText: string, hardTerm: string): boolean {
        // Normalize the search text
        const normalized = normalizeText(searchText);
        const normalizedTerm = normalizeText(hardTerm);
        
        // Escape special regex characters in the term
        const escapedTerm = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        
        // Check if term contains spaces (multi-word phrase)
        if (normalizedTerm.includes(" ")) {
          // Multi-word: require phrase match with word boundaries (normalized whitespace)
          // Replace spaces with \s+ to allow flexible whitespace
          const phrasePattern = escapedTerm.replace(/\s+/g, "\\s+");
          const regex = new RegExp(`\\b${phrasePattern}\\b`, "i");
          return regex.test(normalized);
        } else {
          // Single word: match with word boundaries (e.g., \bsuit\b)
          const regex = new RegExp(`\\b${escapedTerm}\\b`, "i");
          const hasMatch = regex.test(normalized);
          
          if (!hasMatch) {
            return false;
          }
          
          // Check denylist: if term has denylist entries and match is only substring-based, reject
          const denylistTerms = DENYLIST[normalizedTerm];
          if (denylistTerms && denylistTerms.length > 0) {
            // Check if any denylist term appears in the normalized text
            for (const denied of denylistTerms) {
              const deniedRegex = new RegExp(`\\b${denied.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
              if (deniedRegex.test(normalized)) {
                // Denylist term found - this is a false positive, reject the match
                return false;
              }
            }
          }
          
          return true;
        }
      }
      
      // Industry-agnostic boost terms (detected from user intent)
      // These provide additional matching signals when present in user queries
      // Works for any industry: "3 piece", "set", "kit", "bundle", etc.
      const boostTerms = new Set<string>();
      const lowerIntent = userIntent.toLowerCase();
      
      // Generic multi-piece/set patterns (industry-agnostic)
      if (/\b(3\s*piece|three\s*piece|4\s*piece|four\s*piece|5\s*piece|five\s*piece)\b/i.test(lowerIntent)) {
        const match = lowerIntent.match(/\b(\d+\s*piece|three\s*piece|four\s*piece|five\s*piece)\b/i);
        if (match) {
          boostTerms.add(match[1].toLowerCase());
        }
      }
      
      // Generic collection terms (industry-agnostic)
      if (/\b(set|kit|bundle|collection|suite|system)\b/i.test(lowerIntent)) {
        const match = lowerIntent.match(/\b(set|kit|bundle|collection|suite|system)\b/i);
        if (match) {
          boostTerms.add(match[1].toLowerCase());
        }
      }
      
      // Budget filter helper: applies priceMin/priceMax constraints to candidates using range overlap
      // CRITICAL: priceMin/priceMax from answers is the SINGLE source of truth
      // Do NOT use LLM totalBudget or priceCeiling for filtering
      function applyBudgetFilterCandidates<T extends { priceAmount?: any; price?: any; priceMinAmount?: number | null; priceMaxAmount?: number | null }>(
        candidates: T[],
        priceMin: number | null,
        priceMax: number | null
      ): T[] {
        const hadBudget = typeof priceMin === "number" || typeof priceMax === "number";
        if (!hadBudget) return candidates;

        const before = candidates.length;
        let removedBelow = 0;
        let removedAbove = 0;
        
        const out = candidates.filter(c => {
          // Get price range from candidate (prefer explicit min/max, fallback to single price)
          const candidateMin = (c as any).priceMinAmount ?? null;
          const candidateMax = (c as any).priceMaxAmount ?? null;
          const singlePrice = c.priceAmount != null ? parseFloat(String(c.priceAmount)) : (c.price != null ? parseFloat(String(c.price)) : NaN);
          
          // If we have explicit min/max, use range overlap logic
          if (candidateMin !== null || candidateMax !== null) {
            const candMin = candidateMin ?? candidateMax ?? (Number.isFinite(singlePrice) ? singlePrice : null);
            const candMax = candidateMax ?? candidateMin ?? (Number.isFinite(singlePrice) ? singlePrice : null);
            
            if (candMin === null || candMax === null) {
              // Missing price data - keep it (don't drop unknown)
              return true;
            }
            
            // Range overlap: candidateMax >= budgetMin AND candidateMin <= budgetMax
            // Only apply floor filter when priceMin is present
            if (typeof priceMin === "number" && candMax < priceMin) {
              removedBelow++;
              return false;
            }
            // Only apply ceiling filter when priceMax is present
            if (typeof priceMax === "number" && candMin > priceMax) {
              removedAbove++;
              return false;
            }
            return true;
          }
          
          // Fallback to single price logic for backwards compatibility
          if (!Number.isFinite(singlePrice)) return true; // keep unknown prices
          // Only apply floor filter when priceMin is present
          if (typeof priceMin === "number" && singlePrice < priceMin) {
            removedBelow++;
            return false;
          }
          // Only apply ceiling filter when priceMax is present
          if (typeof priceMax === "number" && singlePrice > priceMax) {
            removedAbove++;
            return false;
          }
          return true;
        });
        
        const after = out.length;
        if (before !== after) {
          console.log(`[BudgetFilter] applied=true before=${before} after=${after} min=${priceMin ?? "null"} max=${priceMax ?? "null"}`);
          console.log(`[BudgetConstraint] applied=true floor=${priceMin ?? "null"} ceiling=${priceMax ?? "null"} removedBelow=${removedBelow} removedAbove=${removedAbove}`);
        } else {
          console.log(`[BudgetFilter] applied=true no_change count=${before} min=${priceMin ?? "null"} max=${priceMax ?? "null"}`);
        }
        return out;
      }
      
      // Gate 2: Hard terms (STRICT: must match ALL hard terms when count >= 2, OR at least one when count == 1)
      // Use word-boundary matching on normalized text (title/productType/tags/descPlain), not substring
      let trustFallback = false;
      let noMatchDetected = false; // BUG FIX #2: Track no_match flag to short-circuit pipeline
      const strictGate: EnrichedCandidate[] = [];
      let strictGateCount = 0; // Declare outside if block for use in type anchor gating
      
      // Keep baseCandidates separate from gatedCandidates (candidates after facet gating)
      const baseCandidates = [...gatedCandidates];
      
      if (hardTerms.length > 0) {
        // Build normalized haystack using extractSearchText (includes ALL fields: title, handle, productType, tags, vendor, options, description)
        // Use unifiedNormalize for consistency
        const requireAllHardTerms = hardTerms.length >= 2; // AND logic when 2+ terms
        
        // Build hardTermTokens with morphology variants
        const hardTermTokens = new Set<string>();
        for (const term of hardTerms) {
          const normalized = unifiedNormalize(term);
          const tokens = tokenize(normalized);
          // Add morphology variants for each token
          for (const token of tokens) {
            const morphVariants = expandTokenMorphology(token);
            for (const variant of morphVariants) {
              hardTermTokens.add(variant);
            }
          }
        }
        
        // For single-term queries, allow any morphology variant match
        // For multi-term queries, still require all original terms (morphology helps with individual term matching)
        for (const candidate of gatedCandidates) {
          // Use extractSearchText which includes all relevant fields, then normalize
          const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
          const candidateTokens = new Set(tokenize(haystack));
          
          // STRICT GATING: Require ALL hard terms when count >= 2 (AND logic)
          let matchesHardTerms: boolean;
          if (requireAllHardTerms) {
            // AND logic: ALL hard terms must match (check original phrases OR token variants for single terms)
            matchesHardTerms = hardTerms.every(phrase => {
              const normalizedPhrase = unifiedNormalize(phrase);
              // First try phrase match
              if (matchesHardTermWithBoundary(haystack, normalizedPhrase)) {
                return true;
              }
              // For single-word terms, also check morphology variants
              const phraseTokens = tokenize(normalizedPhrase);
              if (phraseTokens.length === 1) {
                const morphVariants = expandTokenMorphology(phraseTokens[0]);
                return Array.from(morphVariants).some(variant => candidateTokens.has(variant));
              }
              return false;
            });
          } else {
            // OR logic: at least one hard term must match (when only 1 term)
            // For single term, check phrase OR any morphology variant
            const normalizedPhrase = unifiedNormalize(hardTerms[0]);
            matchesHardTerms = matchesHardTermWithBoundary(haystack, normalizedPhrase);
            if (!matchesHardTerms) {
              // Try morphology variants
              const phraseTokens = tokenize(normalizedPhrase);
              if (phraseTokens.length === 1) {
                const morphVariants = expandTokenMorphology(phraseTokens[0]);
                matchesHardTerms = Array.from(morphVariants).some(variant => candidateTokens.has(variant));
              }
            }
          }
          
          // Also check boost terms (if user intent suggests them) - boost terms are optional, not required
          const hasBoostTerm = Array.from(boostTerms).some(term => {
            const normalizedTerm = unifiedNormalize(term);
            return matchesHardTermWithBoundary(haystack, normalizedTerm);
          });
          
          // Include candidate if it matches hard terms (AND/OR based on count) OR has boost term
          if (matchesHardTerms || hasBoostTerm) {
            strictGate.push(candidate);
          }
        }
        
        console.log("[App Proxy] [Layer 2] Strict gate (hard terms + facets):", strictGate.length, "candidates");
        
        // Budget diagnostic: Log strictGate items before budget filter (when budget is active)
        if (hadBudget && (priceMin !== null || priceMax !== null) && strictGate.length > 0) {
          const strictGateSample = strictGate
            .slice(0, 15)
            .map(c => ({
              handle: c.handle,
              title: c.title,
              available: c.available,
              priceMinAmount: (c as any).priceMinAmount ?? null,
              priceMaxAmount: (c as any).priceMaxAmount ?? null,
              priceAmount: (c as any).priceAmount || (c as any).price || null,
            }));
          console.log(`[BudgetDebug] strictGate_before_budget count=${strictGate.length} min=${priceMin ?? "null"} sample=${JSON.stringify(strictGateSample)}`);
        }
        
        // STAGED FALLBACK LOGIC
        // Stage A: strict (hard terms + facets) - only broaden if not enough for requestedCount
        const buffer = 6; // Small buffer to ensure we have enough for AI ranking
        strictGateCount = strictGate.length; // Update value declared above
        const minNeededForRequested = finalResultCount + buffer;
        
        console.log(`[Gating] strictGateCount=${strictGateCount} requestedCount=${finalResultCount} buffer=${buffer} minNeeded=${minNeededForRequested}`);
        
        // Store original hardTerms before any expansion for NO_MATCH fallback
        const originalHardTermsForNoMatch = hardTerms.filter(t => {
          // Filter to only original terms (not synonyms) by checking if term was in original intent
          // This is approximate - in practice, we'll use the expanded terms for retry
          return true; // Keep all for now, will refine if needed
        });
        
        if (strictGateCount >= minNeededForRequested) {
          // Stage A: Strict gate is sufficient - keep it
          const beforeBudget = strictGate.length;
          gatedCandidates = applyBudgetFilterCandidates(strictGate, priceMin, priceMax);
          const afterBudget = gatedCandidates.length;
          
          // Budget diagnostic: Log strictGate after budget filter
          if (hadBudget && (priceMin !== null || priceMax !== null) && afterBudget > 0) {
            const afterBudgetSample = gatedCandidates
              .slice(0, 15)
              .map(c => ({
                handle: c.handle,
                title: c.title,
                available: c.available,
                priceMinAmount: (c as any).priceMinAmount ?? null,
                priceMaxAmount: (c as any).priceMaxAmount ?? null,
                priceAmount: (c as any).priceAmount || (c as any).price || null,
              }));
            console.log(`[BudgetDebug] strictGate_after_budget before=${beforeBudget} after=${afterBudget} min=${priceMin ?? "null"} sample=${JSON.stringify(afterBudgetSample)}`);
          }
          
          trustFallback = false;
          console.log(`[Gating] Stage A: strict (hard terms + facets) - strictGateCount=${strictGateCount} >= minNeeded=${minNeededForRequested} trustFallback=false`);
        } else if (strictGateCount === 0) {
          // CRITICAL: strictGateCount==0 - retry with morphology + decompounding expansion
          console.log(`[Gating] strictGateCount=0 - retrying with morphology and decompounding expansion`);
          
          // Build vocabulary from baseCandidates (candidates after facet gating)
          const vocab = new Set<string>();
          for (const candidate of baseCandidates) {
            const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
            const tokens = tokenize(haystack);
            for (const token of tokens) {
              if (token.length >= 4) { // Only consider tokens length >= 4 for vocab
                vocab.add(token);
              }
            }
          }
          
          // Build original query tokens
          const originalQueryTokens: string[] = [];
          for (const term of hardTerms) {
            const normalized = unifiedNormalize(term);
            const tokens = tokenize(normalized);
            originalQueryTokens.push(...tokens);
          }
          
          // Expand query tokens with morphology + decompounding
          const expandedTokens = expandQueryTokens(originalQueryTokens, vocab);
          const originalTokensArray = Array.from(new Set(originalQueryTokens));
          const expandedTokensArray = Array.from(expandedTokens);
          const addedTokens = expandedTokensArray.filter(t => !originalTokensArray.includes(t));
          
          if (addedTokens.length > 0) {
            console.log(`[Morphology] originalTokens=[${originalTokensArray.join(",")}] expandedTokens=[${expandedTokensArray.join(",")}] applied=true`);
            if (addedTokens.some(t => vocab.has(t))) {
              console.log(`[Decompound] applied=true addedTokens=[${addedTokens.filter(t => vocab.has(t)).join(",")}]`);
            }
          }
          
          // Retry strict gate using expanded tokens (OR logic - match any expanded token)
          const retryStrictGate: EnrichedCandidate[] = [];
          for (const candidate of baseCandidates) {
            const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
            const candidateTokens = new Set(tokenize(haystack));
            
            // Check if any expanded token matches
            const hasMatch = Array.from(expandedTokens).some(token => candidateTokens.has(token));
            if (hasMatch) {
              retryStrictGate.push(candidate);
            }
          }
          
          if (retryStrictGate.length > 0) {
            strictGateCount = retryStrictGate.length;
            gatedCandidates = applyBudgetFilterCandidates(retryStrictGate, priceMin, priceMax);
            strictGateCount = gatedCandidates.length;
            trustFallback = false;
            console.log(`[Gating] Retry with morphology/decompound succeeded: strictGateCount=${strictGateCount} trustFallback=false`);
          } else {
            // Still 0 - try BM25 with expanded token filter
            console.log(`[Gating] strictGateCount still 0 after morphology retry - trying BM25 with expanded token filter`);
            
            // Filter candidates to require at least one expanded token match
            const bm25Filtered = baseCandidates.filter(candidate => {
              const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
              const candidateTokens = new Set(tokenize(haystack));
              return Array.from(expandedTokens).some(token => candidateTokens.has(token));
            });
            
            if (bm25Filtered.length > 0) {
              // Use BM25 ranking on filtered candidates
              const candidateDocs = bm25Filtered.map(c => ({
                candidate: c,
                tokens: tokenize(c.searchText || extractSearchText(c, indexMetafields)),
              }));
              
              const idf = calculateIDF(candidateDocs.map(d => ({ tokens: d.tokens })));
              const avgDocLen = candidateDocs.reduce((sum, d) => sum + d.tokens.length, 0) / candidateDocs.length || 1;
              
              const queryTokensArray = Array.from(expandedTokens);
              const scoredCandidates = candidateDocs.map(d => {
                const docTokenFreq = new Map<string, number>();
                for (const token of d.tokens) {
                  docTokenFreq.set(token, (docTokenFreq.get(token) || 0) + 1);
                }
                const score = bm25Score(queryTokensArray, d.tokens, docTokenFreq, d.tokens.length, avgDocLen, idf);
                return { candidate: d.candidate, score };
              });
              
              scoredCandidates.sort((a, b) => {
                if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score;
                if (a.candidate.available !== b.candidate.available) return a.candidate.available ? -1 : 1;
                return a.candidate.handle.localeCompare(b.candidate.handle);
              });
              
              gatedCandidates = applyBudgetFilterCandidates(scoredCandidates.map(s => s.candidate), priceMin, priceMax);
              strictGateCount = gatedCandidates.length;
              trustFallback = false;
              console.log(`[Gating] BM25 with expanded token filter succeeded: strictGateCount=${strictGateCount} trustFallback=false`);
            } else {
              // All stages failed - try targeted Shopify search fallback if conditions are met
              if (hardTerms.length > 0 && mightHaveMorePages && accessToken && shopDomain) {
                console.log(`[Gating] strictGateCount=0 - attempting targeted Shopify search fallback`);
                
                try {
                  // Build search queries with built-in synonym expansion if experience.searchSynonymsJson is empty
                  const searchQueries: string[] = [];
                  const hasSearchSynonyms = experience.searchSynonymsJson !== null && experience.searchSynonymsJson !== undefined && experience.searchSynonymsJson !== "";
                  
                  for (const hardTerm of hardTerms) {
                    // Use the hard term as-is for search query
                    // If synonyms are configured in experience.searchSynonymsJson, they should already be in hardTerms
                    // Otherwise, Shopify's search will handle partial matches and relevance
                    searchQueries.push(hardTerm);
                  }
                  
                  // Fetch products for each search query (cap at 250-300 per query, total cap to avoid huge payloads)
                  const MAX_SEARCH_RESULTS_PER_QUERY = 250;
                  const MAX_TOTAL_SEARCH_RESULTS = 500;
                  const fallbackProducts: any[] = [];
                  // Track handles from all existing candidates to avoid duplicates
                  const seenHandles = new Set<string>(allCandidatesEnriched.map(c => c.handle));
                  
                  for (const searchQuery of searchQueries) {
                    if (fallbackProducts.length >= MAX_TOTAL_SEARCH_RESULTS) break;
                    
                    const remaining = MAX_TOTAL_SEARCH_RESULTS - fallbackProducts.length;
                    const queryLimit = Math.min(MAX_SEARCH_RESULTS_PER_QUERY, remaining);
                    
                    try {
                      const searchResults = await fetchShopifyProductsBySearchQuery({
                        shopDomain,
                        accessToken,
                        query: searchQuery,
                        targetCount: queryLimit,
                      });
                      
                      // Filter and dedupe
                      for (const product of searchResults) {
                        if (seenHandles.has(product.handle)) continue;
                        if ((product as any).status === "ARCHIVED" || (product as any).status === "DRAFT") continue;
                        if (excludedTags.length > 0) {
                          const productTags = product.tags || [];
                          if (excludedTags.some(excludedTag => 
                            productTags.some((tag: string) => tag.toLowerCase() === excludedTag.toLowerCase())
                          )) continue;
                        }
                        if (experience.inStockOnly && !product.available) continue;
                        
                        seenHandles.add(product.handle);
                        fallbackProducts.push(product);
                      }
                      
                      console.log(`[Shopify Search Fallback] enabled=true term="${searchQuery}" fetched=${searchResults.length} merged_total=${fallbackProducts.length}`);
                    } catch (error) {
                      console.error(`[Shopify Search Fallback] Error fetching for term "${searchQuery}":`, error);
                    }
                  }
                  
                  if (fallbackProducts.length > 0) {
                    // Merge into product pool and rerun indexing/gating
                    const mergedProducts = [...baseProducts, ...fallbackProducts];
                    const mergedTotal = mergedProducts.length;
                    
                    console.log(`[Shopify Search Fallback] merged_total=${mergedTotal} (added ${fallbackProducts.length} from search)`);
                    
                    // Re-enrich candidates with merged products
                    // Note: We need to rebuild allCandidatesEnriched with the merged products
                    // This is a simplified approach - in practice, you'd want to properly re-index
                    const mergedEnriched: EnrichedCandidate[] = mergedProducts.map((p: any) => {
                      const descPlain = cleanDescription(p.description || null);
                      const desc1000 = descPlain.substring(0, 1000);
                      return {
                        handle: p.handle,
                        title: p.title,
                        tags: p.tags || [],
                        productType: p.productType || null,
                        vendor: p.vendor || null,
                        price: p.priceAmount || p.price || null,
                        description: p.description || null,
                        descPlain,
                        desc1000,
                        searchText: buildSearchText({
                          title: p.title,
                          productType: p.productType || null,
                          vendor: p.vendor || null,
                          tags: p.tags || [],
                          optionValues: (p as any).optionValues ?? {},
                          sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
                          colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
                          materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
                          desc1000,
                        }),
                        available: p.available,
                        sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
                        colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
                        materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
                        optionValues: (p as any).optionValues ?? {},
                      } as EnrichedCandidate;
                    });
                    
                    // Update allCandidatesEnriched and rerun strict gate
                    allCandidatesEnriched = mergedEnriched;
                    gatedCandidates = applyBudgetFilterCandidates(allCandidatesEnriched, priceMin, priceMax);
                    console.log(`[Gating] reset_to_all_candidates budget_enforced=true count=${gatedCandidates.length}`);
                    
                    // Rerun strict gate
                    const retryStrictGate: EnrichedCandidate[] = [];
                    for (const candidate of allCandidatesEnriched) {
                      const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
                      const hasHardTermMatch = hardTerms.some(phrase => {
                        const normalizedPhrase = unifiedNormalize(phrase);
                        return matchesHardTermWithBoundary(haystack, normalizedPhrase);
                      });
                      if (hasHardTermMatch) {
                        retryStrictGate.push(candidate);
                      }
                    }
                    
                    if (retryStrictGate.length > 0) {
                      strictGateCount = retryStrictGate.length;
                      gatedCandidates = applyBudgetFilterCandidates(retryStrictGate, priceMin, priceMax);
                      strictGateCount = gatedCandidates.length;
                      trustFallback = false;
                      console.log(`[Gating] fallback_search_used=true strictGateCount_before=0 strictGateCount_after=${strictGateCount}`);
                    } else {
                      // Still 0 after search fallback - return NO_MATCH
                      console.log(`[Gating] no_match=true reason=all_gating_stages_failed_including_search_fallback`);
                      noMatchDetected = true;
                      gatedCandidates = [];
                    }
                  } else {
                    // No search results - return NO_MATCH
                    console.log(`[Gating] no_match=true reason=all_gating_stages_failed_search_fallback_returned_0`);
                    noMatchDetected = true;
                    gatedCandidates = [];
                  }
                } catch (error) {
                  console.error(`[Gating] Error in targeted search fallback:`, error);
                  // Fall through to NO_MATCH
                  console.log(`[Gating] no_match=true reason=all_gating_stages_failed_search_fallback_error`);
                  noMatchDetected = true;
                  gatedCandidates = [];
                }
            } else {
              // All stages failed - return NO_MATCH
              console.log(`[Gating] no_match=true reason=all_gating_stages_failed (strictGateCount=0, synonym_retry=0, bm25_filter=0)`);
              noMatchDetected = true; // Set flag to short-circuit pipeline
              gatedCandidates = []; // Ensure gatedCandidates is empty
              // Will be handled below to return NO_MATCH result
              }
            }
          }
        } else {
          // Need to broaden - implement staged fallback
          console.log(`[Gating] strictGateCount=${strictGateCount} < minNeeded=${minNeededForRequested} - starting staged fallback`);
          
          // Stage B: Relax facets only (keep ALL hard terms)
          // Build candidates that match ALL hardTerms but relax facet constraints
          const stageB = gatedCandidates.filter(candidate => {
            const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
            
            // Must match ALL hard terms (keep all hardTerms, don't drop any)
            const matchesAllHardTerms = hardTerms.every(phrase => {
              const normalizedPhrase = unifiedNormalize(phrase);
              return matchesHardTermWithBoundary(haystack, normalizedPhrase);
            });
            return matchesAllHardTerms;
          });
          
          console.log(`[Gating] Stage B: relax facets only - count=${stageB.length} (strictGateCount=${strictGateCount})`);
          
          if (stageB.length >= minNeededForRequested) {
            gatedCandidates = applyBudgetFilterCandidates(stageB, priceMin, priceMax);
            trustFallback = false;
            console.log(`[Gating] Stage B: relax facets only (keep all hardTerms) - count=${gatedCandidates.length} anchor_terms=[${hardTerms.join(", ")}] trustFallback=false`);
              } else {
            // Stage C: Relax hard terms (allow token containment matching)
            // Use token-based matching: check if any normalized hard term token appears in indexed text
            const hardTermTokens = new Set<string>();
            hardTerms.forEach(phrase => {
              const normalized = unifiedNormalize(phrase);
              const tokens = tokenize(normalized);
              tokens.forEach(t => hardTermTokens.add(t));
            });
            
            const stageC = gatedCandidates.filter(candidate => {
              const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
              const candidateTokens = new Set(tokenize(haystack));
              
              // Check if at least one hard term token appears in candidate
              return Array.from(hardTermTokens).some(token => candidateTokens.has(token));
            });
            
            console.log(`[Gating] Stage C: token containment - count=${stageC.length} hardTermTokens=[${Array.from(hardTermTokens).join(", ")}]`);
            
            if (stageC.length >= MIN_CANDIDATES_FOR_AI) {
              gatedCandidates = applyBudgetFilterCandidates(stageC, priceMin, priceMax);
              trustFallback = false;
              console.log(`[Gating] Stage C: relax hard terms (token containment, keep all terms) - count=${gatedCandidates.length} anchor_terms=[${hardTerms.join(", ")}] trustFallback=false`);
          } else {
              // Stage D: BM25 over full pool but filtered to items that match at least 1 normalized hard token
              // Use BM25 ranking but only include candidates with at least one token match
              const stageD = gatedCandidates.filter(candidate => {
                const haystack = unifiedNormalize(candidate.searchText || extractSearchText(candidate, indexMetafields));
                const candidateTokens = new Set(tokenize(haystack));
                
                // Must match at least one hard term token
                return Array.from(hardTermTokens).some(token => candidateTokens.has(token));
              });
              
              console.log(`[Gating] Stage D: BM25 with token filter - count=${stageD.length}`);
              
              if (stageD.length > 0) {
                gatedCandidates = applyBudgetFilterCandidates(stageD, priceMin, priceMax);
                trustFallback = false;
                console.log(`[Gating] Stage D: BM25 with token filter - count=${gatedCandidates.length} anchor_terms=[${hardTerms.join(", ")}] trustFallback=false`);
              } else {
                // All stages failed - mark for emergency fallback (no billing)
            trustFallback = true;
                relaxNotes.push(`No matches found for "${hardTerms.join(", ")}" after staged fallback.`);
                console.log(`[Gating] All stages failed - emergency fallback required - count=${gatedCandidates.length} anchor_terms=[${hardTerms.join(", ")}] trustFallback=true`);
              }
            }
          }
        }
      } else {
        // No hard terms, use facet-gated candidates
        console.log("[App Proxy] [Layer 2] No hard terms, using facet-gated candidates");
      }
      
      // Type anchor gating: filter by non-facet hard terms to prevent facet-only matches
      // This ensures products must contain at least one non-facet term (e.g., "shirt" not just "blue")
      // Only apply to single-item flow (bundle items are handled separately)
      // SKIP if we're already in Stage B/C/D (already applied hard term filtering in staged fallback)
      const isBundleFlow = bundleIntent.isBundle && Array.isArray(bundleIntent.items) && bundleIntent.items.length >= 2;
      const nonFacetTerms = getNonFacetHardTerms(hardTerms, hardFacets);
      
      // Only apply anchor gating if we're still in Stage A (strict gate)
      // In Stage B/C/D, we've already applied hard term filtering, so skip to avoid double-filtering
      const isStageA = hardTerms.length > 0 && strictGateCount >= (finalResultCount + 6);
      
      if (nonFacetTerms.length > 0 && !isBundleFlow && isStageA) {
        const beforeAnchor = gatedCandidates.length;
        gatedCandidates = gatedCandidates.filter(c => {
          const searchText = extractSearchText(c, indexMetafields);
          return nonFacetTerms.some(term => {
            const termLower = term.toLowerCase().trim();
            return searchText.includes(termLower);
          });
        });
        // Re-apply budget filter after anchor gating
        gatedCandidates = applyBudgetFilterCandidates(gatedCandidates, priceMin, priceMax);
        const afterAnchor = gatedCandidates.length;
        console.log(`[Gating] mode=${modeUsed} flow=single anchor_terms=[${nonFacetTerms.join(", ")}] before=${beforeAnchor} after=${afterAnchor} stage=A`);
      } else if (nonFacetTerms.length === 0 && !isBundleFlow) {
        console.log(`[Gating] mode=${modeUsed} flow=single anchor_terms_empty=true (skipping anchor filter)`);
      } else if (!isStageA && !isBundleFlow && hardTerms.length > 0) {
        console.log(`[Gating] mode=${modeUsed} flow=single anchor_terms=[${hardTerms.join(", ")}] (already applied in staged fallback, skipping anchor filter)`);
      }
      
      // PRIMARY TYPE ANCHOR GATING: Hard filter by primaryTypeAnchor BEFORE ranking
      // Only for single-item queries (not bundles) and when primaryTypeAnchor is selected
      if (primaryTypeAnchor && !bundleIntent.isBundle && gatedCandidates.length > 0) {
        const beforeTypeAnchor = gatedCandidates.length;
        
        // First try exact match with primaryTypeAnchor
        let typeAnchoredCandidates = gatedCandidates.filter(c => 
          productMatchesTypeAnchor(c, primaryTypeAnchor)
        );
        
        // If insufficient results, widen within anchor family (morphology/synonyms)
        // Never drop the type anchor - only widen within the anchor family
        if (typeAnchoredCandidates.length < Math.max(MIN_CANDIDATES_FOR_AI, finalResultCount * 2) && typeAnchorVariants.length > 1) {
          console.log(`[TypeAnchor] insufficient_results=${typeAnchoredCandidates.length} widening_within_family variants=[${typeAnchorVariants.join(", ")}]`);
          
          // Include products matching any variant in the anchor family
          typeAnchoredCandidates = gatedCandidates.filter(c => 
            typeAnchorVariants.some(variant => productMatchesTypeAnchor(c, variant))
          );
        }
        
        gatedCandidates = typeAnchoredCandidates;
        const afterTypeAnchor = gatedCandidates.length;
        console.log(`[TypeAnchor] applied=true anchor="${primaryTypeAnchor}" before=${beforeTypeAnchor} after=${afterTypeAnchor} variants_used=${typeAnchorVariants.length > 1 ? "true" : "false"}`);
      } else if (primaryTypeAnchor && bundleIntent.isBundle) {
        console.log(`[TypeAnchor] skipped=true reason=bundle_mode anchor="${primaryTypeAnchor}"`);
      } else if (!primaryTypeAnchor) {
        console.log(`[TypeAnchor] skipped=true reason=no_anchor_selected`);
      }
      
      // Filter avoid terms (penalty/filter) - use extractSearchText for consistency
      if (avoidTerms.length > 0 && !trustFallback) {
        const beforeAvoid = gatedCandidates.length;
        gatedCandidates = gatedCandidates.filter(c => {
          const searchText = extractSearchText(c, indexMetafields);
          return !avoidTerms.some(avoid => searchText.includes(avoid.toLowerCase()));
        });
        // Re-apply budget filter after avoid terms filtering
        gatedCandidates = applyBudgetFilterCandidates(gatedCandidates, priceMin, priceMax);
        if (gatedCandidates.length < beforeAvoid) {
          console.log("[App Proxy] [Layer 2] Avoid terms filtered:", gatedCandidates.length, "candidates (from", beforeAvoid, ")");
        }
      }
      
      // strictGateCount already declared and set above (inside if block or 0 if no hardTerms)
      // Store strict gate candidates for fallback ranking (if strictGateCount > 0, fallback must use strict gate only)
      const strictGateCandidates = strictGate.length > 0 ? [...strictGate] : undefined;
      console.log("[App Proxy] [Layer 2] Final gated pool:", gatedCandidates.length, "candidates");
      
      // Budget sanity check before AI window selection
      console.log(`[BudgetSanity] gated_before_ai=${gatedCandidates.length} min=${priceMin ?? "null"} max=${priceMax ?? "null"}`);
      
      // BUG FIX #2: NO_MATCH CHECK - If all gating stages failed and we have no candidates, return NO_MATCH result
      // This must short-circuit BEFORE BM25 ranking and AI ranking
      // CRITICAL: Only return NO_MATCH if there were zero candidates BEFORE facet gating OR after all fallbacks
      // If candidates existed but were removed due to low-confidence facets, continue with partial results
      const shouldReturnNoMatch = (gatedCandidates.length === 0 && hardTerms.length > 0 && beforeFacetGating === 0) || 
                                   (noMatchDetected && beforeFacetGating === 0);
      
      if (shouldReturnNoMatch) {
        console.log(`[Gating] no_match=true - returning NO_MATCH result (zero candidates before facet gating) - SHORT-CIRCUITING pipeline`);
        
        // Generate suggested synonyms from searchSynonymsJson
        let suggestedSynonyms: string[] = [];
        try {
          let searchSynonyms: Record<string, string[]> = {};
          if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "string") {
            searchSynonyms = JSON.parse(experience.searchSynonymsJson);
          } else if (experience.searchSynonymsJson && typeof experience.searchSynonymsJson === "object") {
            searchSynonyms = experience.searchSynonymsJson;
          }
          
          // Find synonyms for the original hardTerms (before expansion)
          const originalTerms = hardTerms; // These are already expanded, but we can suggest alternatives
          for (const term of originalTerms) {
            const normalizedTerm = term.toLowerCase();
            const synonyms = searchSynonyms[normalizedTerm] || searchSynonyms[term] || [];
            suggestedSynonyms.push(...synonyms.slice(0, 3)); // Limit to 3 per term
          }
          suggestedSynonyms = Array.from(new Set(suggestedSynonyms)); // Deduplicate
        } catch (e) {
          // Ignore errors in synonym lookup
        }
        
        // Save NO_MATCH result
        const noMatchReasoning = suggestedSynonyms.length > 0
          ? `No strong matches found for "${hardTerms.join(", ")}". Try searching for: ${suggestedSynonyms.slice(0, 5).join(", ")}`
          : `No strong matches found for "${hardTerms.join(", ")}". Please try adjusting your search terms.`;
        
        await saveConciergeResult({
          sessionToken,
          productHandles: [],
          productIds: null,
          reasoning: noMatchReasoning,
        });
        
        // Mark session as COMPLETE (not FAILED - this is a valid "no results" outcome)
        await prisma.conciergeSession.update({
          where: { publicToken: sessionToken },
          data: { status: ConciergeSessionStatus.COMPLETE },
        });
        
        console.log("[App Proxy] NO_MATCH result saved - session marked COMPLETE with 0 products (SKIPPED: BM25 ranking, AI ranking, billing)");
        return; // Exit early - DO NOT continue to BM25 ranking, DO NOT call AI ranking, DO NOT bill
      } else if (gatedCandidates.length === 0 && beforeFacetGating > 0) {
        // Candidates existed before facet gating but were removed - this is due to low coverage facets
        // Continue with partial results (will use fallback logic later)
        console.log(`[Gating] candidates_removed_by_facets before=${beforeFacetGating} after=${gatedCandidates.length} - continuing with fallback logic`);
      }
      
      // BUNDLE/HARD-TERM PATH: Continue processing (only if we have candidates)
      // Reduce AI window when no hardTerms (max 30 candidates for speed)
      if (hardTerms.length === 0 && aiWindow > noHardTermsWindow) {
        aiWindow = noHardTermsWindow;
        console.log("[App Proxy] AI window reduced to", noHardTermsWindow, "(no hardTerms)");
      }
      
      // Pre-rank gated candidates with BM25 + boosts
      const bm25StartSingle = performance.now();
      console.log("[App Proxy] [Layer 2] Pre-ranking candidates with BM25");
      const rankedCandidates = gatedCandidates.map(c => {
        const docTokens = tokenize(c.searchText);
        const docTokenFreq = new Map<string, number>();
        for (const token of docTokens) {
          docTokenFreq.set(token, (docTokenFreq.get(token) || 0) + 1);
        }
        
        // BM25 score
        let score = bm25Score(allQueryTokens, docTokens, docTokenFreq, docTokens.length, avgDocLen, idf);
        
        // Boost for exact phrase match using normalized haystack: title + productType + tags.join(" ") + vendor + searchText
        const haystack = [
          c.title || "",
          c.productType || "",
          (c.tags || []).join(" "),
          c.vendor || "",
          c.searchText || "",
        ].join(" ");
        
        for (const hardTerm of hardTerms) {
          if (matchesHardTermWithBoundary(haystack, hardTerm)) {
            score += 2.0; // Boost for exact phrase match with word boundaries
          }
        }
        
        // Boost for generic collection/multi-piece terms (industry-agnostic)
        for (const boostTerm of boostTerms) {
          if (matchesHardTermWithBoundary(haystack, boostTerm)) {
            score += 1.5; // Boost for collection/multi-piece terms
          }
        }
        
        // Boost for facet matches
        if (hardFacets.size && c.sizes.some((s: string) => normalizeText(s) === normalizeText(hardFacets.size))) {
          score += 1.5;
        }
        if (hardFacets.color && c.colors.some((col: string) => normalizeText(col) === normalizeText(hardFacets.color))) {
          score += 1.5;
        }
        if (hardFacets.material && c.materials.some((m: string) => normalizeText(m) === normalizeText(hardFacets.material))) {
          score += 1.5;
        }
        
        // Penalty for avoid terms (use extractSearchText for consistency)
        if (avoidTerms.length > 0) {
          const searchText = extractSearchText(c);
          const avoidMatches = avoidTerms.filter(avoid => searchText.includes(avoid.toLowerCase())).length;
          score -= avoidMatches * 1.0;
        }
        
        return { candidate: c, score };
      });
      
      // Sort by score descending
      rankedCandidates.sort((a, b) => b.score - a.score);
      
      // ============================================
      // GROUP-BALANCED WINDOW SELECTION (for collection intent)
      // ============================================
      let topCandidates: EnrichedCandidate[];
      
      if (collectionIntent && !bundleIntent.isBundle) {
        // ============================================
        // FAMILY-BASED GROUPING (coarse, industry-agnostic)
        // ============================================
        // Derive family keys for all ranked candidates
        const candidatesWithFamilies = rankedCandidates.map(r => {
          const familyInfo = deriveFamilyKey(r.candidate);
          const rawKey = familyInfo.key;
          const canonicalKey = canonicalizeGroupKey(rawKey);
          return {
            ...r,
            familyKey: canonicalKey, // Use canonical key for grouping
            rawFamilyKey: rawKey, // Keep raw key for reference
            familySource: familyInfo.source
          };
        });
        
        // Log familyKey source for a few items (sample)
        const sampleFamilySources: Record<string, number> = {};
        candidatesWithFamilies.slice(0, 10).forEach(c => {
          sampleFamilySources[c.familySource] = (sampleFamilySources[c.familySource] || 0) + 1;
        });
        console.log(`[CollectionIntent] familyKey_source sample=${JSON.stringify(sampleFamilySources)}`);
        
        // ============================================
        // COMPUTE INTENT STRENGTH
        // ============================================
        // Get preferences count (from LLM intent if available)
        // Note: preferences are merged into softTerms earlier, but we can still count them if LLM provided them
        let preferencesCount = 0;
        if (llmIntentUsed && llmIntentResult?.intent?.preferences) {
          preferencesCount = Array.isArray(llmIntentResult.intent.preferences) ? llmIntentResult.intent.preferences.length : 0;
        }
        
        const intentStrength = Math.min(1.0, Math.max(0.0, (hardTerms.length * 2 + softTerms.length + preferencesCount) / 6));
        console.log(`[CollectionIntent] intent_strength=${intentStrength.toFixed(2)} hardTerms=${hardTerms.length} softTerms=${softTerms.length} preferences=${preferencesCount}`);
        
        // ============================================
        // COMPUTE COMMITMENT SCORE PER FAMILY
        // ============================================
        // Group candidates by family for commitment calculation
        const familyCandidatesMap = new Map<string, typeof candidatesWithFamilies>();
        candidatesWithFamilies.forEach(c => {
          if (!familyCandidatesMap.has(c.familyKey)) {
            familyCandidatesMap.set(c.familyKey, []);
          }
          familyCandidatesMap.get(c.familyKey)!.push(c);
        });
        
        // Compute commitment score per family
        const familyCommitmentScores = new Map<string, number>();
        const allPrices: number[] = [];
        const allTitleLengths: number[] = [];
        const allDescLengths: number[] = [];
        const allVariantCounts: number[] = [];
        
        // First pass: collect global stats for normalization
        candidatesWithFamilies.forEach(c => {
          const price = c.candidate.price ? parseFloat(String(c.candidate.price)) : 0;
          if (Number.isFinite(price) && price > 0) allPrices.push(price);
          
          const titleLen = c.candidate.title ? String(c.candidate.title).length : 0;
          if (titleLen > 0) allTitleLengths.push(titleLen);
          
          const descLen = c.candidate.description ? String(c.candidate.description).length : 0;
          if (descLen > 0) allDescLengths.push(descLen);
          
          // Count variants/options
          const optionValues = c.candidate.optionValues || {};
          const variantCount = Object.keys(optionValues).length;
          if (variantCount > 0) allVariantCounts.push(variantCount);
        });
        
        const medianPrice = allPrices.length > 0 ? [...allPrices].sort((a, b) => a - b)[Math.floor(allPrices.length / 2)] : 0;
        const avgTitleLength = allTitleLengths.length > 0 ? allTitleLengths.reduce((a, b) => a + b, 0) / allTitleLengths.length : 0;
        const avgDescLength = allDescLengths.length > 0 ? allDescLengths.reduce((a, b) => a + b, 0) / allDescLengths.length : 0;
        const avgVariantCount = allVariantCounts.length > 0 ? allVariantCounts.reduce((a, b) => a + b, 0) / allVariantCounts.length : 0;
        
        // Second pass: compute commitment score per family
        familyCandidatesMap.forEach((candidates, familyKey) => {
          const familyPrices: number[] = [];
          const familyTitleLengths: number[] = [];
          const familyDescLengths: number[] = [];
          const familyVariantCounts: number[] = [];
          let hasSetBundleKit = false;
          
          candidates.forEach(c => {
            const price = c.candidate.price ? parseFloat(String(c.candidate.price)) : 0;
            if (Number.isFinite(price) && price > 0) familyPrices.push(price);
            
            const titleLen = c.candidate.title ? String(c.candidate.title).length : 0;
            if (titleLen > 0) familyTitleLengths.push(titleLen);
            
            const descLen = c.candidate.description ? String(c.candidate.description).length : 0;
            if (descLen > 0) familyDescLengths.push(descLen);
            
            const optionValues = c.candidate.optionValues || {};
            const variantCount = Object.keys(optionValues).length;
            if (variantCount > 0) familyVariantCounts.push(variantCount);
            
            // Check for set/bundle/kit/complete signals (generic, industry-agnostic)
            const searchText = extractSearchText(c.candidate).toLowerCase();
            if (/\b(set|bundle|kit|complete|pack|collection|ensemble)\b/.test(searchText)) {
              hasSetBundleKit = true;
            }
          });
          
          const familyMedianPrice = familyPrices.length > 0 
            ? [...familyPrices].sort((a, b) => a - b)[Math.floor(familyPrices.length / 2)] 
            : 0;
          const familyAvgTitleLength = familyTitleLengths.length > 0 
            ? familyTitleLengths.reduce((a, b) => a + b, 0) / familyTitleLengths.length 
            : 0;
          const familyAvgDescLength = familyDescLengths.length > 0 
            ? familyDescLengths.reduce((a, b) => a + b, 0) / familyDescLengths.length 
            : 0;
          const familyAvgVariantCount = familyVariantCounts.length > 0 
            ? familyVariantCounts.reduce((a, b) => a + b, 0) / familyVariantCounts.length 
            : 0;
          
          // Compute normalized commitment components (0..1 each)
          const priceComponent = medianPrice > 0 ? Math.min(1.0, familyMedianPrice / (medianPrice * 2)) : 0.5;
          const complexityComponent = avgTitleLength > 0 && avgDescLength > 0
            ? Math.min(1.0, ((familyAvgTitleLength / avgTitleLength) + (familyAvgDescLength / avgDescLength)) / 2)
            : 0.5;
          const variantComponent = avgVariantCount > 0
            ? Math.min(1.0, familyAvgVariantCount / (avgVariantCount * 2))
            : 0.5;
          const setBundleComponent = hasSetBundleKit ? 0.8 : 0.3;
          
          // Weighted average (normalize to 0..1)
          const commitmentScore = (priceComponent * 0.4 + complexityComponent * 0.2 + variantComponent * 0.2 + setBundleComponent * 0.2);
          familyCommitmentScores.set(familyKey, commitmentScore);
        });
        
        // Log commitment scores
        const perFamilyCommitment: Record<string, number> = {};
        familyCommitmentScores.forEach((score, key) => {
          perFamilyCommitment[key] = parseFloat(score.toFixed(2));
        });
        console.log(`[CollectionIntent] per_family_commitment=${JSON.stringify(perFamilyCommitment)}`);
        
        // ============================================
        // CANONICALIZE AND MERGE FAMILY GROUPS
        // ============================================
        // First, build raw family stats (before canonicalization)
        // Note: candidatesWithFamilies already has canonicalKey in familyKey, but we need to use rawFamilyKey for proper merging
        const rawFamilyStats = new Map<string, { count: number; topBM25: number; commitmentScore: number; rawKey: string }>();
        candidatesWithFamilies.forEach(c => {
          // Use rawFamilyKey (original) for building raw stats, then canonicalize for merging
          const rawKey = c.rawFamilyKey || c.familyKey; // Fallback to familyKey if rawFamilyKey missing
          const existing = rawFamilyStats.get(rawKey);
          // Get commitment score using the canonical key (familyKey)
          const commitmentScore = familyCommitmentScores.get(c.familyKey) || 0.5;
          if (!existing || c.score > existing.topBM25) {
            rawFamilyStats.set(rawKey, {
              count: (existing?.count || 0) + 1,
              topBM25: c.score,
              commitmentScore,
              rawKey
            });
          } else {
            rawFamilyStats.set(rawKey, {
              ...existing,
              count: existing.count + 1,
              commitmentScore,
              rawKey
            });
          }
        });
        
        // Log sample normalization for debugging
        const normalizationSample: Array<{ raw: string; canonical: string }> = [];
        Array.from(rawFamilyStats.keys()).slice(0, 10).forEach(rawKey => {
          const canonical = canonicalizeGroupKey(rawKey);
          normalizationSample.push({ raw: rawKey, canonical });
        });
        console.log(`[CollectionIntent] group_key_normalization sample=${JSON.stringify(normalizationSample)}`);
        
        // Merge groups by canonicalKey
        const canonicalFamilyStats = new Map<string, { 
          count: number; 
          topBM25: number; 
          commitmentScore: number; 
          mergedFrom: string[];
        }>();
        
        rawFamilyStats.forEach((stats, rawKey) => {
          const canonicalKey = canonicalizeGroupKey(rawKey);
          const existing = canonicalFamilyStats.get(canonicalKey);
          
          if (!existing) {
            canonicalFamilyStats.set(canonicalKey, {
              count: stats.count,
              topBM25: stats.topBM25,
              commitmentScore: stats.commitmentScore,
              mergedFrom: [rawKey]
            });
          } else {
            // Merge: sum counts, max BM25, max commitment
            canonicalFamilyStats.set(canonicalKey, {
              count: existing.count + stats.count,
              topBM25: Math.max(existing.topBM25, stats.topBM25),
              commitmentScore: Math.max(existing.commitmentScore, stats.commitmentScore),
              mergedFrom: [...existing.mergedFrom, rawKey]
            });
          }
        });
        
        // Log merged groups (show examples of merges)
        const mergedExamples: Array<{ canonical: string; mergedFrom: string[] }> = [];
        canonicalFamilyStats.forEach((stats, canonicalKey) => {
          if (stats.mergedFrom.length > 1) {
            mergedExamples.push({ canonical: canonicalKey, mergedFrom: stats.mergedFrom });
          }
        });
        const removedCount = rawFamilyStats.size - canonicalFamilyStats.size;
        console.log(`[CollectionIntent] merged_groups removed=${removedCount} examples=${JSON.stringify(mergedExamples.slice(0, 5))}`);
        
        // Score each family: maxBM25 (or avgBM25 + count) - using maxBM25 for simplicity
        const familyGroups = Array.from(canonicalFamilyStats.entries())
          .map(([canonicalKey, stats]) => ({ 
            key: canonicalKey, // Use canonical key
            rawKey: stats.mergedFrom[0], // Keep first raw key for reference
            ...stats 
          }))
          .sort((a, b) => {
            // First by top BM25 score (descending)
            if (Math.abs(b.topBM25 - a.topBM25) > 0.01) {
              return b.topBM25 - a.topBM25;
            }
            // Then by count (descending)
            return b.count - a.count;
          });
        
        console.log(`[CollectionIntent] family_groups=${JSON.stringify(familyGroups.slice(0, 10).map(f => ({ key: f.key, count: f.count, topBM25: f.topBM25.toFixed(2), commitment: f.commitmentScore.toFixed(2), mergedFrom: f.mergedFrom.length > 1 ? f.mergedFrom : undefined })))}`);
        
        // ============================================
        // FILTER FAMILIES BASED ON INTENT STRENGTH
        // ============================================
        // Always include the top 1 family by BM25 relevance
        const topFamily = familyGroups.length > 0 ? familyGroups[0] : null;
        const topFamilyBM25 = topFamily ? topFamily.topBM25 : 0;
        
        // Filter families based on intent strength and commitment
        let filteredFamilies: Array<{ key: string; count: number; topBM25: number; commitmentScore: number }> = [];
        const excludedFamilies: Array<{ key: string; reason: string }> = [];
        
        if (topFamily) {
          filteredFamilies.push(topFamily); // Always include top family
        }
        
        // For remaining families, apply filtering when intent strength is low
        for (let i = 1; i < familyGroups.length && filteredFamilies.length < 4; i++) {
          const family = familyGroups[i];
          
          // Skip if similar to already chosen
          const isSimilar = filteredFamilies.some(chosen => 
            chosen.key.includes(family.key) || family.key.includes(chosen.key)
          );
          if (isSimilar) continue;
          
          // Skip "unknown" unless we have <2 families or it's close to top BM25
          if (family.key === "unknown") {
            if (filteredFamilies.length >= 2 && family.topBM25 < topFamilyBM25 * 0.85) {
              excludedFamilies.push({ key: family.key, reason: "unknown_low_relevance" });
              continue;
            }
          }
          
          // Apply commitment filtering when intent strength is low
          if (intentStrength < 0.35) {
            const commitmentScore = family.commitmentScore;
            const bm25Ratio = topFamilyBM25 > 0 ? family.topBM25 / topFamilyBM25 : 0;
            
            // Exclude high-commitment families unless BM25 is close to top
            if (commitmentScore > 0.65 && bm25Ratio < 0.85) {
              excludedFamilies.push({ 
                key: family.key, 
                reason: `high_commitment_low_intent commitment=${commitmentScore.toFixed(2)} bm25Ratio=${bm25Ratio.toFixed(2)}` 
              });
              continue;
            }
          }
          
          filteredFamilies.push(family);
        }
        
        // If we still have <2 families, include "unknown" as last resort
        if (filteredFamilies.length < 2) {
          const unknownFamily = familyGroups.find(f => f.key === "unknown");
          if (unknownFamily && !filteredFamilies.some(f => f.key === "unknown")) {
            filteredFamilies.push(unknownFamily);
          }
          
          // Also add any remaining families if still <2
          if (filteredFamilies.length < 2) {
            const remaining = familyGroups
              .filter(f => !filteredFamilies.some(chosen => chosen.key === f.key))
              .slice(0, 2 - filteredFamilies.length);
            filteredFamilies.push(...remaining);
          }
        }
        
        console.log(`[CollectionIntent] filtered_families=${JSON.stringify(filteredFamilies.map(f => ({ key: f.key, count: f.count, topBM25: f.topBM25.toFixed(2), commitment: f.commitmentScore.toFixed(2) })))} excluded=${JSON.stringify(excludedFamilies)}`);
        
        // Use filtered families as chosen families
        let chosenFamilies: Array<{ key: string; count: number; topBM25: number }> = filteredFamilies.map(f => ({
          key: f.key,
          count: f.count,
          topBM25: f.topBM25
        }));
        
        const candidatePool = familyGroups;
        const totalCount = candidatesWithFamilies.length;
        
        // ============================================
        // DOMINANT FAMILY DETECTION (fixed calculation)
        // ============================================
        const dominantFamilyKey = chosenFamilies.length > 0 ? chosenFamilies[0].key : null;
        let dominantCount = 0;
        
        if (dominantFamilyKey) {
          dominantCount = candidatesWithFamilies.filter(c => c.familyKey === dominantFamilyKey).length;
        }
        
        const share = totalCount > 0 ? Math.min(1.0, Math.max(0.0, dominantCount / totalCount)) : 0;
        const dominantDetected = totalCount >= 12 && share >= 0.70;
        
        if (dominantDetected && dominantFamilyKey) {
          console.log(`[CollectionIntent] dominant_family_detected=true token=${dominantFamilyKey} share=${share.toFixed(2)} dominantCount=${dominantCount} total=${totalCount}`);
          
          // Force inclusion of at least 2 families (expand if needed)
          const remainingFamilies = candidatePool.filter(f => 
            !chosenFamilies.some(chosen => chosen.key === f.key) &&
            !chosenFamilies.some(chosen => chosen.key.includes(f.key) || f.key.includes(chosen.key))
          );
          
          // Force-pick families that don't match the dominant family
          const distinctFamilies = remainingFamilies.filter(f => f.key !== dominantFamilyKey);
          
          // Expand to at least 2 families, up to 4
          const toAdd = Math.min(4 - chosenFamilies.length, distinctFamilies.length);
          chosenFamilies.push(...distinctFamilies.slice(0, toAdd));
          
          // If still not enough, add any remaining distinct families
          if (chosenFamilies.length < 2) {
            const moreDistinct = remainingFamilies.slice(0, 2 - chosenFamilies.length);
            chosenFamilies.push(...moreDistinct);
          }
        } else if (dominantFamilyKey) {
          console.log(`[CollectionIntent] dominant_family_detected=false token=${dominantFamilyKey} share=${share.toFixed(2)} dominantCount=${dominantCount} total=${totalCount}`);
        }
        
        // Check if catalog is limited (only one family available)
        if (familyGroups.length <= 1) {
          console.log(`[CollectionIntent] limited_catalog=true reason=only_one_family_available`);
        }
        
        const chosenFamilyKeys = chosenFamilies.map(f => f.key);
        console.log(`[CollectionIntent] chosenFamilies=${JSON.stringify(chosenFamilies.map(f => ({ key: f.key, count: f.count, topBM25: f.topBM25.toFixed(2) })))}`);
        
        // ============================================
        // ROUND-ROBIN BALANCED WINDOW (30 candidates)
        // ============================================
        // Partition into buckets per chosen familyKey (preserve BM25 order inside each bucket)
        const familyBuckets = new Map<string, typeof candidatesWithFamilies>();
        chosenFamilyKeys.forEach(familyKey => {
          const bucket = candidatesWithFamilies
            .filter(c => c.familyKey === familyKey)
            .slice(0, Math.ceil(aiWindow / chosenFamilyKeys.length) + 5); // Take extra for round-robin
          familyBuckets.set(familyKey, bucket);
        });
        
        // Fill windowSize=30 via round-robin cycling buckets
        const balanced30: typeof candidatesWithFamilies = [];
        const windowSize30 = Math.min(30, aiWindow * 1.5); // Use 30 or 1.5x aiWindow, whichever is smaller
        let roundRobinIndex = 0;
        
        while (balanced30.length < windowSize30) {
          let addedThisRound = false;
          
          chosenFamilyKeys.forEach(familyKey => {
            if (balanced30.length >= windowSize30) return;
            
            const bucket = familyBuckets.get(familyKey) || [];
            if (bucket.length > roundRobinIndex) {
              balanced30.push(bucket[roundRobinIndex]);
              addedThisRound = true;
            }
          });
          
          if (!addedThisRound) break; // All buckets exhausted
          roundRobinIndex++;
        }
        
        // Fill remaining slots with highest-scored candidates from any family
        if (balanced30.length < windowSize30) {
          const remaining = candidatesWithFamilies
            .filter(c => !balanced30.some(b => b.candidate.handle === c.candidate.handle))
            .slice(0, windowSize30 - balanced30.length);
          balanced30.push(...remaining);
        }
        
        // Log per-family counts for balanced 30
        const perFamilyCounts30: Record<string, number> = {};
        balanced30.forEach(c => {
          perFamilyCounts30[c.familyKey] = (perFamilyCounts30[c.familyKey] || 0) + 1;
        });
        console.log(`[CollectionIntent] ai_window_balanced windowSize=30 perFamilyCounts=${JSON.stringify(perFamilyCounts30)}`);
        
        // ============================================
        // SAFETY GUARD: Force at least 2 families in final 20
        // ============================================
        // Check if query contains outfit-like phrases
        const lowerIntent = userIntent.toLowerCase();
        const hasOutfitPhrase = lowerIntent.includes("outfit") || lowerIntent.includes("ensemble") || lowerIntent.includes("set");
        
        let final20: typeof candidatesWithFamilies = [];
        
        if (hasOutfitPhrase && dominantDetected && chosenFamilyKeys.length >= 2) {
          // Force inclusion of at least 2 families, each contributing at least 2 items if possible
          const minFamilies = Math.min(4, chosenFamilyKeys.length);
          const familiesToUse = chosenFamilyKeys.slice(0, minFamilies);
          const itemsPerFamily = Math.floor(20 / familiesToUse.length);
          const extraItems = 20 % familiesToUse.length;
          
          familiesToUse.forEach((familyKey, idx) => {
            const targetCount = itemsPerFamily + (idx < extraItems ? 1 : 0);
            const familyItems = balanced30
              .filter(c => c.familyKey === familyKey)
              .slice(0, targetCount);
            final20.push(...familyItems);
          });
          
          // Fill remaining slots from balanced30 if needed
          if (final20.length < 20) {
            const remaining = balanced30
              .filter(c => !final20.some(f => f.candidate.handle === c.candidate.handle))
              .slice(0, 20 - final20.length);
            final20.push(...remaining);
          }
          
          // Log per-family counts for final 20
          const perFamilyCounts20: Record<string, number> = {};
          final20.forEach(c => {
            perFamilyCounts20[c.familyKey] = (perFamilyCounts20[c.familyKey] || 0) + 1;
          });
          console.log(`[CollectionIntent] ai_candidates20_perFamily=${JSON.stringify(perFamilyCounts20)}`);
        } else {
          // Standard: take first 20 from balanced 30
          final20 = balanced30.slice(0, 20);
          
          // Log per-family counts for final 20
          const perFamilyCounts20: Record<string, number> = {};
          final20.forEach(c => {
            perFamilyCounts20[c.familyKey] = (perFamilyCounts20[c.familyKey] || 0) + 1;
          });
          console.log(`[CollectionIntent] ai_candidates20_perFamily=${JSON.stringify(perFamilyCounts20)}`);
        }
        
        topCandidates = final20.slice(0, aiWindow).map(r => r.candidate);
      } else {
        // Standard behavior: take top aiWindow candidates
        topCandidates = rankedCandidates.slice(0, aiWindow).map(r => r.candidate);
      }
      
      console.log("[App Proxy] [Layer 2] Pre-ranked top", topCandidates.length, "candidates for AI");
      const bm25EndSingle = performance.now();
      const bm25MsSingle = Math.round(bm25EndSingle - bm25StartSingle);
      
      // Update allCandidates to use gated pool for AI ranking
      // Store full pool for top-up, but AI only sees gated candidates
      const allCandidatesForTopUp = allCandidatesEnriched; // Full pool for fallback
      allCandidates = gatedCandidates; // Gated pool for AI (will be typed correctly when used)
      
      // Keep includeTerms for backward compatibility (used in existing code)
      const includeTerms = softTerms;

      // variantPreferences and variantConstraints2 are already computed earlier (before gating)
      // Log variantPreferences for debugging (already computed above)
      console.log("[App Proxy] Variant preferences:", variantPreferences);

      // Boost candidates that match preferences (generic, all industries)
      function getCandidateOptionValues(candidate: any, prefKey: string): string[] {
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

      // LAYER 3: AI Rerank (intent-safe)
      // Branch: Bundle handling vs single-item handling
      let sortedCandidates: EnrichedCandidate[];
      let isBundleMode = false;
      // Store per-item pools for bundle AI candidate selection (accessible in bundle AI block)
      let itemGatedPools: Array<{ itemIndex: number; candidates: EnrichedCandidate[]; hardTerms: string[] }> = [];
      
      // BM25 timing: start before bundle/single-item split (bundle path does its own BM25)
      let bm25Start = performance.now();
      
      if (bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        // BUNDLE PATH: Handle multi-item queries
        isBundleMode = true;
        console.log("[Bundle] [Layer 3] Processing bundle with", bundleIntent.items.length, "items");
        
        // Gate candidates per item
        itemGatedPools = [];
        
        for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
          const bundleItem = bundleItemsWithBudget[itemIdx] as BundleItemWithBudget;
          const itemHardTerms = bundleItem.hardTerms;
          
          // Issue 2/3 fix: Use per-item retrieval set if available, otherwise fall back to allCandidatesEnriched
          const itemRetrievalSet = bundleFetchByItemIndex.get(itemIdx);
          let baseCandidatesForItem: EnrichedCandidate[] = [];
          
          if (itemRetrievalSet && itemRetrievalSet.length > 0) {
            // Try to find bundle products in allCandidatesEnriched first
            const foundInEnriched = itemRetrievalSet.map((p: any) => {
              return allCandidatesEnriched.find(c => c.handle === p.handle);
            }).filter((c: any): c is EnrichedCandidate => c !== undefined);
            
            // If some products weren't found (filtered out or not enriched), enrich them on-the-fly
            const missingHandles = new Set(itemRetrievalSet.map((p: any) => p.handle));
            foundInEnriched.forEach(c => missingHandles.delete(c.handle));
            
            if (missingHandles.size > 0) {
              // Enrich missing products on-the-fly
              const missingProducts = itemRetrievalSet.filter((p: any) => missingHandles.has(p.handle));
              const enrichedMissing = missingProducts.map((p: any) => {
                const candidate = {
                  handle: p.handle,
                  title: p.title,
                  productType: (p as any).productType || null,
                  productCategory: (p as any).productCategory || (p as any).category || null,
                  taxonomy: (p as any).taxonomy || null,
                  collections: (p as any).collections || null,
                  variants: (p as any).variants || null,
                  tags: p.tags || [],
                  vendor: (p as any).vendor || null,
                  price: p.priceAmount || p.price || null,
                  priceMinAmount: (p as any).priceMinAmount ?? null,
                  priceMaxAmount: (p as any).priceMaxAmount ?? null,
                  priceCurrency: (p as any).priceCurrency ?? (p as any).currencyCode ?? null,
                  description: null as string | null,
                  descPlain: "",
                  desc1000: "",
                  available: p.available,
                  sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
                  colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
                  materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
                  optionValues: (p as any).optionValues ?? {},
                  metafields: (p as any).metafields || null,
                };
                const searchText = extractSearchText(candidate, indexMetafields);
                return {
                  ...candidate,
                  searchText,
                } as EnrichedCandidate;
              });
              
              // Issue 3 fix: Add on-the-fly enriched products to allCandidatesEnriched so they can be validated
              const existingHandlesInEnriched = new Set(allCandidatesEnriched.map(c => c.handle));
              const newEnriched = enrichedMissing.filter(c => !existingHandlesInEnriched.has(c.handle));
              if (newEnriched.length > 0) {
                allCandidatesEnriched.push(...newEnriched);
                console.log(`[Bundle] itemIndex=${itemIdx} added_to_allCandidatesEnriched count=${newEnriched.length} total_enriched=${allCandidatesEnriched.length}`);
              }
              
              baseCandidatesForItem = [...foundInEnriched, ...enrichedMissing];
              console.log(`[Bundle] itemIndex=${itemIdx} using_per_item_retrieval_set count=${baseCandidatesForItem.length} from_retrieval=${itemRetrievalSet.length} enriched_on_fly=${enrichedMissing.length}`);
            } else {
              baseCandidatesForItem = foundInEnriched;
              console.log(`[Bundle] itemIndex=${itemIdx} using_per_item_retrieval_set count=${baseCandidatesForItem.length} from_retrieval=${itemRetrievalSet.length}`);
            }
          } else {
            baseCandidatesForItem = allCandidatesEnriched;
          }
          
          // Issue 2 fix: Apply per-item budget with improved matching using perItemBudgetsForBundle
          let itemPriceMin: number | null = null;
          let itemPriceMax: number | null = null;
          
          const itemTypeForBudget = (bundleItem as any).canonicalType || itemHardTerms[0] || `item${itemIdx}`;
          const itemTypeLower = itemTypeForBudget.toLowerCase();
          const itemTermsLower = itemHardTerms.map(t => t.toLowerCase());
          
          // First, try to match from perItemBudgetsForBundle (parsed from conversation messages)
          if (perItemBudgetsForBundle && perItemBudgetsForBundle.length > 0) {
            for (const perItemBudget of perItemBudgetsForBundle) {
              // Check if this budget's itemType matches this bundle item
              const budgetItemTypeLower = perItemBudget.itemType.toLowerCase();
              if (budgetItemTypeLower === itemTypeLower || 
                  perItemBudget.itemTerms.some(term => itemTermsLower.includes(term.toLowerCase())) ||
                  itemTermsLower.some(term => perItemBudget.itemTerms.some(bt => bt.toLowerCase() === term))) {
                if (perItemBudget.min !== null && itemPriceMin === null) itemPriceMin = perItemBudget.min;
                if (perItemBudget.max !== null && itemPriceMax === null) itemPriceMax = perItemBudget.max;
                console.log(`[Bundle] itemIndex=${itemIdx} itemType=${itemTypeForBudget} budget_min=${itemPriceMin ?? "null"} budget_max=${itemPriceMax ?? "null"} reason=matched_per_item_budget source="${perItemBudget.source.substring(0, 50)}"`);
                break; // Use first match
              }
            }
          }
          
          // Fallback: try to match from detectedBudgetsForBundle using text matching
          if (itemPriceMin === null && itemPriceMax === null) {
            for (const budget of detectedBudgetsForBundle) {
              const budgetSourceLower = budget.source.toLowerCase();
              // Check if budget source mentions this item type
              if (budgetSourceLower.includes(itemTypeLower) || 
                  itemTermsLower.some(term => budgetSourceLower.includes(term))) {
                if (budget.min !== null && itemPriceMin === null) itemPriceMin = budget.min;
                if (budget.max !== null && itemPriceMax === null) itemPriceMax = budget.max;
                console.log(`[Bundle] itemIndex=${itemIdx} itemType=${itemTypeForBudget} budget_min=${itemPriceMin ?? "null"} budget_max=${itemPriceMax ?? "null"} reason=matched_detected_budget`);
                break;
              }
            }
          }
          
          // Final fallback: use global budget
          if (itemPriceMin === null && itemPriceMax === null) {
            itemPriceMin = priceMin;
            itemPriceMax = priceMax;
            console.log(`[Bundle] itemIndex=${itemIdx} itemType=${itemTypeForBudget} budget_min=${itemPriceMin ?? "null"} budget_max=${itemPriceMax ?? "null"} reason=using_global_budget`);
          }
          
          // Gate candidates for this item using item-specific constraints
          // First pass: item-specific facet + hard term matching (no budget filter)
          const itemConstraints = bundleItem.constraints;
          const itemOptionConstraints = itemConstraints?.optionConstraints;
          
          // Convert old format to generic constraints
          const { convertOptionConstraintsToConstraints, convertHardFacetsToConstraints, mergeConstraints: mergeFacetConstraints, productSatisfiesConstraints, relaxConstraints } = await import("~/utils/facets.server");
          
          const globalFacetConstraints = convertHardFacetsToConstraints(hardFacets, "global");
          const itemFacetConstraints = convertOptionConstraintsToConstraints(itemOptionConstraints || {}, "item");
          const mergedItemConstraints = mergeFacetConstraints(globalFacetConstraints, itemFacetConstraints);
          
          console.log(`[Constraints] bundle_item=${itemIdx} global=[${globalFacetConstraints.map(c => `${c.key}:${c.value}`).join(", ")}] per_item=[${itemFacetConstraints.map(c => `${c.key}:${c.value}`).join(", ")}] merged=[${mergedItemConstraints.map(c => `${c.key}:${c.value}`).join(", ")}]`);
          
          // Gate with constraints using new helper that checks structured OR tag-derived facets
          // Issue 2/3 fix: Use baseCandidatesForItem (per-item retrieval set) instead of allCandidatesEnriched
          let itemGatedUnfiltered: EnrichedCandidate[] = [];
          for (const c of baseCandidatesForItem) {
            // Issue 2/3 fix: Apply availability filter per-item
            if (experience.inStockOnly && !c.available) {
              continue; // Skip unavailable products
            }
            
            // Issue 2/3 fix: Apply budget filter per-item
            if (itemPriceMin !== null || itemPriceMax !== null) {
              const productMin = (c as any).priceMinAmount ?? null;
              const productMax = (c as any).priceMaxAmount ?? null;
              const singlePrice = (c as any).priceAmount ? parseFloat(String((c as any).priceAmount)) : ((c as any).price ? parseFloat(String((c as any).price)) : NaN);
              
              if (productMin !== null || productMax !== null) {
                const prodMin = productMin ?? productMax ?? singlePrice;
                const prodMax = productMax ?? productMin ?? singlePrice;
                
                if (typeof itemPriceMin === "number" && prodMax < itemPriceMin) {
                  continue; // Below min budget
                }
                if (typeof itemPriceMax === "number" && prodMin > itemPriceMax) {
                  continue; // Above max budget
                }
              } else if (Number.isFinite(singlePrice)) {
                // Fallback to single price
                if (typeof itemPriceMin === "number" && singlePrice < itemPriceMin) {
                  continue;
                }
                if (typeof itemPriceMax === "number" && singlePrice > itemPriceMax) {
                  continue;
                }
              }
            }
            
            // Apply facet constraints
            if (mergedItemConstraints.length > 0) {
              const constraintResult = await satisfiesConstraintsStructuredOrTags(c, mergedItemConstraints, facetVocabulary);
              if (!constraintResult.ok) {
                continue; // Skip this candidate
              }
            }
            itemGatedUnfiltered.push(c);
            }
            
            // Apply token-based slot matching for this item (industry-agnostic)
          itemGatedUnfiltered = itemGatedUnfiltered.filter(c => {
            // Build slot descriptor from item hardTerms
            const slotDescriptor = itemHardTerms.join(" ");
            const slotScore = scoreProductForSlot(c, slotDescriptor);
            // Require minimum score threshold (0.1 = at least 10% token overlap)
            if (slotScore < 0.1) return false;
            
            // Apply item-specific include/exclude terms if present (use token-based scoring)
            if (itemConstraints?.includeTerms && itemConstraints.includeTerms.length > 0) {
              const includeDescriptor = itemConstraints.includeTerms.join(" ");
              const includeScore = scoreProductForSlot(c, includeDescriptor);
              if (includeScore < 0.1) return false;
            }
            
            if (itemConstraints?.excludeTerms && itemConstraints.excludeTerms.length > 0) {
              const excludeDescriptor = itemConstraints.excludeTerms.join(" ");
              const excludeScore = scoreProductForSlot(c, excludeDescriptor);
              if (excludeScore >= 0.1) return false; // Exclude if matches exclude term
            }
            
            return true;
          });
          
          // Staged fallback: if constraints cause zero matches, relax constraints
          if (itemGatedUnfiltered.length === 0 && mergedItemConstraints.length > 0) {
            console.log(`[Constraints] bundle_item=${itemIdx} strict_gate_count=0 - applying staged fallback`);
            
            // Stage 1: relax least important constraint
            const stage1Result = relaxConstraints(mergedItemConstraints, facetVocabularyForBundle.optionNames, 1);
            const stage1Gated: EnrichedCandidate[] = [];
            for (const c of baseCandidatesForItem) {
              // Apply availability and budget filters
              if (experience.inStockOnly && !c.available) continue;
              
              if (itemPriceMin !== null || itemPriceMax !== null) {
                const productMin = (c as any).priceMinAmount ?? null;
                const productMax = (c as any).priceMaxAmount ?? null;
                const singlePrice = (c as any).priceAmount ? parseFloat(String((c as any).priceAmount)) : ((c as any).price ? parseFloat(String((c as any).price)) : NaN);
                
                if (productMin !== null || productMax !== null) {
                  const prodMin = productMin ?? productMax ?? singlePrice;
                  const prodMax = productMax ?? productMin ?? singlePrice;
                  if (typeof itemPriceMin === "number" && prodMax < itemPriceMin) continue;
                  if (typeof itemPriceMax === "number" && prodMin > itemPriceMax) continue;
                } else if (Number.isFinite(singlePrice)) {
                  if (typeof itemPriceMin === "number" && singlePrice < itemPriceMin) continue;
                  if (typeof itemPriceMax === "number" && singlePrice > itemPriceMax) continue;
                }
              }
              if (stage1Result.relaxed.length > 0) {
                // Use satisfiesConstraintsStructuredOrTags to check structured OR tags (not just structured)
                const constraintResult = await satisfiesConstraintsStructuredOrTags(c, stage1Result.relaxed, facetVocabulary);
                if (!constraintResult.ok) {
                  continue;
                }
              }
              
              const slotDescriptor = itemHardTerms.join(" ");
              const slotScore = scoreProductForSlot(c, slotDescriptor);
              if (slotScore < 0.1) continue;
              
              if (itemConstraints?.includeTerms && itemConstraints.includeTerms.length > 0) {
                const includeDescriptor = itemConstraints.includeTerms.join(" ");
                const includeScore = scoreProductForSlot(c, includeDescriptor);
                if (includeScore < 0.1) continue;
              }
              
              if (itemConstraints?.excludeTerms && itemConstraints.excludeTerms.length > 0) {
                const excludeDescriptor = itemConstraints.excludeTerms.join(" ");
                const excludeScore = scoreProductForSlot(c, excludeDescriptor);
                if (excludeScore >= 0.1) continue;
              }
              
              stage1Gated.push(c);
            }
            
            if (stage1Gated.length > 0) {
              itemGatedUnfiltered = stage1Gated;
              console.log(`[Constraints] relaxed bundle_item=${itemIdx} removed=[${stage1Result.removed.map(c => `${c.key}:${c.value}`).join(", ")}] reason=${stage1Result.reason} stage1_count=${stage1Gated.length}`);
            } else {
              // Stage 2: remove all constraints (keep anchor terms only)
              const stage2Result = relaxConstraints(mergedItemConstraints, facetVocabularyForBundle.optionNames, 2);
              const stage2Gated = baseCandidatesForItem.filter(c => {
                // Apply availability and budget filters
                if (experience.inStockOnly && !c.available) return false;
                
                if (itemPriceMin !== null || itemPriceMax !== null) {
                  const productMin = (c as any).priceMinAmount ?? null;
                  const productMax = (c as any).priceMaxAmount ?? null;
                  const singlePrice = (c as any).priceAmount ? parseFloat(String((c as any).priceAmount)) : ((c as any).price ? parseFloat(String((c as any).price)) : NaN);
                  
                  if (productMin !== null || productMax !== null) {
                    const prodMin = productMin ?? productMax ?? singlePrice;
                    const prodMax = productMax ?? productMin ?? singlePrice;
                    if (typeof itemPriceMin === "number" && prodMax < itemPriceMin) return false;
                    if (typeof itemPriceMax === "number" && prodMin > itemPriceMax) return false;
                  } else if (Number.isFinite(singlePrice)) {
                    if (typeof itemPriceMin === "number" && singlePrice < itemPriceMin) return false;
                    if (typeof itemPriceMax === "number" && singlePrice > itemPriceMax) return false;
                  }
                }
                const slotDescriptor = itemHardTerms.join(" ");
                const slotScore = scoreProductForSlot(c, slotDescriptor);
                if (slotScore < 0.1) return false;
                
                if (itemConstraints?.includeTerms && itemConstraints.includeTerms.length > 0) {
                  const includeDescriptor = itemConstraints.includeTerms.join(" ");
                  const includeScore = scoreProductForSlot(c, includeDescriptor);
                  if (includeScore < 0.1) return false;
                }
                
                if (itemConstraints?.excludeTerms && itemConstraints.excludeTerms.length > 0) {
                  const excludeDescriptor = itemConstraints.excludeTerms.join(" ");
                  const excludeScore = scoreProductForSlot(c, excludeDescriptor);
                  if (excludeScore >= 0.1) return false;
                }
                
                return true;
              });
              
              if (stage2Gated.length > 0) {
                itemGatedUnfiltered = stage2Gated;
                console.log(`[Constraints] relaxed bundle_item=${itemIdx} removed=[${stage2Result.removed.map(c => `${c.key}:${c.value}`).join(", ")}] reason=${stage2Result.reason} stage2_count=${stage2Gated.length}`);
              }
            }
          }
          
          // Type anchor gating for bundle item: filter by non-facet hard terms
          // Guarantee anchor_terms is NEVER empty
          // Combine item hardTerms with includeTerms to get all item terms
          const itemTerms = [
            ...itemHardTerms,
            ...(itemConstraints?.includeTerms || [])
          ];
          // Normalize itemFacets to match expected type
          const itemFacets = {
            size: itemOptionConstraints?.size ?? hardFacets.size,
            color: itemOptionConstraints?.color ?? hardFacets.color,
            material: itemOptionConstraints?.material ?? hardFacets.material,
          };
          let nonFacetItemTerms = getNonFacetHardTerms(itemTerms, itemFacets);
          
          // Safety net: if nonFacetItemTerms is empty, use canonicalType or fallback to hardTerms
          if (nonFacetItemTerms.length === 0) {
            const bundleItem = bundleItemsWithBudget[itemIdx];
            const canonicalType = (bundleItem as any).canonicalType;
            if (canonicalType && canonicalType !== "unknown") {
              nonFacetItemTerms = [canonicalType];
              console.log(`[Bundle Gating] item=${itemIdx} anchor_terms_empty=true - using canonicalType="${canonicalType}" as anchor`);
            } else if (itemHardTerms.length > 0) {
              // Fallback to original hardTerms (at least one)
              nonFacetItemTerms = [itemHardTerms[0]];
              console.log(`[Bundle Gating] item=${itemIdx} anchor_terms_empty=true - using first hardTerm="${itemHardTerms[0]}" as anchor`);
            } else {
              // Last resort: use global hardTerms non-facet tokens
              const globalNonFacetTerms = getNonFacetHardTerms(hardTerms, hardFacets);
              if (globalNonFacetTerms.length > 0) {
                nonFacetItemTerms = [globalNonFacetTerms[0]];
                console.log(`[Bundle Gating] item=${itemIdx} anchor_terms_empty=true - using global nonFacetTerm="${globalNonFacetTerms[0]}" as anchor`);
              }
            }
          }
          
          // PRODUCTTYPE FILTERING: Infer productType filter for canonicalType (industry-agnostic)
          let itemGatedWithProductType = itemGatedUnfiltered;
          const bundleItemForTypeFilter = bundleItemsWithBudget[itemIdx];
          const itemTypeForFilter = (bundleItemForTypeFilter as any).canonicalType || nonFacetItemTerms[0] || itemHardTerms[0];
          
          if (itemTypeForFilter && itemGatedUnfiltered.length > 0) {
            // Build list of distinct productTypes from current filtered catalog
            const productTypes = new Set<string>();
            for (const c of allCandidatesEnriched) {
              if (c.productType && typeof c.productType === "string" && c.productType.trim()) {
                productTypes.add(c.productType.trim());
              }
            }
            
            if (productTypes.size > 0) {
              // Compute match score for each productType against itemType tokens
              const itemTypeTokens = itemTypeForFilter.toLowerCase().split(/[\s\-_]+/).filter((t: string) => t.length > 2);
              const productTypeScores = new Map<string, number>();
              
              for (const productType of productTypes) {
                const productTypeLower = productType.toLowerCase();
                const productTypeTokens = productTypeLower.split(/[\s\-_]+/).filter(t => t.length > 2);
                
                // Compute overlap score
                let score = 0;
                for (const itemToken of itemTypeTokens) {
                  if (productTypeTokens.includes(itemToken)) {
                    score += 2; // Exact token match
                  } else if (productTypeLower.includes(itemToken) || itemTypeForFilter.toLowerCase().includes(productTypeTokens[0] || "")) {
                    score += 1; // Substring match
                  }
                }
                
                // Normalize by token count
                if (itemTypeTokens.length > 0) {
                  score = score / itemTypeTokens.length;
                }
                
                if (score > 0) {
                  productTypeScores.set(productType, score);
                }
              }
              
              // Find productTypes that match above threshold (score >= 0.5)
              const matchedProductTypes = Array.from(productTypeScores.entries())
                .filter(([_, score]) => score >= 0.5)
                .sort(([_, a], [__, b]) => b - a)
                .map(([pt, _]) => pt);
              
              if (matchedProductTypes.length > 0) {
                const beforeProductType = itemGatedUnfiltered.length;
                itemGatedWithProductType = itemGatedUnfiltered.filter(c => {
                  const candidateProductType = c.productType ? String(c.productType).trim() : "";
                  return matchedProductTypes.some(mpt => 
                    candidateProductType.toLowerCase() === mpt.toLowerCase() ||
                    candidateProductType.toLowerCase().includes(mpt.toLowerCase()) ||
                    mpt.toLowerCase().includes(candidateProductType.toLowerCase())
                  );
                });
                
                // Only apply if it leaves a reasonable pool (>= 8 candidates)
                if (itemGatedWithProductType.length >= 8) {
                  console.log(`[Bundle] productType_filter itemIndex=${itemIdx} itemType=${itemTypeForFilter} matchedTypes=[${matchedProductTypes.join(", ")}] applied=true before=${beforeProductType} after=${itemGatedWithProductType.length}`);
                } else {
                  // Revert if pool too small
                  itemGatedWithProductType = itemGatedUnfiltered;
                  console.log(`[Bundle] productType_filter itemIndex=${itemIdx} itemType=${itemTypeForFilter} matchedTypes=[${matchedProductTypes.join(", ")}] applied=false reason=pool_too_small after=${itemGatedWithProductType.length}`);
                }
              }
            }
          }
          
          // NEGATIVE-TYPE GUARD: Exclude candidates that strongly match OTHER bundle item types
          let itemGatedAfterNegativeGuard = itemGatedWithProductType;
          if (bundleIntent.items.length > 1 && itemGatedWithProductType.length > 0) {
            const otherItemTypes: string[] = [];
            for (let otherIdx = 0; otherIdx < bundleIntent.items.length; otherIdx++) {
              if (otherIdx !== itemIdx) {
                const otherItemForGuard = bundleItemsWithBudget[otherIdx];
                const otherItemType = (otherItemForGuard as any).canonicalType || otherItemForGuard.hardTerms[0];
                if (otherItemType && otherItemType !== itemTypeForFilter) {
                  otherItemTypes.push(otherItemType);
                }
              }
            }
            
            if (otherItemTypes.length > 0) {
              const beforeNegative = itemGatedAfterNegativeGuard.length;
              const excludedByOtherTypes: string[] = [];
              
              itemGatedAfterNegativeGuard = itemGatedAfterNegativeGuard.filter(c => {
                const candidateText = [
                  c.title || "",
                  c.productType || "",
                  c.handle || "",
                  (c.tags || []).join(" "),
                ].join(" ").toLowerCase();
                
                // Check if candidate strongly matches any other item type
                for (const otherType of otherItemTypes) {
                  const otherTypeTokens = otherType.toLowerCase().split(/[\s\-_]+/).filter(t => t.length > 2);
                  const matchCount = otherTypeTokens.filter(token => candidateText.includes(token)).length;
                  
                  // If most tokens match, exclude
                  if (otherTypeTokens.length > 0 && matchCount / otherTypeTokens.length >= 0.7) {
                    excludedByOtherTypes.push(otherType);
                    return false;
                  }
                }
                
                return true;
              });
              
              const removed = beforeNegative - itemGatedAfterNegativeGuard.length;
              if (removed > 0) {
                const uniqueExcluded = Array.from(new Set(excludedByOtherTypes));
                console.log(`[Bundle] negative_type_guard itemIndex=${itemIdx} excludedByOtherTypes=[${uniqueExcluded.join(", ")}] removed=${removed}`);
              }
            }
          }
          
          let itemGatedAfterAnchor = itemGatedAfterNegativeGuard;
          if (nonFacetItemTerms.length > 0) {
            const beforeAnchor = itemGatedUnfiltered.length;
            
            // Build item-specific query tokens with morphology variants
            const itemQueryTokens: string[] = [];
            for (const term of nonFacetItemTerms) {
              const normalized = unifiedNormalize(term);
              const tokens = tokenize(normalized);
              itemQueryTokens.push(...tokens);
            }
            
            // Expand with morphology variants
            const itemExpandedTokens = expandQueryTokens(itemQueryTokens);
            
            // If initial anchor gating yields 0, try with decompounding
            let itemGatedWithMorphology = itemGatedUnfiltered.filter(c => {
              const searchText = unifiedNormalize(extractSearchText(c));
              const candidateTokens = new Set(tokenize(searchText));
              return Array.from(itemExpandedTokens).some(token => candidateTokens.has(token));
            });
            
            if (itemGatedWithMorphology.length === 0 && itemGatedUnfiltered.length > 0) {
              // Build vocabulary from itemGatedUnfiltered for decompounding
              const itemVocab = new Set<string>();
              for (const candidate of itemGatedUnfiltered) {
                const searchText = unifiedNormalize(extractSearchText(candidate));
                const tokens = tokenize(searchText);
                for (const token of tokens) {
                  if (token.length >= 4) {
                    itemVocab.add(token);
                  }
                }
              }
              
              // Expand with decompounding
              const itemExpandedWithDecompound = expandQueryTokens(itemQueryTokens, itemVocab);
              const originalItemTokens = Array.from(new Set(itemQueryTokens));
              const expandedItemTokens = Array.from(itemExpandedWithDecompound);
              const addedItemTokens = expandedItemTokens.filter(t => !originalItemTokens.includes(t));
              
              if (addedItemTokens.length > 0) {
                console.log(`[Morphology] bundle_item=${itemIdx} originalTokens=[${originalItemTokens.join(",")}] expandedTokens=[${expandedItemTokens.join(",")}] applied=true`);
                if (addedItemTokens.some(t => itemVocab.has(t))) {
                  console.log(`[Decompound] bundle_item=${itemIdx} applied=true addedTokens=[${addedItemTokens.filter(t => itemVocab.has(t)).join(",")}]`);
                }
              }
              
              // Retry with decompounded tokens
              itemGatedWithMorphology = itemGatedUnfiltered.filter(c => {
                const searchText = unifiedNormalize(extractSearchText(c));
                const candidateTokens = new Set(tokenize(searchText));
                return Array.from(itemExpandedWithDecompound).some(token => candidateTokens.has(token));
              });
            }
            
            itemGatedAfterAnchor = itemGatedWithMorphology;
            const afterAnchor = itemGatedAfterAnchor.length;
            console.log(`[Gating] mode=${modeUsed} flow=bundle bundle_item=${itemIdx} anchor_terms=[${nonFacetItemTerms.join(", ")}] before=${beforeAnchor} after=${afterAnchor}`);
          } else {
            console.log(`[Gating] mode=${modeUsed} flow=bundle bundle_item=${itemIdx} anchor_terms_empty=true (skipping anchor filter)`);
          }
          
          // STRONG vs WEAK productType matching: prefer productType-aligned matches
          let itemGated: EnrichedCandidate[] = itemGatedAfterAnchor;
          if (itemGatedAfterAnchor.length > 0 && itemTypeForFilter) {
            const itemTypeTokens = itemTypeForFilter.toLowerCase().split(/[\s\-_]+/).filter((t: string) => t.length > 2);
            
            if (itemTypeTokens.length > 0) {
              const strongMatches: EnrichedCandidate[] = [];
              const weakMatches: EnrichedCandidate[] = [];
              
              for (const candidate of itemGatedAfterAnchor) {
                const candidateProductType = (candidate.productType || "").toLowerCase();
                const candidateText = [
                  candidate.title || "",
                  candidate.handle || "",
                  candidate.searchText || "",
                ].join(" ").toLowerCase();
                
                // Check if productType contains itemType tokens (STRONG match)
                const productTypeHasTokens = itemTypeTokens.every((token: string) => candidateProductType.includes(token));
                
                // Check if indexed text contains tokens but productType does NOT (WEAK match)
                const textHasTokens = itemTypeTokens.every((token: string) => candidateText.includes(token));
                const isWeakMatch = textHasTokens && !productTypeHasTokens;
                
                if (productTypeHasTokens) {
                  strongMatches.push(candidate);
                } else if (isWeakMatch) {
                  weakMatches.push(candidate);
                } else {
                  // Neither strong nor weak - exclude (doesn't match itemType at all)
                }
              }
              
              // Determine if we should use STRONG only or STRONG + WEAK
              const slotsForItem = Math.ceil(finalResultCount / bundleItemsWithBudget.length);
              const minStrongThreshold = Math.max(8, slotsForItem);
              
              if (strongMatches.length >= minStrongThreshold) {
                itemGated = strongMatches;
                console.log(`[Bundle] strong_productType_match itemIndex=${itemIdx} itemType=${itemTypeForFilter} strong=${strongMatches.length} weak=${weakMatches.length} appliedStrongOnly=true`);
              } else {
                itemGated = [...strongMatches, ...weakMatches];
                console.log(`[Bundle] strong_productType_match itemIndex=${itemIdx} itemType=${itemTypeForFilter} strong=${strongMatches.length} weak=${weakMatches.length} appliedStrongOnly=false`);
              }
            }
          }
          
          // Second pass: apply budget filter (item-specific price ceiling or allocated budget)
          
          // Prefer item-specific price ceiling over allocated budget
          const itemPriceCeiling = itemConstraints?.priceCeiling;
          const budgetMax = itemPriceCeiling !== undefined && itemPriceCeiling !== null 
            ? itemPriceCeiling 
            : (bundleItem.budgetMax !== undefined && bundleItem.budgetMax !== null ? bundleItem.budgetMax : null);
          
          if (budgetMax !== null) {
            const itemGatedFiltered = itemGatedAfterAnchor.filter(c => {
              const price = c.price ? parseFloat(String(c.price)) : NaN;
              return !Number.isFinite(price) || price <= budgetMax;
            });
            
            // If filtered pool is empty, keep unfiltered but mark for trustFallback
            if (itemGatedFiltered.length > 0) {
              itemGated = itemGatedFiltered;
            } else {
              itemGated = itemGatedAfterAnchor;
              // Will set trustFallback later if needed
            }
          }
          
          // Pre-rank with BM25 for this item (using item-specific hard terms + global soft terms)
          // Include soft terms in BM25 ranking (they apply to all items, e.g., "formal", "casual")
          const itemTokens = [
            ...itemHardTerms.flatMap(t => tokenize(t)),
            ...softTerms.flatMap(t => tokenize(t))
          ];
          const itemIdf = calculateIDF(itemGated.map(c => ({ tokens: tokenize(c.searchText) })));
          const itemAvgLen = itemGated.reduce((sum, c) => sum + tokenize(c.searchText).length, 0) / itemGated.length || 1;
          
          const itemRanked = itemGated.map(c => {
            const docTokens = tokenize(c.searchText);
            const docTokenFreq = new Map<string, number>();
            for (const token of docTokens) {
              docTokenFreq.set(token, (docTokenFreq.get(token) || 0) + 1);
            }
            const score = bm25Score(itemTokens, docTokens, docTokenFreq, docTokens.length, itemAvgLen, itemIdf);
            return { candidate: c, score };
          });
          
          itemRanked.sort((a, b) => b.score - a.score);
          const gatedCount = itemGated.length;
          const topK = Math.min(MAX_BUNDLE_PRE_AI_PER_ITEM, itemRanked.length);
          const topCandidatesForItem = itemRanked.slice(0, topK).map(r => r.candidate);
          const bm25TopCount = topCandidatesForItem.length;
          
          itemGatedPools.push({
            itemIndex: itemIdx,
            candidates: topCandidatesForItem,
            hardTerms: itemHardTerms,
          });
          
          // Log per item with requested format
          const itemType = itemHardTerms[0] || "unknown";
          console.log("[Bundle] itemPool", { 
            itemIndex: itemIdx, 
            type: itemType, 
            gatedCount, 
            bm25TopCount 
          });
        }
        
        // Combine all item candidates for top-up (with itemIndex metadata)
        // Keep full per-item pools for top-up logic
        const allBundleCandidates = itemGatedPools.flatMap(pool => 
          pool.candidates.map(c => ({ ...c, _bundleItemIndex: pool.itemIndex, _bundleHardTerms: pool.hardTerms }))
        ) as any[];
        
        console.log("[Bundle] total candidates for top-up:", allBundleCandidates.length);
        // Update BM25 timing (includes bundle BM25 ranking)
        bm25Ms = Math.round(performance.now() - bm25Start);
      
      // Use pre-ranked top candidates (already sorted by BM25 + boosts) for top-up
        sortedCandidates = allBundleCandidates;
        
        console.log("[App Proxy] [Layer 3] Bundle candidates prepared:", sortedCandidates.length, "total (for top-up)");
      } else {
        // SINGLE-ITEM PATH: Existing logic (unchanged)
        // Use pre-ranked top candidates (already sorted by BM25 + boosts)
        sortedCandidates = topCandidates;
        // Update BM25 timing (single-item path - BM25 was done earlier)
        bm25Ms = bm25MsSingle;
      
      console.log("[App Proxy] [Layer 3] Sending", sortedCandidates.length, "pre-ranked candidates to AI");
      }

      // AI pass #1 + Top-up passes (deterministic)
      const targetCount = Math.min(finalResultCount, sortedCandidates.length);

      let finalHandles: string[] = [];
      let finalSource: "ai" | "legacy" | "topup" = "legacy" as "ai" | "legacy" | "topup";
      let reasoningParts: string[] = [];

      // helper to get next window excluding already used handles
      function buildWindow(offset: number, used: Set<string>) {
        const windowSlice = sortedCandidates.slice(offset, offset + aiWindow);
        return windowSlice.filter(c => !used.has(c.handle));
      }

      // PASS 1 (first window)
      let used = new Set<string>();
      let offset = 0;

      // Bundle AI tracking variables (declared here to be accessible for top-up logic)
      let bundleAiSucceeded = false;
      let parseFailReason: string | undefined = undefined;
      let bundleFinalHandles: string[] = []; // Store AI results for top-up check
      let aiItemIndexMap: Map<string, number> | undefined = undefined; // Store AI itemIndex mapping for validation

      // Bundle handling: use AI bundle ranking
      if (isBundleMode && bundleIntent.items.length >= 2) {
        console.log("[Bundle] Using AI bundle ranking");
        
        // Small-first approach: take top MAX_BUNDLE_AI_PER_ITEM (15) per item for first AI attempt
        // itemGatedPools contains BM25-ranked candidates per item (already sorted by score)
        // On retry, use same small window (do not expand)
        const bundleCandidatesForAI: any[] = [];
        const itemCounts = new Map<number, number>(); // Track counts per item for logging
        
        for (const pool of itemGatedPools) {
          // Take only top MAX_BUNDLE_AI_PER_ITEM (15) from each item's ranked list for small-first
          const aiCandidatesForItem = pool.candidates.slice(0, MAX_BUNDLE_AI_PER_ITEM);
          itemCounts.set(pool.itemIndex, aiCandidatesForItem.length);
          
          // Add with metadata
          for (const c of aiCandidatesForItem) {
            bundleCandidatesForAI.push({
              ...c,
              _bundleItemIndex: pool.itemIndex,
              _bundleHardTerms: pool.hardTerms,
            });
          }
        }
        
        // Log bundle AI window with per-item counts (industry-agnostic)
        // Build per-item type counts dynamically from hardTerms
        const itemTypeCounts: Record<string, number> = {};
        
        for (const pool of itemGatedPools) {
          const count = itemCounts.get(pool.itemIndex) || 0;
          const firstTerm = (pool.hardTerms[0] || "").toLowerCase();
          // Use first term as key (industry-agnostic - works for any product type)
          if (firstTerm) {
            itemTypeCounts[firstTerm] = count;
          }
        }
        
        // Log AI window used (small-first approach) - industry-agnostic
        console.log("[Perf] ai_window_used", {
          flow: "bundle",
          perItem: MAX_BUNDLE_AI_PER_ITEM,
          itemTypeCounts, // Dynamic per-item counts (industry-agnostic)
          total: bundleCandidatesForAI.length,
        });
        
        console.log("[Bundle] aiCandidatesSent=", bundleCandidatesForAI.length);
        
        // Fetch descriptions only for AI candidate window
        if (bundleCandidatesForAI.length > 0 && accessToken) {
          console.log("[App Proxy] [Layer 1] Fetching descriptions for", bundleCandidatesForAI.length, "bundle AI candidates");
          const aiHandles = bundleCandidatesForAI.map(c => c.handle);
          const descriptionMap = await fetchShopifyProductDescriptionsByHandles({
            shopDomain,
            accessToken,
            handles: aiHandles,
          });
          
          // Enrich AI candidates with descriptions
          for (const candidate of bundleCandidatesForAI) {
            const description = descriptionMap.get(candidate.handle) || null;
            const descPlain = cleanDescription(description);
            const desc1000 = descPlain.substring(0, 1000);
            
            // Update candidate with description data
            candidate.description = description;
            candidate.descPlain = descPlain;
            candidate.desc1000 = desc1000;
            
            // Rebuild searchText with description
            candidate.searchText = buildSearchText({
              title: candidate.title,
              productType: candidate.productType,
              vendor: candidate.vendor,
              tags: candidate.tags,
              optionValues: candidate.optionValues,
              sizes: candidate.sizes,
              colors: candidate.colors,
              materials: candidate.materials,
              desc1000: desc1000,
            });
          }
          console.log("[App Proxy] [Layer 1] Enriched", bundleCandidatesForAI.length, "bundle candidates with descriptions");
        }
        
        // Convert hardFacets to array format for AI prompt
        const hardFacetsForAI: { size?: string[]; color?: string[]; material?: string[] } = {};
        if (hardFacets.size) hardFacetsForAI.size = [hardFacets.size];
        if (hardFacets.color) hardFacetsForAI.color = [hardFacets.color];
        if (hardFacets.material) hardFacetsForAI.material = [hardFacets.material];
        
        // Track whether AI returned valid parsed structured output
        // Variables already declared above for top-up access
        bundleAiSucceeded = false;
        parseFailReason = undefined;
        bundleFinalHandles = [];
        
        // Measure aiMs ONLY around the actual AI call
        const aiStartBundle = performance.now();
        try {
          aiCallCount++; // Track AI call
          const aiBundle = await rankProductsWithAI(
            userIntent,
            bundleCandidatesForAI,
            targetCount,
            shop.id,
            sessionToken,
            variantConstraints2,
            variantPreferences,
            includeTerms,
            avoidTerms,
            {
              hardTerms,
              hardFacets: Object.keys(hardFacetsForAI).length > 0 ? hardFacetsForAI : undefined,
              avoidTerms,
              trustFallback,
              isBundle: true,
              bundleItems: bundleItemsWithBudget.map(item => ({
                hardTerms: item.hardTerms,
                quantity: item.quantity,
                budgetMax: item.budgetMax,
              })),
            },
            experienceIdUsed,
            undefined, // strictGateCount
            undefined, // strictGateCandidates
            conversationMessages // Pass conversation context
          );
          // Measure aiMs immediately after AI call completes
          aiMs += Math.round(performance.now() - aiStartBundle);
          
          // Check if AI succeeded: valid parsed structured output with handles
          if (aiBundle.selectedHandles?.length) {
            // Use explicit source metadata to determine if AI succeeded
            bundleAiSucceeded = aiBundle.source === "ai";
            if (aiBundle.source === "fallback") {
              console.log("[AI Ranking] source=fallback parse_fail_reason=", aiBundle.parseFailReason || "unknown");
            }
            
            // SINGLE SOURCE OF TRUTH: If AI bundle ranking succeeded, use its handles directly
            // AI has already done budget-aware selection (primaries + alternatives) in ai-ranking.server.ts
            // DO NOT overwrite with legacy selectBundleWithinBudget() - it uses incorrect budget semantics
            if (bundleAiSucceeded && aiBundle.selectedHandles.length > 0) {
              console.log(`[Bundle] ✅ AI bundle succeeded with ${aiBundle.selectedHandles.length} handles - using AI result directly (skipping legacy selection)`);
              finalHandles = aiBundle.selectedHandles.slice(0, finalResultCount);
              finalSource = "ai";
              bundleFinalHandles = finalHandles; // Store for top-up check
              if (aiBundle.trustFallback) {
                trustFallback = true;
              }
              
              // Store AI itemIndex mapping for validation (use AI's mapping, not inferred)
              aiItemIndexMap = new Map<string, number>();
              if (aiBundle.bundleSelections) {
                for (const sel of aiBundle.bundleSelections) {
                  aiItemIndexMap.set(sel.handle, sel.itemIndex);
                }
                console.log(`[Bundle] AI itemIndex mapping: ${aiBundle.bundleSelections.length} handles mapped to ${new Set(aiBundle.bundleSelections.map((s: { itemIndex: number; handle: string }) => s.itemIndex)).size} items`);
              }
              
              // Log AI result (budget already checked in ai-ranking.server.ts)
              console.log(`[Bundle] AI result: ${finalHandles.length} handles, trustFallback=${aiBundle.trustFallback}, finalSource=${finalSource}`);
              
              // Hard guard: prevent empty handles when AI succeeded
              if (finalSource === "ai" && finalHandles.length === 0) {
                console.warn("[Bundle] ERROR: AI source but finalHandles empty - aborting to prevent empty diversity");
                // This should never happen, but if it does, we need to investigate
              }
              
              // Build reasoning from AI
              let reasoningText = "";
              if (aiBundle.reasoning && aiBundle.reasoning.trim()) {
                reasoningText = aiBundle.reasoning.trim();
              } else {
                // Fallback reasoning
                const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
                reasoningText = `Built a bundle: ${itemNames}.`;
              }
              
              // Add delivered vs requested count to reasoning (will be finalized after top-up)
              const deliveredAfterAI = finalHandles.length;
              if (deliveredAfterAI < finalResultCount) {
                reasoningText += ` Showing ${deliveredAfterAI} results (requested ${finalResultCount}).`;
              }
              
              reasoningParts.push(reasoningText);
              
              // Skip legacy selection - AI result is the single source of truth
              // Continue to top-up/diversity/validation with AI handles
            } else {
              // AI returned handles but source=fallback or trustFallback=true - use legacy as fallback
              console.log(`[Bundle] ⚠️  AI returned ${aiBundle.selectedHandles.length} handles but source=${aiBundle.source}, using legacy selection as fallback`);
              
            // Build item pools from sortedCandidates
            const itemPools = new Map<number, EnrichedCandidate[]>();
            for (const c of sortedCandidates) {
              const itemIdx = (c as any)._bundleItemIndex;
              if (typeof itemIdx === "number") {
                if (!itemPools.has(itemIdx)) {
                  itemPools.set(itemIdx, []);
                }
                itemPools.get(itemIdx)!.push(c);
              }
            }
            
            // Build ranked candidates by itemIndex from AI handles
            const rankedCandidatesByItem = new Map<number, EnrichedCandidate[]>();
            for (const handle of aiBundle.selectedHandles) {
              const candidate = sortedCandidates.find(c => c.handle === handle);
              if (candidate) {
                const itemIdx = (candidate as any)._bundleItemIndex;
                if (typeof itemIdx === "number") {
                  if (!rankedCandidatesByItem.has(itemIdx)) {
                    rankedCandidatesByItem.set(itemIdx, []);
                  }
                  rankedCandidatesByItem.get(itemIdx)!.push(candidate);
                }
              }
            }
            
            // Build allocated budgets map
            const allocatedBudgets = new Map<number, number>();
            bundleItemsWithBudget.forEach((item, idx) => {
              if (item.budgetMax !== undefined && item.budgetMax !== null) {
                allocatedBudgets.set(idx, item.budgetMax);
              }
            });
            
              // Use budget-aware selection helper (legacy fallback only)
            const selectionResult = selectBundleWithinBudget(
              itemPools,
              allocatedBudgets,
              bundleIntent.totalBudget,
              finalResultCount,
              bundleItemsWithBudget.length,
                rankedCandidatesByItem,
                slotPlan
            );
            
              // Only set if not already set by AI (guard against overwriting)
              if (finalSource !== "ai") {
            finalHandles = selectionResult.handles;
                finalSource = "legacy";
              }
            bundleFinalHandles = finalHandles; // Store for top-up check
            if (selectionResult.trustFallback) {
              trustFallback = true;
            }
            
              // Log budget selection details (legacy fallback)
            const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
              .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
              console.log("[Bundle Budget] [LEGACY FALLBACK] chosenPrimaries", chosenPrimariesText);
              console.log("[Bundle Budget] [LEGACY FALLBACK] totalBudget=" + (bundleIntent.totalBudget !== null ? bundleIntent.totalBudget : "null") + 
              " finalTotalPrice=" + selectionResult.totalPrice.toFixed(2) + 
              " finalCount=" + finalHandles.length + 
              " trustFallback=" + selectionResult.trustFallback +
              " budgetExceeded=" + (selectionResult.budgetExceeded === null ? "null" : String(selectionResult.budgetExceeded)));
            
              // Build reasoning for legacy fallback
            let reasoningText = "";
            if (aiBundle.reasoning && aiBundle.reasoning.trim()) {
              reasoningText = aiBundle.reasoning.trim();
            } else {
              const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
                reasoningText = `Built a bundle: ${itemNames}.`;
              }
              
            const deliveredAfterAI = finalHandles.length;
            if (deliveredAfterAI < finalResultCount) {
              reasoningText += ` Showing ${deliveredAfterAI} results (requested ${finalResultCount}).`;
            }
            
            reasoningParts.push(reasoningText);
              console.log("[Bundle] [LEGACY FALLBACK] selected", finalHandles.length, "handles across", bundleItemsWithBudget.length, "items");
            }
          } else {
            // Fallback to deterministic selection if AI fails (no handles returned)
            bundleAiSucceeded = false;
            parseFailReason = "AI returned empty handles";
            console.log("[Bundle] Deterministic fallback selected (AI returned empty handles)");
            
            // Build item pools from itemGatedPools (ensures all items are represented)
            // CRITICAL: Use itemGatedPools instead of sortedCandidates to ensure all item types have candidates
            const itemPools = new Map<number, EnrichedCandidate[]>();
            
            // First, build from itemGatedPools (this ensures all items have pools)
            for (const pool of itemGatedPools) {
              if (!itemPools.has(pool.itemIndex)) {
                itemPools.set(pool.itemIndex, []);
              }
              // Add candidates from this item's gated pool
              itemPools.get(pool.itemIndex)!.push(...pool.candidates);
            }
            
            // Also add any candidates from sortedCandidates that might have been enriched
            // This ensures we have the latest enriched data (descriptions, etc.)
            for (const c of sortedCandidates) {
              const itemIdx = (c as any)._bundleItemIndex;
              if (typeof itemIdx === "number") {
                const pool = itemPools.get(itemIdx) || [];
                // Only add if not already in pool (avoid duplicates)
                if (!pool.some(existing => existing.handle === c.handle)) {
                  pool.push(c);
                  itemPools.set(itemIdx, pool);
                }
              }
            }
            
            // Log pool sizes for debugging
            console.log("[Bundle] Fallback item pools", Array.from(itemPools.entries()).map(([idx, pool]) => ({
              itemIndex: idx,
              poolSize: pool.length,
              itemType: bundleItemsWithBudget[idx]?.hardTerms[0] || "unknown"
            })));
            
            // Build allocated budgets map
            const allocatedBudgets = new Map<number, number>();
            bundleItemsWithBudget.forEach((item, idx) => {
              if (item.budgetMax !== undefined && item.budgetMax !== null) {
                allocatedBudgets.set(idx, item.budgetMax);
              }
            });
            
            // Use budget-aware selection helper (no rankedCandidatesByItem for deterministic)
            const selectionResult = selectBundleWithinBudget(
              itemPools,
              allocatedBudgets,
              bundleIntent.totalBudget,
              finalResultCount,
              bundleItemsWithBudget.length,
              undefined, // No rankedCandidatesByItem for deterministic fallback
              slotPlan
            );
            
            // Only set if not already set by AI (guard against overwriting)
            if (finalSource !== "ai") {
            finalHandles = selectionResult.handles;
              finalSource = "legacy";
            }
            bundleFinalHandles = finalHandles; // Store for top-up check
            if (selectionResult.trustFallback) {
              trustFallback = true;
            }
            
            // Log budget selection details
            const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
              .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
            console.log("[Bundle Budget] chosenPrimaries", chosenPrimariesText);
            console.log("[Bundle Budget] totalBudget=" + (bundleIntent.totalBudget !== null ? bundleIntent.totalBudget : "null") + 
              " finalTotalPrice=" + selectionResult.totalPrice.toFixed(2) + 
              " finalCount=" + finalHandles.length + 
              " trustFallback=" + selectionResult.trustFallback +
              " budgetExceeded=" + (selectionResult.budgetExceeded === null ? "null" : String(selectionResult.budgetExceeded)));
            
            const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
            const budgetText = (bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number") ? ` under $${bundleIntent.totalBudget}` : "";
            
            // Build improved reasoning
            let reasoningText = `Built a bundle: ${itemNames}${budgetText}.`;
            if (bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number" && 
                (selectionResult.budgetExceeded === true || selectionResult.totalPrice > bundleIntent.totalBudget)) {
              reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options.`;
            }
            
            reasoningParts.push(reasoningText);
          }
          // aiMs already measured above, do not increment again
        } catch (error) {
          console.error("[Bundle] AI ranking error:", error);
          // Measure aiMs for failed AI call
          aiMs += Math.round(performance.now() - aiStartBundle);
          bundleAiSucceeded = false;
          parseFailReason = error instanceof Error ? error.message : String(error);
          // Fallback to deterministic selection with budget-aware helper
          const itemPools = new Map<number, EnrichedCandidate[]>();
          for (const c of sortedCandidates) {
            const itemIdx = (c as any)._bundleItemIndex;
            if (typeof itemIdx === "number") {
              if (!itemPools.has(itemIdx)) {
                itemPools.set(itemIdx, []);
              }
              itemPools.get(itemIdx)!.push(c);
            }
          }
          
          // Build allocated budgets map
          const allocatedBudgets = new Map<number, number>();
          bundleItemsWithBudget.forEach((item, idx) => {
            if (item.budgetMax !== undefined && item.budgetMax !== null) {
              allocatedBudgets.set(idx, item.budgetMax);
            }
          });
          
          // Use budget-aware selection helper
          const selectionResult = selectBundleWithinBudget(
            itemPools,
            allocatedBudgets,
            bundleIntent.totalBudget,
            finalResultCount,
            bundleItemsWithBudget.length,
            undefined, // No rankedCandidatesByItem for this path
            slotPlan
          );
          
          // Only set if not already set by AI (guard against overwriting)
          if (finalSource !== "ai") {
          finalHandles = selectionResult.handles;
            finalSource = "legacy";
          }
          bundleFinalHandles = finalHandles; // Store for top-up check
          if (selectionResult.trustFallback) {
            trustFallback = true;
          }
          
          // Log budget selection details
          const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
            .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
          console.log("[Bundle Budget] chosenPrimaries", chosenPrimariesText);
            console.log("[Bundle Budget] totalBudget=" + (bundleIntent.totalBudget !== null ? bundleIntent.totalBudget : "null") + 
              " finalTotalPrice=" + selectionResult.totalPrice.toFixed(2) + 
              " finalCount=" + finalHandles.length + 
              " trustFallback=" + selectionResult.trustFallback +
              " budgetExceeded=" + (selectionResult.budgetExceeded === null ? "null" : String(selectionResult.budgetExceeded)));
          
          const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
            const budgetText = (bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number") ? ` under $${bundleIntent.totalBudget}` : "";
          
          // Build improved reasoning
          let reasoningText = `Built a bundle: ${itemNames}${budgetText}.`;
            if (bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number" && 
                (selectionResult.budgetExceeded === true || selectionResult.totalPrice > bundleIntent.totalBudget)) {
            reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options.`;
          }
          
          reasoningParts.push(reasoningText);
        }
        
        // Log final result with AI success/failure indication
        if (bundleAiSucceeded && finalHandles.length > 0) {
          console.log(`[Bundle] ✅ AI bundle result: ${finalHandles.length} handles across ${bundleItemsWithBudget.length} items (skipped legacy selection)`);
        } else if (finalHandles.length > 0) {
          const failReasonText = parseFailReason ? ` parse_fail_reason=${parseFailReason}` : "";
          console.log(`[Bundle] ⚠️  Fallback selected: ${finalHandles.length} handles across ${bundleItemsWithBudget.length} items${failReasonText}`);
        } else {
          console.log(`[Bundle] ❌ No handles selected - AI failed and fallback returned 0 handles`);
        }
        console.log("[Bundle] trustFallback=", trustFallback);
      } else {
        // SINGLE-ITEM PATH: Small-first approach - use SINGLE_ITEM_AI_WINDOW (20) for first attempt
        // On retry, use same small window (do not expand)
        const window1 = sortedCandidates.slice(0, SINGLE_ITEM_AI_WINDOW).filter(c => !used.has(c.handle));
        
        // Log AI window used (small-first approach)
        console.log("[Perf] ai_window_used", {
          flow: "single_item",
          windowSize: SINGLE_ITEM_AI_WINDOW,
          actualCount: window1.length,
        });
      
      // Fetch descriptions only for AI candidate window
      if (window1.length > 0 && accessToken) {
        console.log("[App Proxy] [Layer 1] Fetching descriptions for", window1.length, "AI candidates");
        const aiHandles = window1.map(c => c.handle);
        const descriptionMap = await fetchShopifyProductDescriptionsByHandles({
          shopDomain,
          accessToken,
          handles: aiHandles,
        });
        
        // Enrich AI candidates with descriptions
        for (const candidate of window1) {
          const description = descriptionMap.get(candidate.handle) || null;
          const descPlain = cleanDescription(description);
          const desc1000 = descPlain.substring(0, 1000);
          
          // Update candidate with description data
          candidate.description = description;
          candidate.descPlain = descPlain;
          candidate.desc1000 = desc1000;
          
          // Rebuild searchText with description
          candidate.searchText = buildSearchText({
            title: candidate.title,
            productType: candidate.productType,
            vendor: candidate.vendor,
            tags: candidate.tags,
            optionValues: candidate.optionValues,
            sizes: candidate.sizes,
            colors: candidate.colors,
            materials: candidate.materials,
            desc1000: desc1000,
          });
        }
        console.log("[App Proxy] [Layer 1] Enriched", window1.length, "candidates with descriptions");
      }
      
      // Convert hardFacets to array format for AI prompt
      const hardFacetsForAI: { size?: string[]; color?: string[]; material?: string[] } = {};
      if (hardFacets.size) hardFacetsForAI.size = [hardFacets.size];
      if (hardFacets.color) hardFacetsForAI.color = [hardFacets.color];
      if (hardFacets.material) hardFacetsForAI.material = [hardFacets.material];
      
      // Measure aiMs ONLY around the actual AI call
      const aiStartSingle = performance.now();
      try {
        aiCallCount++; // Track AI call
      const ai1 = await rankProductsWithAI(
            userIntent,
            window1,
            targetCount,
            shop.id,
            sessionToken,
            variantConstraints2,
            variantPreferences,
            includeTerms,
            avoidTerms,
            {
              hardTerms,
              hardFacets: Object.keys(hardFacetsForAI).length > 0 ? hardFacetsForAI : undefined,
              avoidTerms,
              trustFallback,
              ...(isBundleMode ? {
                isBundle: true,
                bundleItems: bundleItemsWithBudget.map(item => ({
                  hardTerms: item.hardTerms,
                  quantity: item.quantity,
                  budgetMax: item.budgetMax,
                })),
              } : {}),
            },
            experienceIdUsed,
            strictGateCount,
            strictGateCandidates,
            conversationMessages // Pass conversation context
          );
        // Measure aiMs immediately after AI call completes
        aiMs += Math.round(performance.now() - aiStartSingle);

      if (ai1.selectedHandles?.length) {
        // Log source metadata
        if (ai1.source === "ai") {
          console.log("[AI Ranking] source=ai trustFallback=", ai1.trustFallback);
        } else {
          console.log("[AI Ranking] source=fallback parse_fail_reason=", ai1.parseFailReason || "unknown");
        }
        
        // Filter cached handles against current product availability
        // This ensures out-of-stock products from cache are excluded
        const validHandles = ai1.selectedHandles.filter((handle: string) => {
          const candidate = sortedCandidates.find(c => c.handle === handle);
          if (!candidate) {
            console.log("[App Proxy] Cached handle not found in current candidates:", handle);
            return false; // Product no longer exists or was filtered out
          }
          // If inStockOnly is enabled, filter out unavailable products
          if (experience.inStockOnly && !candidate.available) {
            console.log("[App Proxy] Cached handle is out of stock, excluding:", handle);
            return false;
          }
          return true;
        });
        
        for (const h of validHandles) used.add(h);
        finalHandles = [...validHandles];
        if (ai1.reasoning) {
        reasoningParts.push(ai1.reasoning);
        }
        
        // Log if any cached handles were filtered out
        if (validHandles.length < ai1.selectedHandles.length) {
          const filteredCount = ai1.selectedHandles.length - validHandles.length;
          console.log(`[App Proxy] Filtered ${filteredCount} out-of-stock/unavailable products from cache`);
        }
        
        // ============================================
        // COVERAGE GUARDRAIL (for collection intent - uses canonical family keys)
        // ============================================
        if (collectionIntent && !bundleIntent.isBundle && finalHandles.length > 0) {
          // Reconstruct chosen families using the same logic as window selection (with canonicalization)
          const candidatesWithFamilies = rankedCandidates.map(r => {
            const familyInfo = deriveFamilyKey(r.candidate);
            const rawKey = familyInfo.key;
            const canonicalKey = canonicalizeGroupKey(rawKey);
            return {
              candidate: r.candidate,
              score: r.score,
              familyKey: canonicalKey // Use canonical key
            };
          });
          
          // Build family stats using canonical keys (already canonicalized in candidatesWithFamilies)
          // Since candidatesWithFamilies already has canonical keys, we can directly build stats
          const canonicalFamilyStats = new Map<string, { count: number; topBM25: number }>();
          candidatesWithFamilies.forEach(c => {
            const canonicalKey = c.familyKey; // Already canonical
            const existing = canonicalFamilyStats.get(canonicalKey);
            if (!existing || c.score > existing.topBM25) {
              canonicalFamilyStats.set(canonicalKey, {
                count: (existing?.count || 0) + 1,
                topBM25: c.score
              });
            } else {
              canonicalFamilyStats.set(canonicalKey, {
                ...existing,
                count: existing.count + 1
              });
            }
          });
          
          // Rank families by top BM25, then count (same as window selection)
          const rankedFamilies = Array.from(canonicalFamilyStats.entries())
            .map(([key, stats]) => ({ key, count: stats.count, topBM25: stats.topBM25 }))
            .sort((a, b) => {
              if (Math.abs(b.topBM25 - a.topBM25) > 0.01) {
                return b.topBM25 - a.topBM25;
              }
              return b.count - a.count;
            });
          
          // Pick distinct families (same as window selection)
          const candidatePool = rankedFamilies;
          const chosenFamilies: Array<{ key: string; count: number; topBM25: number }> = [];
          
          for (const family of candidatePool) {
            if (chosenFamilies.length >= 4) break;
            const isSimilar = chosenFamilies.some(chosen => 
              chosen.key.includes(family.key) || family.key.includes(chosen.key)
            );
            if (!isSimilar) {
              chosenFamilies.push({ key: family.key, count: family.count, topBM25: family.topBM25 });
            }
          }
          
          if (chosenFamilies.length < 2) {
            const allFamilies = rankedFamilies.slice(0, 2 - chosenFamilies.length);
            chosenFamilies.push(...allFamilies.map(f => ({ key: f.key, count: f.count, topBM25: f.topBM25 })));
          }
          
          const chosenFamilyKeys = chosenFamilies.map(f => f.key);
          
          // Check which families are represented in finalHandles (use canonical keys)
          const coverageBefore: Record<string, number> = {};
          finalHandles.forEach(handle => {
            const candidate = sortedCandidates.find(c => c.handle === handle);
            if (candidate) {
              const familyInfo = deriveFamilyKey(candidate);
              const canonicalKey = canonicalizeGroupKey(familyInfo.key);
              coverageBefore[canonicalKey] = (coverageBefore[canonicalKey] || 0) + 1;
            }
          });
          
          // Find missing families
          const missingFamilies = chosenFamilyKeys.filter(familyKey => !coverageBefore[familyKey] || coverageBefore[familyKey] === 0);
          
          if (missingFamilies.length > 0) {
            console.log(`[CollectionIntent] coverage_before=${JSON.stringify(coverageBefore)} missingFamilies=[${missingFamilies.join(", ")}]`);
            
            // Refill missing families by pulling best unused candidates from those families
            let swaps = 0;
            const finalHandlesSet = new Set(finalHandles);
            
            for (const missingFamily of missingFamilies) {
              // Find best unused candidate from this family
              const familyCandidates = candidatesWithFamilies
                .filter(c => c.familyKey === missingFamily && !finalHandlesSet.has(c.candidate.handle))
                .sort((a, b) => b.score - a.score);
              
              if (familyCandidates.length > 0) {
                // Find weakest item in finalHandles to swap out (lowest BM25 score)
                const finalWithScores = finalHandles.map(handle => {
                  const candidate = candidatesWithFamilies.find(c => c.candidate.handle === handle);
                  return { handle, score: candidate?.score || 0 };
                }).sort((a, b) => a.score - b.score);
                
                if (finalWithScores.length > 0) {
                  // Swap out weakest item
                  const weakestHandle = finalWithScores[0].handle;
                  const newHandle = familyCandidates[0].candidate.handle;
                  
                  const weakestIdx = finalHandles.indexOf(weakestHandle);
                  if (weakestIdx >= 0) {
                    finalHandles[weakestIdx] = newHandle;
                    finalHandlesSet.delete(weakestHandle);
                    finalHandlesSet.add(newHandle);
                    swaps++;
                    console.log(`[CollectionIntent] coverage_swap family=${missingFamily} removed=${weakestHandle} added=${newHandle}`);
                  }
                }
              }
            }
            
            // Log coverage after
            const coverageAfter: Record<string, number> = {};
            finalHandles.forEach(handle => {
              const candidate = sortedCandidates.find(c => c.handle === handle);
              if (candidate) {
                const familyInfo = deriveFamilyKey(candidate);
                coverageAfter[familyInfo.key] = (coverageAfter[familyInfo.key] || 0) + 1;
              }
            });
            
            console.log(`[CollectionIntent] coverage_after=${JSON.stringify(coverageAfter)} swaps=${swaps}`);
          } else {
            console.log(`[CollectionIntent] coverage_before=${JSON.stringify(coverageBefore)} all_families_represented=true`);
          }
        }
      } else {
        // if AI fails completely, we will fallback at the end
        // But if no-hard-terms and gatedPool>0, use deterministic now
        if (hardTerms.length === 0 && gatedCandidates.length > 0) {
          console.log("[App Proxy] No-hard-terms: AI returned empty, using deterministic ranking from gated pool");
          finalHandles = fallbackRanking(window1, targetCount);
          reasoningParts.push("Products selected using relevance ranking.");
        } else {
        reasoningParts.push("Products selected using default ranking.");
        }
      }
      
      // No-hard-terms validation: if selected empty AND gatedPool>0 AFTER AI call, fall back to deterministic
      if (hardTerms.length === 0 && finalHandles.length === 0 && gatedCandidates.length > 0) {
        console.log("[App Proxy] No-hard-terms: AI returned empty but gatedPool>0, falling back to deterministic ranking");
        finalHandles = fallbackRanking(gatedCandidates.slice(0, aiWindow), targetCount);
        reasoningParts.push("Products selected using relevance ranking.");
        }
      } catch (error) {
        console.error("[App Proxy] AI ranking error:", error);
        // Measure aiMs for failed AI call
        aiMs += Math.round(performance.now() - aiStartSingle);
        // Fallback to deterministic ranking
        if (hardTerms.length === 0 && gatedCandidates.length > 0) {
          console.log("[App Proxy] No-hard-terms: AI failed, using deterministic ranking from gated pool");
          finalHandles = fallbackRanking(window1, targetCount);
          reasoningParts.push("Products selected using relevance ranking.");
        } else {
          reasoningParts.push("Products selected using default ranking.");
        }
      }

      // TOP-UP PASSES (deterministic selection from pre-ranked candidates)
      // Only perform top-up if AI succeeded AND we need more results
      if (!isBundleMode) {
        // Only top-up if AI succeeded (has handles) AND we need more
        const aiSucceeded = finalHandles.length > 0;
        if (aiSucceeded && finalHandles.length < targetCount) {
          // Select remaining products deterministically from sortedCandidates (already BM25-ranked)
          while (finalHandles.length < targetCount) {
        // Get next candidates from sorted list (already ranked by BM25 + boosts)
        const remainingCandidates = sortedCandidates.filter(c => !used.has(c.handle));
        
        if (remainingCandidates.length === 0) break;
        
        const missing = targetCount - finalHandles.length;
        const toAdd = remainingCandidates.slice(0, missing);
        
        for (const candidate of toAdd) {
          if (!used.has(candidate.handle) && finalHandles.length < targetCount) {
            // Validate availability if inStockOnly is enabled
            if (experience.inStockOnly && !candidate.available) continue;
            
            used.add(candidate.handle);
            finalHandles.push(candidate.handle);
          }
        }
        
        if (toAdd.length > 0) {
            reasoningParts.push("Expanded search to find additional close matches.");
        } else {
          // No more valid candidates available
          break;
          }
      }
        } // End of top-up condition check (closes if (aiSucceeded && ...))
      } else if (isBundleMode) {
        // Bundle mode: Only top-up if AI succeeded AND we need more results
        // Check if AI succeeded (has handles from AI selection)
        const bundleAiHadResults = bundleFinalHandles.length > 0 || (bundleAiSucceeded && finalHandles.length > 0);
        if (bundleAiHadResults && finalHandles.length < finalResultCount) {
        // BUNDLE-SAFE TOP-UP: Only from bundle item pools
        console.log("[Bundle] Top-up needed: have", finalHandles.length, "need", finalResultCount);
        
        // Build itemPools STRICTLY: only candidates that match that item's hard term(s) using word-boundary matching
        const bundleItemPools = new Map<number, EnrichedCandidate[]>();
        for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
          const bundleItem = bundleItemsWithBudget[itemIdx];
          const itemHardTerms = bundleItem.hardTerms;
          
          // Filter sortedCandidates to only those that match this item's hard terms
          const itemPool: EnrichedCandidate[] = [];
          for (const c of sortedCandidates) {
            const haystack = [
              c.title || "",
              c.productType || "",
              (c.tags || []).join(" "),
              c.vendor || "",
              c.searchText || "",
            ].join(" ");
            
            const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (hasItemMatch) {
              itemPool.push(c);
            }
          }
          
          bundleItemPools.set(itemIdx, itemPool);
        }
        
        // Count current handles per item
        const handlesByItem = new Map<number, string[]>();
        const usedSet = new Set(finalHandles);
        
        for (const handle of finalHandles) {
          const candidate = sortedCandidates.find(c => c.handle === handle);
          if (candidate) {
            const itemIdx = (candidate as any)._bundleItemIndex;
            if (typeof itemIdx === "number") {
              if (!handlesByItem.has(itemIdx)) {
                handlesByItem.set(itemIdx, []);
              }
              handlesByItem.get(itemIdx)!.push(handle);
            }
          }
        }
        
        // Calculate target distribution (roughly even)
        const targetPerItem = Math.ceil(finalResultCount / bundleItemsWithBudget.length);
        const topUpSourceCounts = new Map<number, number>();
        
        // Round-robin top-up from bundle item pools
        const itemIndices = Array.from({ length: bundleItemsWithBudget.length }, (_, i) => i);
        let roundRobinIdx = 0;
        const rejectedTopUpHandles: string[] = [];
        
        while (finalHandles.length < finalResultCount && roundRobinIdx < 200) { // Safety limit
          const currentItemIdx = itemIndices[roundRobinIdx % itemIndices.length];
          const pool = bundleItemPools.get(currentItemIdx) || [];
          const currentHandles = handlesByItem.get(currentItemIdx) || [];
          
          // Check if this item needs more handles
          if (currentHandles.length < targetPerItem && pool.length > currentHandles.length) {
            // Find next candidate from this item's pool that's not already used
            for (const candidate of pool) {
              if (!usedSet.has(candidate.handle)) {
                // Category guard: verify candidate belongs to this item pool
                const haystack = [
                  candidate.title || "",
                  candidate.productType || "",
                  (candidate.tags || []).join(" "),
                  candidate.vendor || "",
                  candidate.searchText || "",
                ].join(" ");
                
                const itemHardTerms = bundleItemsWithBudget[currentItemIdx].hardTerms;
                const belongsToItem = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
                
                if (belongsToItem) {
                  finalHandles.push(candidate.handle);
                  usedSet.add(candidate.handle);
                  if (!handlesByItem.has(currentItemIdx)) {
                    handlesByItem.set(currentItemIdx, []);
                  }
                  handlesByItem.get(currentItemIdx)!.push(candidate.handle);
                  topUpSourceCounts.set(currentItemIdx, (topUpSourceCounts.get(currentItemIdx) || 0) + 1);
                  break;
                } else {
                  rejectedTopUpHandles.push(candidate.handle);
                }
              }
            }
          }
          
          roundRobinIdx++;
          if (roundRobinIdx > 200) break;
        }
        
        // Log top-up source counts
        const topUpSourceText = bundleItemsWithBudget.map((item, idx) => {
          const count = topUpSourceCounts.get(idx) || 0;
          const itemName = item.hardTerms[0];
          return `${itemName}=${count}`;
        }).join(" ");
        console.log("[Bundle] topUpSourceCounts:", topUpSourceText);
        
        if (rejectedTopUpHandles.length > 0) {
          console.log("[Bundle] rejectedTopUpHandles:", rejectedTopUpHandles.slice(0, 10).join(", "), rejectedTopUpHandles.length > 10 ? `... (${rejectedTopUpHandles.length} total)` : "");
        }
        } // End of bundle top-up condition check
      } // End of single-item path else block / bundle mode block

      // LAYER 3: Post-validation (validate final handles against hard constraints)
      console.log("[App Proxy] [Layer 3] Validating final handles");
      
      /**
       * Validate final handles against hard constraints (when trustFallback=false)
       * Industry-agnostic: uses new facet system with token fallback when structured facets are missing
       */
      async function validateFinalHandles(
        handles: string[],
        candidates: EnrichedCandidate[],
        hardTerms: string[],
        hardFacets: { size: string | null; color: string | null; material: string | null },
        trustFallback: boolean,
        degradedFacets?: Array<{ facet: string; value: string; coverage: number }>
      ): Promise<string[]> {
        if (trustFallback) {
          // Trust fallback: allow all handles
          return handles;
        }
        
        const validHandles: string[] = [];
        
        // Convert hardFacets to generic constraints using new facet system
        const { convertHardFacetsToConstraints, productSatisfiesConstraints } = await import("~/utils/facets.server");
        let facetConstraints = convertHardFacetsToConstraints(hardFacets);
        
        // Issue 1 fix: Exclude degraded facets from validation (they were moved to softTerms)
        if (degradedFacets && degradedFacets.length > 0) {
          const degradedFacetNames = new Set(degradedFacets.map(d => d.facet.toLowerCase()));
          const beforeCount = facetConstraints.length;
          facetConstraints = facetConstraints.filter(c => {
            const facetNameLower = c.key.toLowerCase();
            const isDegraded = degradedFacetNames.has(facetNameLower);
            if (isDegraded) {
              console.log(`[Validation] skipping_degraded_facet facet=${c.key} value=${c.value} coverage=${degradedFacets.find(d => d.facet.toLowerCase() === facetNameLower)?.coverage.toFixed(3)}`);
            }
            return !isDegraded;
          });
          const degradedList = Array.from(degradedFacetNames).join(",");
          console.log(`[Validation] degradedFacets applied=${degradedList} before=${beforeCount} after=${facetConstraints.length}`);
        }
        
        for (const handle of handles) {
          const candidate = candidates.find(c => c.handle === handle);
          if (!candidate) continue;
          
          // Check availability
          if (!candidate.available) continue;
          
          // Check constraints using new helper that accepts structured OR tag-derived facets
          let passesConstraints = true;
          if (facetConstraints.length > 0) {
            const constraintResult = await satisfiesConstraintsStructuredOrTags(candidate, facetConstraints, facetVocabularyForBundle);
            
            if (!constraintResult.ok) {
              passesConstraints = false;
              if (constraintResult.conflict) {
                console.log(`[Validation] rejected_due_to_conflicting_structured_facet facet=${constraintResult.conflict.facet} expected=${constraintResult.conflict.expected} actual=${constraintResult.conflict.actual} source=${constraintResult.conflict.source}`);
              }
            } else {
              passesConstraints = true;
            }
          }
          
          // Check hard terms (if any) using word-boundary matching on normalized haystack
          if (hardTerms.length > 0 && passesConstraints) {
            // Build normalized haystack: title + productType + tags.join(" ") + vendor + searchText
            const haystack = [
              candidate.title || "",
              candidate.productType || "",
              (candidate.tags || []).join(" "),
              candidate.vendor || "",
              candidate.searchText || "",
            ].join(" ");
            
            // Use word-boundary matching for all hard terms (not token matching)
            // CORRECT ORDER: matchesHardTermWithBoundary(haystackText, term) - haystack is the text to search in, term is what we're looking for
            const hasHardTermMatch = hardTerms.some(phrase => matchesHardTermWithBoundary(haystack, phrase));
            
            
            // Also check boost terms
            const hasBoostTerm = Array.from(boostTerms).some(term => matchesHardTermWithBoundary(haystack, term));
            
            if (!hasHardTermMatch && !hasBoostTerm) {
              passesConstraints = false;
            }
          }
          
          if (passesConstraints) {
            validHandles.push(handle);
          }
        }
        
        return validHandles;
      }
      
      // Log before validation (especially important for bundles)
      // Use finalHandles (which contains AI result) for logging, not finalHandlesGuaranteed (which is set after validation)
      if (isBundleMode) {
        console.log(`[Bundle] handles_before_validation count=${finalHandles.length} preview=[${finalHandles.slice(0, 5).join(", ")}${finalHandles.length > 5 ? "..." : ""}]`);
      }
      
      // BUG FIX #1: Separate validations with explicit names for bundle flow
      // (a) Handle existence validation (Shopify fetch by handle returns product)
      // (b) Constraint validation (availability/facets)
      // (c) Bundle-type validation (each requested type has >=1)
      let validatedHandles: string[];
      const candidateMap = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
      
      if (isBundleMode && !trustFallback) {
        // BUNDLE VALIDATION: Three separate validation stages
        
        // Helper function for robust bundle item matching
        // Accepts plural forms, prefers canonicalType, uses token-based or substring matching
        function matchesBundleItem(candidate: EnrichedCandidate, bundleItem: { hardTerms: string[]; canonicalType?: string }): boolean {
          const haystack = [
            candidate.title || "",
            candidate.productType || "",
            (candidate.tags || []).join(" "),
            candidate.vendor || "",
            candidate.searchText || "",
          ].join(" ");
          const normalizedHaystack = normalizeText(haystack);
          
          // Plural form mappings (singular <-> plural)
          const pluralForms: Record<string, string[]> = {
            "trouser": ["trousers", "trouser"],
            "trousers": ["trouser", "trousers"],
            "suit": ["suits", "suit"],
            "suits": ["suit", "suits"],
            "shirt": ["shirts", "shirt"],
            "shirts": ["shirt", "shirts"],
            "coat": ["coats", "coat"],
            "coats": ["coat", "coats"],
          };
          
          // Prefer matching by canonicalType if available
          if (bundleItem.canonicalType) {
            const normalizedCanonical = normalizeText(bundleItem.canonicalType);
            // Check exact match or substring match
            if (normalizedHaystack.includes(normalizedCanonical) || normalizedCanonical.includes(normalizedHaystack.split(/\s+/)[0])) {
              return true;
            }
            // Check plural forms
            const canonicalPlurals = pluralForms[normalizedCanonical] || [];
            for (const plural of canonicalPlurals) {
              if (normalizedHaystack.includes(normalizeText(plural))) {
                return true;
              }
            }
          }
          
          // Match any of the item hardTerms using token-based or substring matching
          for (const term of bundleItem.hardTerms) {
            const normalizedTerm = normalizeText(term);
            
            // Token-based matching: check if any token from term appears in haystack
            const termTokens = normalizedTerm.split(/\s+/).filter(t => t.length > 2); // Filter out short tokens
            if (termTokens.length > 0) {
              const allTokensMatch = termTokens.every(token => normalizedHaystack.includes(token));
              if (allTokensMatch) {
                return true;
              }
            }
            
            // Substring matching (not strict word-boundary only)
            if (normalizedHaystack.includes(normalizedTerm) || normalizedTerm.includes(normalizedHaystack.split(/\s+/)[0])) {
              return true;
            }
            
            // Check plural forms
            const termPlurals = pluralForms[normalizedTerm] || [];
            for (const plural of termPlurals) {
              if (normalizedHaystack.includes(normalizeText(plural))) {
                return true;
              }
            }
            
            // Fallback to word-boundary matching for single-word terms
            if (!normalizedTerm.includes(" ")) {
              const regex = new RegExp(`\\b${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
              if (regex.test(normalizedHaystack)) {
                return true;
              }
            }
          }
          
          return false;
        }
        
        // Helper function to score a candidate against a bundle item (for robust mapping)
        async function scoreCandidateForBundleItem(
          candidate: EnrichedCandidate,
          bundleItem: { hardTerms: string[]; constraints?: { optionConstraints?: { size?: string; color?: string; material?: string } } },
          itemIdx: number
        ): Promise<number> {
          const haystack = [
            candidate.title || "",
            candidate.productType || "",
            (candidate.tags || []).join(" "),
            candidate.vendor || "",
            candidate.handle || "",
            candidate.searchText || "",
          ].join(" ");
          const normalizedHaystack = normalizeText(haystack);
          
          let score = 0;
          
          // Score +10 for each hardTerm hit in combined text
          for (const term of bundleItem.hardTerms) {
            const normalizedTerm = normalizeText(term);
            if (normalizedHaystack.includes(normalizedTerm)) {
              score += 10;
            }
          }
          
          // Score +8 extra if productType indicates suit (contains suit/tux/blazer) when item hardTerms include "suit"
          const productTypeLower = (candidate.productType || "").toLowerCase();
          const hasSuitTerm = bundleItem.hardTerms.some(t => normalizeText(t).includes("suit"));
          if (hasSuitTerm && (productTypeLower.includes("suit") || productTypeLower.includes("tux") || productTypeLower.includes("blazer"))) {
            score += 8;
          }
          
          // Score +8 extra if productType indicates shirt (contains shirt/cuff/collar) when item hardTerms include "shirt"
          const hasShirtTerm = bundleItem.hardTerms.some(t => normalizeText(t).includes("shirt"));
          if (hasShirtTerm && (productTypeLower.includes("shirt") || productTypeLower.includes("cuff") || productTypeLower.includes("collar"))) {
            score += 8;
          }
          
          // Pre-check constraints: if item has optionConstraints, validate candidate passes them
          const itemOptionConstraints = bundleItem.constraints?.optionConstraints;
          if (itemOptionConstraints && (itemOptionConstraints.size || itemOptionConstraints.color || itemOptionConstraints.material)) {
            const itemGenericConstraints: Array<{ key: string; value: string }> = [];
            if (itemOptionConstraints.size) itemGenericConstraints.push({ key: "size", value: itemOptionConstraints.size });
            if (itemOptionConstraints.color) itemGenericConstraints.push({ key: "color", value: itemOptionConstraints.color });
            if (itemOptionConstraints.material) itemGenericConstraints.push({ key: "material", value: itemOptionConstraints.material });
            
            if (itemGenericConstraints.length > 0) {
              const constraintResult = await satisfiesConstraintsStructuredOrTags(candidate, itemGenericConstraints, facetVocabulary);
              if (!constraintResult.ok) {
                // Candidate fails constraints for this item - return invalid score
                return -1;
              }
            }
          }
          
          return score;
        }
        
        // (a) Handle existence validation: Check if handle exists in enriched candidates
        const handleExistenceValid = finalHandles.filter(handle => {
          return candidateMap.has(handle);
        });
        console.log(`[Bundle Validation] (a) handle_existence: ${handleExistenceValid.length} out of ${finalHandles.length} handles exist in candidates`);
        
        if (handleExistenceValid.length === 0) {
          console.warn(`[Bundle Validation] (a) handle_existence FAILED: 0 handles exist - treating as NO_MATCH (DO NOT bypass even if source=ai)`);
          validatedHandles = [];
        } else {
          // (b) Per-item constraint validation: Validate each handle against its item's merged constraints using satisfiesConstraintsStructuredOrTags()
          // Group handles by itemIndex using AI's mapping (if available) or scored assignment
          const handlesByItemIndex = new Map<number, string[]>();
          let assignedCount = 0;
          let unassignedCount = 0;
          
          for (const handle of handleExistenceValid) {
            // Use AI itemIndex mapping if available (preferred), otherwise use scored assignment
            let itemIdx: number | null = null;
            if (aiItemIndexMap && aiItemIndexMap.has(handle)) {
              itemIdx = aiItemIndexMap.get(handle)!;
              assignedCount++;
            } else {
              // Fallback: scored assignment to best matching bundle item
              const candidate = candidateMap.get(handle);
              if (candidate) {
                let bestScore = -1;
                let bestItemIdx: number | null = null;
                
                for (let idx = 0; idx < bundleIntent.items.length; idx++) {
                  const bundleItem = bundleIntent.items[idx];
                  const score = await scoreCandidateForBundleItem(candidate, bundleItem, idx);
                  
                  if (score > bestScore) {
                    bestScore = score;
                    bestItemIdx = idx;
                  }
                }
                
                if (bestItemIdx !== null && bestScore >= 0) {
                  itemIdx = bestItemIdx;
                  assignedCount++;
                } else {
                  unassignedCount++;
                  console.warn(`[BundleMapping] handle=${handle} could not be assigned to any itemIdx (all scores invalid or < 0)`);
                }
              } else {
                unassignedCount++;
              }
            }
            
            if (itemIdx !== null) {
              if (!handlesByItemIndex.has(itemIdx)) {
                handlesByItemIndex.set(itemIdx, []);
              }
              handlesByItemIndex.get(itemIdx)!.push(handle);
            }
          }
          
          console.log(`[BundleMapping] assigned=${assignedCount} unassigned=${unassignedCount} total=${handleExistenceValid.length}`);
          
          // First pass: Check if ANY item has constraints (size/color/material)
          let hasAnyConstraints = false;
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
            const bundleItem = bundleIntent.items[itemIdx];
            const itemOptionConstraints = bundleItem.constraints?.optionConstraints;
            if (itemOptionConstraints?.size || itemOptionConstraints?.color || itemOptionConstraints?.material) {
              hasAnyConstraints = true;
              break;
            }
          }
          
          // Validate per-item and remove invalid handles (conflicts)
          const validatedHandlesByItem = new Map<number, string[]>();
          const removedHandlesByItem = new Map<number, string[]>();
          let allCandidatesMissingFacets = true; // Track if ALL candidates are missing facets (for suspicious check)
          
          // REQUIREMENT 1: If hasAnyConstraints == false, skip constraint filtering entirely
          if (!hasAnyConstraints) {
            console.log(`[BundleValidation] skipped_constraints=true reason=no_constraints`);
            // Keep AI handles after existence + inStock checks only
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              const itemHandles = handlesByItemIndex.get(itemIdx) || [];
              const validHandlesForItem: string[] = [];
              
              for (const handle of itemHandles) {
            const candidate = candidateMap.get(handle);
            if (!candidate) continue;
            
                // Check availability only
                if (experience.inStockOnly && !candidate.available) {
                  continue;
                }
                
                // Valid - keep this handle
                validHandlesForItem.push(handle);
              }
              
              validatedHandlesByItem.set(itemIdx, validHandlesForItem);
              removedHandlesByItem.set(itemIdx, []);
            }
            
            // Combine validated handles from all items
            const constraintValid: string[] = [];
            for (const handles of validatedHandlesByItem.values()) {
              constraintValid.push(...handles);
            }
            validatedHandles = constraintValid;
            
            // Log per-item counts after validation
            const perItemCountsAfterValidation = Array.from(validatedHandlesByItem.entries()).map(([idx, handles]) => {
              return `item${idx}=${handles.length}`;
            }).join(" ");
            console.log(`[BundleValidation] per_item_after_validation ${perItemCountsAfterValidation} total=${validatedHandles.length}`);
            
            // Preserve aiItemIndexMap mapping for these handles
            // (aiItemIndexMap is already in scope from earlier)
          } else {
            // Constraints exist - run constraint validation
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              const bundleItem = bundleIntent.items[itemIdx];
              const itemHandles = handlesByItemIndex.get(itemIdx) || [];
              
              // Get merged per-item constraints (item-specific only in bundle mode, global + item-specific in non-bundle)
              const itemOptionConstraints = bundleItem.constraints?.optionConstraints;
              const itemGenericConstraints: Array<{ key: string; value: string }> = [];
              
              // Add item-specific constraints
              if (itemOptionConstraints?.size) {
                itemGenericConstraints.push({ key: "size", value: itemOptionConstraints.size });
              }
              if (itemOptionConstraints?.color) {
                itemGenericConstraints.push({ key: "color", value: itemOptionConstraints.color });
              }
              if (itemOptionConstraints?.material) {
                itemGenericConstraints.push({ key: "material", value: itemOptionConstraints.material });
              }
              
              // Add global hardFacets (if not overridden by item-specific) - ONLY in non-bundle mode
              // In bundle mode, do NOT merge global hardFacets to prevent over-constraint
              // Issue 1 fix: Exclude degraded facets from validation
              const degradedFacetNames = new Set(degradedFacetsForValidation.map(d => d.facet.toLowerCase()));
              if (!bundleIntent.isBundle) {
                if (hardFacets.size && !itemOptionConstraints?.size && !degradedFacetNames.has("size")) {
                  itemGenericConstraints.push({ key: "size", value: hardFacets.size });
                }
                if (hardFacets.color && !itemOptionConstraints?.color && !degradedFacetNames.has("color")) {
                  itemGenericConstraints.push({ key: "color", value: hardFacets.color });
                }
                if (hardFacets.material && !itemOptionConstraints?.material && !degradedFacetNames.has("material")) {
                  itemGenericConstraints.push({ key: "material", value: hardFacets.material });
                }
              }
              
              const validHandlesForItem: string[] = [];
              const removedHandlesForItem: string[] = [];
              
              // Check if any candidate has facets (structured or tags) - for suspicious detection
              let hasAnyFacets = false;
              for (const handle of itemHandles) {
                const candidate = candidateMap.get(handle);
                if (!candidate) continue;
                
                // Check availability first
            if (experience.inStockOnly && !candidate.available) {
                  removedHandlesForItem.push(handle);
                  continue;
                }
                
                // Check if candidate has any facets (structured or tags)
                const hasStructuredFacets = Array.isArray(candidate.variants) && candidate.variants.length > 0 &&
                  candidate.variants.some((v: any) => Array.isArray(v.selectedOptions) && v.selectedOptions.length > 0);
                const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
                const hasTagFacets = tags.some((tag: string) => 
                  typeof tag === "string" && (
                    tag.startsWith("cf-color-") ||
                    tag.startsWith("cf-size-") ||
                    tag.startsWith("cf-material-")
                  )
                );
                
                if (hasStructuredFacets || hasTagFacets) {
                  hasAnyFacets = true;
                }
                
                // Validate constraints using satisfiesConstraintsStructuredOrTags
                if (itemGenericConstraints.length > 0) {
                  const constraintResult = await satisfiesConstraintsStructuredOrTags(candidate, itemGenericConstraints, facetVocabulary);
                  if (!constraintResult.ok) {
                    // Invalid - remove this handle (conflict detected)
                    removedHandlesForItem.push(handle);
                    continue;
                  }
                }
                
                // Valid - keep this handle
                validHandlesForItem.push(handle);
              }
              
              // Update allCandidatesMissingFacets (only false if at least one item has facets)
              if (hasAnyFacets) {
                allCandidatesMissingFacets = false;
              }
              
              validatedHandlesByItem.set(itemIdx, validHandlesForItem);
              removedHandlesByItem.set(itemIdx, removedHandlesForItem);
              
              // Log per-item validation results
              console.log(`[BundleValidation] kept=${validHandlesForItem.length} removed=${removedHandlesForItem.length} itemIndex=${itemIdx}`);
            }
            
            // Combine validated handles from all items
            const constraintValid: string[] = [];
            for (const handles of validatedHandlesByItem.values()) {
              constraintValid.push(...handles);
            }
            
            // REQUIREMENT 2: If constraint validation returns 0, keep AI handles if source=ai
          if (constraintValid.length === 0) {
              if (finalSource === "ai" && handleExistenceValid.length > 0) {
                // Keep AI handles (existence + inStock filtered) - treat as suspicious
                console.warn(`[Bundle Validation] (b) constraint_validation FAILED: 0 handles pass constraints BUT source=ai - keeping AI handles (validation_suspicious=true)`);
                const aiHandlesKept = handleExistenceValid.filter(handle => {
                  const candidate = candidateMap.get(handle);
                  if (!candidate) return false;
                  if (experience.inStockOnly && !candidate.available) return false;
                  return true;
                });
                
                // Rebuild validatedHandlesByItem from kept AI handles using aiItemIndexMap
                const keptByItem = new Map<number, string[]>();
                for (const handle of aiHandlesKept) {
                  let itemIdx: number | null = null;
            if (aiItemIndexMap && 'has' in aiItemIndexMap) {
              const map = aiItemIndexMap as Map<string, number>;
              if (map.has(handle)) {
                itemIdx = map.get(handle)!;
              }
            } else {
              // Fallback: find itemIdx from handlesByItemIndex
              for (const [idx, handles] of handlesByItemIndex.entries()) {
                if (handles.includes(handle)) {
                  itemIdx = idx;
                  break;
                }
              }
            }
                  
                  if (itemIdx !== null) {
                    if (!keptByItem.has(itemIdx)) {
                      keptByItem.set(itemIdx, []);
                    }
                    keptByItem.get(itemIdx)!.push(handle);
                  }
                }
                
                validatedHandlesByItem.clear();
                for (const [idx, handles] of keptByItem.entries()) {
                  validatedHandlesByItem.set(idx, handles);
                }
                
                validatedHandles = aiHandlesKept;
                console.log(`[Bundle Validation] (b) constraint_validation: kept ${aiHandlesKept.length} AI handles (validation_suspicious=true)`);
              } else {
                // Not AI source - validation correctly filtered invalid handles
                console.warn(`[Bundle Validation] (b) constraint_validation: 0 handles pass constraints - removing invalid handles (NOT suspicious)`);
            validatedHandles = [];
              }
          } else {
              // Some handles passed - use them
              validatedHandles = constraintValid;
              
              // Check if any items need refill (missing handles after validation)
              const needsRefill = Array.from(validatedHandlesByItem.entries()).some(([idx, handles]) => handles.length === 0);
              
              if (needsRefill && finalSource === "ai") {
                  // Refill per-item from constraint-gated itemPools
                // Build itemPools from sortedCandidates with constraints (bundleItemPools may not be in scope here)
                const refillItemPools = new Map<number, EnrichedCandidate[]>();
                for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
                const bundleItem = bundleItemsWithBudget[itemIdx];
                const itemHardTerms = bundleItem.hardTerms;
                const itemOptionConstraints = bundleItem.constraints?.optionConstraints;
                const itemGenericConstraints: Array<{ key: string; value: string }> = [];
                
                if (itemOptionConstraints?.size) itemGenericConstraints.push({ key: "size", value: itemOptionConstraints.size });
                if (itemOptionConstraints?.color) itemGenericConstraints.push({ key: "color", value: itemOptionConstraints.color });
                if (itemOptionConstraints?.material) itemGenericConstraints.push({ key: "material", value: itemOptionConstraints.material });
                
                // In bundle mode, do NOT merge global hardFacets to prevent over-constraint
                if (!bundleIntent.isBundle) {
                  if (hardFacets.size && !itemOptionConstraints?.size) itemGenericConstraints.push({ key: "size", value: hardFacets.size });
                  if (hardFacets.color && !itemOptionConstraints?.color) itemGenericConstraints.push({ key: "color", value: hardFacets.color });
                  if (hardFacets.material && !itemOptionConstraints?.material) itemGenericConstraints.push({ key: "material", value: hardFacets.material });
                }
                
                const itemPool: EnrichedCandidate[] = [];
                for (const c of sortedCandidates) {
                const haystack = [
                    c.title || "",
                    c.productType || "",
                    (c.tags || []).join(" "),
                    c.vendor || "",
                    c.searchText || "",
                ].join(" ");
                
                const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
                  if (!hasItemMatch) continue;
                  
                  if (itemGenericConstraints.length > 0) {
                    const constraintResult = await satisfiesConstraintsStructuredOrTags(c, itemGenericConstraints, facetVocabulary);
                    if (!constraintResult.ok) continue;
                  }
                  
                  itemPool.push(c);
                }
                
                refillItemPools.set(itemIdx, itemPool);
              }
              
              // Refill each itemIndex independently from its constraint-gated itemPool
              const usedRefillHandles = new Set(constraintValid);
              const targetPerItem = Math.ceil(finalResultCount / bundleIntent.items.length);
              
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
                const currentValid = validatedHandlesByItem.get(itemIdx) || [];
                const needed = Math.max(0, targetPerItem - currentValid.length);
                
                // Fix: refill when currentValid.length === 0 (not just when removed.length > 0)
                // This handles mapping failures where removed=0 but currentValid=0
                if (needed > 0) {
                  // This item needs refill - get from its itemPool
                  const itemPool = refillItemPools.get(itemIdx) || [];
                  const refillCandidates = itemPool
                    .filter((c: EnrichedCandidate) => !usedRefillHandles.has(c.handle) && (experience.inStockOnly ? c.available : true))
                    .slice(0, needed);
                  
                  if (refillCandidates.length > 0) {
                    const refillHandles = refillCandidates.map((c: EnrichedCandidate) => c.handle);
                    constraintValid.push(...refillHandles);
                    refillHandles.forEach((h: string) => usedRefillHandles.add(h));
                    validatedHandlesByItem.set(itemIdx, [...currentValid, ...refillHandles]);
                    console.log(`[BundleRefill] itemIndex=${itemIdx} added=${refillHandles.length} reason=needed_${needed}_slots`);
                  } else {
                    console.log(`[BundleRefill] itemIndex=${itemIdx} added=0 reason=no_valid_candidates_in_pool`);
                  }
                }
                }
                
              validatedHandles = constraintValid;
            }
            }
          }
        }
      } else {
        // Single-item validation (non-bundle or trustFallback)
        validatedHandles = await validateFinalHandles(finalHandles, gatedCandidates, hardTerms, hardFacets, trustFallback, degradedFacetsForValidation);
        
        // Safety test log: confirm validation fix
        console.log(`[Validation] final_validated_count=${validatedHandles.length} from_ai_count=${finalHandles.length}`);
      }
      
      // BUG FIX #2: Log actual validated array (no later mutation)
      console.log("[App Proxy] [Layer 3] Validated handles (FINAL):", validatedHandles.length, "out of", finalHandles.length, "preview=", validatedHandles.slice(0, 5).join(", "));
      
      // Bundle mode: Do NOT use global fallback if validation returns 0 for an itemIndex
      // Instead, treat that itemIndex as NO_MATCH and return fewer results for that item
      // (Single-item mode can still use safe fallback)
      if (validatedHandles.length === 0 && finalHandles.length > 0 && !trustFallback && !isBundleMode) {
        // Safe fallback for single-item only: use gated pool instead of unsafe token matching
        const gatedPoolHandles = Array.from(new Set(
          gatedCandidates
            .filter(c => c.available !== false && c.handle)
            .slice(0, finalResultCount)
            .map(c => c.handle)
        ));
        
        if (gatedPoolHandles.length > 0) {
          validatedHandles = gatedPoolHandles;
          usedValidationFallback = true;
          console.log(`[Layer 3] Safe fallback from gated pool: ${validatedHandles.length} handles (validation returned 0)`);
        }
      }
      
      // Bundle mode: If validation returned 0 for an itemIndex, log it but don't use global fallback
      if (isBundleMode && validatedHandles.length === 0 && finalHandles.length > 0) {
        console.warn(`[Bundle Validation] Validation returned 0 handles - treating as NO_MATCH for affected items (NOT using global remaining_candidates)`);
      }
      
      // Bundle budget validation - ONLY when totalBudget is a number
      if (isBundleMode && bundleIntent.totalBudget !== null && typeof bundleIntent.totalBudget === "number") {
        const candidateMap = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
        const totalPrice = validatedHandles.reduce((sum, handle) => {
          const candidate = candidateMap.get(handle);
          if (candidate && candidate.price) {
            const price = parseFloat(String(candidate.price));
            return sum + (Number.isFinite(price) ? price : 0);
          }
          return sum;
        }, 0);
        
        if (totalPrice > bundleIntent.totalBudget) {
          trustFallback = true;
          relaxNotes.push(`Bundle total ($${totalPrice.toFixed(2)}) exceeds budget ($${bundleIntent.totalBudget}); showing closest matches.`);
          console.log("[Bundle] budget exceeded:", totalPrice, ">", bundleIntent.totalBudget, "trustFallback=", trustFallback);
        } else {
          console.log("[Bundle] budget check passed:", totalPrice, "<=", bundleIntent.totalBudget);
        }
      }
      
      // Top-up ONLY from gated pool (intent-safe)
      function uniq<T>(arr: T[]) {
        return Array.from(new Set(arr));
      }

      async function topUpHandlesFromGated(
        ranked: string[],
        pool: typeof allCandidates,
        target: number,
        constraints?: Array<{ key: string; value: string }>,
        facetVocabulary?: { optionNames: Set<string>; optionNameToValues: Map<string, Set<string>> }
      ) {
        const have = new Set(ranked);
        const out = ranked.slice();

        for (const p of pool) {
          if (out.length >= target) break;
          if (!p?.handle) continue;
          if (have.has(p.handle)) continue;
          
          // Check constraints if provided (single-item top-up must respect constraints)
          if (constraints && constraints.length > 0) {
            // Issue 1 fix: Filter out constraints for degraded facets
            const filteredConstraints = constraints.filter(c => {
              const facetNameLower = c.key.toLowerCase();
              const isDegraded = degradedFacetsMap.has(facetNameLower);
              return !isDegraded;
            });
            
            if (filteredConstraints.length > 0) {
              const constraintResult = await satisfiesConstraintsStructuredOrTags(p, filteredConstraints, facetVocabulary);
              if (!constraintResult.ok) {
                if (constraintResult.conflict) {
                  console.log(`[TopUp] skip_conflict facet=${constraintResult.conflict.facet} expected=${constraintResult.conflict.expected} actual=${constraintResult.conflict.actual} source=${constraintResult.conflict.source} handle=${p.handle}`);
                }
                continue; // Skip this candidate due to constraint conflict
              }
            }
          }
          
          have.add(p.handle);
          out.push(p.handle);
        }

        return out.slice(0, target);
      }

      // Hard guarantee: top-up after AI ranking (intent-safe enforcement)
      // Ensure validatedHandles is always an array to prevent errors
      // CRITICAL FIX: If validation filtered out all handles, use original finalHandles as fallback
      // This prevents 0 handles when validation is too strict (e.g., bundle item has 0 candidates)
      // BUG FIX #3: If validation returns 0 valid handles, treat as NO_MATCH OR rerun safe fallback
      // Never accept invalid handles - this prevents random products from being returned
      if (validatedHandles.length === 0 && finalHandles.length > 0) {
        console.warn(`[Layer 3] Validation filtered out all handles (${finalHandles.length} invalid) - treating as NO_MATCH or safe fallback`);
        
        // Try safe fallback: rerun validation with anchor token matching only (if we have hardTerms)
        // This is a last resort that still enforces some relevance
        if (hardTerms.length > 0) {
          const hardTermTokens = new Set<string>();
          hardTerms.forEach(term => {
            const normalized = unifiedNormalize(term);
            const tokens = tokenize(normalized);
            tokens.forEach(t => hardTermTokens.add(t));
          });
          
          // Build candidate map for lookup
          const candidateMapForCheck = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
          
          // Filter finalHandles to only those that match at least one anchor token
          const safeFallbackHandles: string[] = [];
          for (const handle of finalHandles) {
            const candidate = candidateMapForCheck.get(handle);
            if (candidate) {
              const haystack = unifiedNormalize(extractSearchText(candidate, indexMetafields));
              const candidateTokens = new Set(tokenize(haystack));
              const hasAnchorMatch = Array.from(hardTermTokens).some(token => candidateTokens.has(token));
              if (hasAnchorMatch) {
                safeFallbackHandles.push(handle);
              }
            }
          }
          
          if (safeFallbackHandles.length > 0) {
            console.log(`[Layer 3] Safe fallback found ${safeFallbackHandles.length} handles with anchor token matches`);
            finalHandlesGuaranteed = uniq(safeFallbackHandles);
          } else {
            // Even safe fallback failed - treat as NO_MATCH
            console.log(`[Layer 3] Safe fallback also returned 0 handles - treating as NO_MATCH (0 products)`);
            finalHandlesGuaranteed = [];
          }
        } else {
          // No hardTerms to anchor on - treat as NO_MATCH
          console.log(`[Layer 3] No hardTerms available for safe fallback - treating as NO_MATCH (0 products)`);
          finalHandlesGuaranteed = [];
        }
      } else {
        // CRITICAL FIX: For AI source, if validatedHandles is empty, keep original finalHandles (AI result)
        // This prevents losing AI handles when validation incorrectly clears them
        if (finalSource === "ai" && validatedHandles.length === 0 && finalHandles.length > 0) {
          console.warn(`[Bundle] validatedHandles is empty but keeping original AI finalHandles: ${finalHandles.length} handles`);
          finalHandlesGuaranteed = uniq(finalHandles);
      } else {
        finalHandlesGuaranteed = uniq(validatedHandles || finalHandles || []);
        }
      }

      // Bundle-safe top-up: only from bundle item pools
      if (isBundleMode && bundleIntent.items.length >= 2) {
        // Build itemPools STRICTLY: only candidates that match that item's hard term(s) AND constraints (BEFORE AI)
        const bundleItemPools = new Map<number, EnrichedCandidate[]>();
        for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
          const bundleItem = bundleItemsWithBudget[itemIdx];
          const itemHardTerms = bundleItem.hardTerms;
          
          // Get per-item constraints (merged from global + item-specific)
          const itemOptionConstraints = bundleItem.constraints?.optionConstraints;
          const itemGenericConstraints: Array<{ key: string; value: string }> = [];
          
          // Add item-specific constraints
          if (itemOptionConstraints?.size) {
            itemGenericConstraints.push({ key: "size", value: itemOptionConstraints.size });
          }
          if (itemOptionConstraints?.color) {
            itemGenericConstraints.push({ key: "color", value: itemOptionConstraints.color });
          }
          if (itemOptionConstraints?.material) {
            itemGenericConstraints.push({ key: "material", value: itemOptionConstraints.material });
          }
          
          // Add global hardFacets (if not overridden by item-specific)
          if (hardFacets.size && !itemOptionConstraints?.size) {
            itemGenericConstraints.push({ key: "size", value: hardFacets.size });
          }
          if (hardFacets.color && !itemOptionConstraints?.color) {
            itemGenericConstraints.push({ key: "color", value: hardFacets.color });
          }
          if (hardFacets.material && !itemOptionConstraints?.material) {
            itemGenericConstraints.push({ key: "material", value: hardFacets.material });
          }
          
          // Filter sortedCandidates to only those that match this item's hard terms AND constraints
          const itemPool: EnrichedCandidate[] = [];
          for (const c of sortedCandidates) {
            // Check anchor terms (hard terms)
            const haystack = [
              c.title || "",
              c.productType || "",
              (c.tags || []).join(" "),
              c.vendor || "",
              c.searchText || "",
            ].join(" ");
            
            const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (!hasItemMatch) continue;
            
            // Check constraints using satisfiesConstraintsStructuredOrTags (BEFORE adding to pool, BEFORE AI)
            if (itemGenericConstraints.length > 0) {
              const constraintResult = await satisfiesConstraintsStructuredOrTags(c, itemGenericConstraints, facetVocabulary);
              if (!constraintResult.ok) {
                continue; // Skip this candidate - doesn't satisfy constraints
              }
            }
            
            itemPool.push(c);
          }
          
          bundleItemPools.set(itemIdx, itemPool);
          console.log("[Bundle] Strict itemPool", itemIdx, `(${itemHardTerms[0]})`, "size:", itemPool.length, "constraints_applied=" + (itemGenericConstraints.length > 0));
        }
        
        // Union of all bundle item pools (bundle-safe source)
        const bundleSafePool: EnrichedCandidate[] = [];
        for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
          const pool = bundleItemPools.get(itemIdx) || [];
          bundleSafePool.push(...pool);
        }
        
        // Category guard function: verify handle belongs to at least one bundle item
        function belongsToBundleItem(candidate: EnrichedCandidate): boolean {
          const haystack = [
            candidate.title || "",
            candidate.productType || "",
            (candidate.tags || []).join(" "),
            candidate.vendor || "",
            candidate.searchText || "",
          ].join(" ");
          
          for (const bundleItem of bundleItemsWithBudget) {
            const hasMatch = bundleItem.hardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (hasMatch) return true;
          }
          return false;
        }
        
        // Assert every final handle exists in at least one itemPool; if not, drop it
        const strictItemPoolHandles = new Set<string>();
        for (const pool of bundleItemPools.values()) {
          for (const c of pool) {
            strictItemPoolHandles.add(c.handle);
          }
        }
        
        const outOfPoolHandles: string[] = [];
        const inPoolHandles: string[] = [];
        for (const handle of finalHandlesGuaranteed) {
          if (strictItemPoolHandles.has(handle)) {
            inPoolHandles.push(handle);
          } else {
            outOfPoolHandles.push(handle);
          }
        }
        
        if (outOfPoolHandles.length > 0) {
          console.log("[Bundle] outOfPoolDropped=", outOfPoolHandles.length, "handles:", outOfPoolHandles.slice(0, 5).join(", "));
          finalHandlesGuaranteed = inPoolHandles;
        }
        
        // If we need top-up, use 3-pass ladder
        if (finalHandlesGuaranteed.length < finalResultCount) {
          // Build allocated budgets map
          const allocatedBudgets = new Map<number, number>();
          bundleItemsWithBudget.forEach((item, idx) => {
            if (item.budgetMax !== undefined && item.budgetMax !== null) {
              allocatedBudgets.set(idx, item.budgetMax);
            }
          });
          
          // Use 3-pass bundle top-up ladder (with per-item facet constraints)
          const topUpResult = bundleTopUp3Pass(
            finalHandlesGuaranteed,
            bundleItemPools,
            allocatedBudgets,
            bundleIntent.totalBudget,
            finalResultCount,
            bundleItemsWithBudget.map(item => ({
              hardTerms: item.hardTerms,
              quantity: item.quantity,
              constraints: item.constraints, // Include constraints for per-item facet checks
            })),
            experience.inStockOnly || false,
            experience
          );
          
          // Replace with top-up result (already includes existing handles)
          finalHandlesGuaranteed = topUpResult.handles;
          
          if (topUpResult.trustFallback) {
            trustFallback = true;
          }
          
          // Log top-up results
          const finalCountsByItem = new Map<number, number>();
          for (const handle of finalHandlesGuaranteed) {
            for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
              const pool = bundleItemPools.get(itemIdx) || [];
              if (pool.some(c => c.handle === handle)) {
                finalCountsByItem.set(itemIdx, (finalCountsByItem.get(itemIdx) || 0) + 1);
                break;
              }
            }
          }
          
          const finalCountsText = bundleItemsWithBudget.map((item, idx) => {
            const count = finalCountsByItem.get(idx) || 0;
            const itemName = item.hardTerms[0];
            return `${itemName}=${count}`;
          }).join(" ");
          
          console.log("[Bundle TopUp] requested=", finalResultCount, "delivered=", finalHandlesGuaranteed.length, 
            "pass1_added=", topUpResult.pass1Added, "pass2_added=", topUpResult.pass2Added, 
            "pass3_added=", topUpResult.pass3Added, "trustFallback=", topUpResult.trustFallback,
            "budgetExceeded=", topUpResult.budgetExceeded);
          console.log("[Bundle TopUp] finalCounts", finalCountsText);
          console.log("[Bundle Budget] totalBudget=" + (bundleIntent.totalBudget !== null ? bundleIntent.totalBudget : "null") + 
            " finalTotalPrice=" + topUpResult.totalPrice.toFixed(2) + 
            " finalCount=" + finalHandlesGuaranteed.length + 
            " trustFallback=" + topUpResult.trustFallback +
            " budgetExceeded=" + (topUpResult.budgetExceeded === null ? "null" : String(topUpResult.budgetExceeded)));
          
          // If still can't reach requestedCount after 3 passes, update reasoning
          if (finalHandlesGuaranteed.length < finalResultCount) {
            const missingReason = `Only ${finalHandlesGuaranteed.length} matches available for the requested bundle categories within budget/stock constraints.`;
            if (reasoningParts.length > 0 && !reasoningParts[reasoningParts.length - 1].includes(missingReason)) {
              reasoningParts.push(missingReason);
            }
          }
        }
        
        // Count final handles per item for logging (AFTER top-up)
        const finalCountsByItem = new Map<number, number>();
        const noPoolHandles: string[] = [];
        for (const handle of finalHandlesGuaranteed) {
          let found = false;
          for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
            const pool = bundleItemPools.get(itemIdx) || [];
            if (pool.some(c => c.handle === handle)) {
              finalCountsByItem.set(itemIdx, (finalCountsByItem.get(itemIdx) || 0) + 1);
              found = true;
              break;
            }
          }
          if (!found) {
            noPoolHandles.push(handle);
          }
        }
        
        if (noPoolHandles.length > 0) {
          console.log("[Bundle] handles with no pool:", noPoolHandles.slice(0, 5).join(", "));
        }
        
        const finalCountsText = bundleItemsWithBudget.map((item, idx) => {
          const count = finalCountsByItem.get(idx) || 0;
          const itemName = item.hardTerms[0];
          return `${itemName}=${count}`;
        }).join(" ");
        console.log("[Bundle] finalCounts per item:", finalCountsText);
        
        // Track per-type counts and check for slot reallocation
        const perTypeCounts = bundleItemsWithBudget.map((item, idx) => ({
          index: idx,
          type: item.hardTerms[0] || "unknown",
          requested: slotPlan.get(idx) || 0,
          delivered: finalCountsByItem.get(idx) || 0,
          hasMatches: (finalCountsByItem.get(idx) || 0) > 0
        }));
        
        // Log perTypeCounts
        console.log("[Bundle] perTypeCounts", {
          counts: perTypeCounts.map(p => ({
            index: p.index,
            type: p.type,
            requested: p.requested,
            delivered: p.delivered,
            hasMatches: p.hasMatches
          })),
          totalRequested: Array.from(slotPlan.values()).reduce((sum, slots) => sum + slots, 0),
          totalDelivered: finalHandlesGuaranteed.length
        });
        
        // Check for types with no matches and log reallocation
        const typesWithNoMatches = perTypeCounts.filter(p => !p.hasMatches && p.requested > 0);
        if (typesWithNoMatches.length > 0) {
          console.log("[Bundle] slot_reallocation", {
            reason: "types_with_no_matches",
            reallocatedTypes: typesWithNoMatches.map(p => ({
              index: p.index,
              type: p.type,
              requestedSlots: p.requested
            })),
            note: "Slots reallocated to other types automatically"
          });
        }
        
        // Log final mix summary
        console.log("[Bundle] final_mix_summary", {
          requestedTypes: bundleIntent.items.length,
          requestedSlots: Array.from(slotPlan.values()).reduce((sum, slots) => sum + slots, 0),
          deliveredHandles: finalHandlesGuaranteed.length,
          typesWithMatches: perTypeCounts.filter(p => p.hasMatches).length,
          typesWithNoMatches: typesWithNoMatches.length,
          mix: perTypeCounts.map(p => `${p.type}:${p.delivered}`).join(" ")
        });
        
        console.log("[App Proxy] [Layer 3] Bundle-safe top-up complete:", finalHandlesGuaranteed.length, "handles (requested:", finalResultCount, ")");
      } else {
        // SINGLE-ITEM PATH: Existing top-up logic
        // Ensure finalHandlesGuaranteed is initialized from validatedHandles (which comes from finalHandles)
        // This ensures it's always properly initialized before use in single-item mode
        // finalHandlesGuaranteed is already declared at function scope, ensure it's initialized here
        // CRITICAL: For AI source, prefer validatedHandles, but if empty, keep original finalHandles (AI result)
        if (finalHandlesGuaranteed.length === 0) {
          if (finalSource === "ai" && finalHandles.length > 0 && validatedHandles.length === 0) {
            // AI succeeded but validation cleared everything - keep original AI handles
            console.warn(`[Bundle] validatedHandles is empty but keeping original AI finalHandles: ${finalHandles.length} handles`);
            finalHandlesGuaranteed = uniq(finalHandles);
          } else {
          finalHandlesGuaranteed = uniq(validatedHandles || finalHandles || []);
          }
        }
        
      // Enforce intent-safe top-up: when trustFallback=false, ONLY use gated pool
      // Convert hardFacets to constraints for constraint checking
      const { convertHardFacetsToConstraints } = await import("~/utils/facets.server");
      let topUpConstraints = convertHardFacetsToConstraints(hardFacets);
      
      // Issue 1 fix: Filter out degraded facets from top-up constraints
      if (degradedFacetsMap && degradedFacetsMap.size > 0) {
        const beforeCount = topUpConstraints.length;
        topUpConstraints = topUpConstraints.filter(c => {
          const facetNameLower = c.key.toLowerCase();
          const isDegraded = degradedFacetsMap.has(facetNameLower);
          return !isDegraded;
        });
        if (topUpConstraints.length < beforeCount) {
          const degradedList = Array.from(degradedFacetsMap.keys()).join(",");
          console.log(`[TopUp] degradedFacets filtered=${degradedList} before=${beforeCount} after=${topUpConstraints.length}`);
        }
      }
      
      if (!trustFallback) {
        // Intent-safe: top-up ONLY from gated candidates (no drift allowed)
        if (gatedCandidates.length > 0) {
            finalHandlesGuaranteed = await topUpHandlesFromGated(finalHandlesGuaranteed, gatedCandidates, finalResultCount, topUpConstraints, facetVocabularyForBundle);
        }
        // If still short after gated top-up, return fewer results (better than drift)
          console.log("[App Proxy] [Layer 3] Intent-safe top-up complete:", finalHandlesGuaranteed.length, "handles (requested:", finalResultCount, ")");
      } else {
        // Trust fallback: can use broader pool, but prefer gated first
        if (gatedCandidates.length > 0) {
            finalHandlesGuaranteed = await topUpHandlesFromGated(finalHandlesGuaranteed, gatedCandidates, finalResultCount, topUpConstraints, facetVocabularyForBundle);
        }
        
        // If still short, use broader pool (allCandidatesForTopUp)
          if (finalHandlesGuaranteed.length < finalResultCount && allCandidatesForTopUp.length > 0) {
            finalHandlesGuaranteed = await topUpHandlesFromGated(finalHandlesGuaranteed, allCandidatesForTopUp, finalResultCount, topUpConstraints, facetVocabularyForBundle);
        }
        
        // Last resort: baseProducts (only if trust fallback AND both pools exhausted)
        if (finalHandlesGuaranteed.length < finalResultCount) {
          const baseCandidates: EnrichedCandidate[] = baseProducts.map(p => {
            const descPlain = cleanDescription((p as any).description || null);
            const desc1000 = descPlain.substring(0, 1000);
            return {
              handle: p.handle,
              title: p.title,
              productType: (p as any).productType || null,
              tags: p.tags || [],
              vendor: (p as any).vendor || null,
              price: p.priceAmount || p.price || null,
              description: (p as any).description || null,
              descPlain,
              desc1000,
              searchText: buildSearchText({
                title: p.title,
                productType: (p as any).productType || null,
                vendor: (p as any).vendor || null,
                tags: p.tags || [],
                optionValues: (p as any).optionValues ?? {},
                sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
                colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
                materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
                desc1000,
              }),
              available: p.available,
              sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
              colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
              materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
              optionValues: (p as any).optionValues ?? {},
            } as EnrichedCandidate;
          });
            finalHandlesGuaranteed = await topUpHandlesFromGated(finalHandlesGuaranteed, baseCandidates, finalResultCount, topUpConstraints, facetVocabularyForBundle);
            }
          }
        }
      }

      // NOTE: Do NOT log "Final handles after top-up" here - this is an intermediate variable
      // Logging will happen AFTER validation/dedupe/availability/budget enforcement are complete
      // See deliveredHandlesFinal logging below

      // CRITICAL: Only update finalHandles if it wasn't set by AI (preserve AI result)
      if (finalSource !== "ai") {
      finalHandles = finalHandlesGuaranteed;
      } else {
        // For AI source: use finalHandlesGuaranteed (which comes from validatedHandles) if it has handles
        // Otherwise, keep the original finalHandles (AI result) to prevent losing AI handles
        if (finalHandlesGuaranteed.length > 0) {
          finalHandles = finalHandlesGuaranteed;
          console.log(`[Bundle] Using finalHandlesGuaranteed for finalHandles: ${finalHandles.length} handles (from validatedHandles)`);
        } else if (finalHandles.length > 0) {
          // Keep original AI handles if validation cleared everything
          console.warn(`[Bundle] finalHandlesGuaranteed is empty but finalHandles has ${finalHandles.length} AI handles - keeping original AI handles`);
          // Don't overwrite finalHandles - keep the original AI result
        } else {
          // Both are empty - this should not happen if AI succeeded
          console.error(`[Bundle] CRITICAL: Both finalHandlesGuaranteed and finalHandles are empty despite AI success`);
          finalHandles = finalHandlesGuaranteed; // Use empty array as last resort
        }
      }
      
      // REQUIREMENT 2: Remove downstream code that converts 0 validated handles into NO_MATCH for AI source
      // This is now handled in validation block above - if source=ai and validation returns 0, we keep AI handles
      // No need for this guard anymore

      // Prioritize AI reasoning over technical matching details
      // Only add trust signals if AI didn't provide reasoning (fallback case)
      // Skip technical "Matched:", "Include:", "Variant preferences:" prefixes
      // Note: AI reasoning check happens later when building final reasoning string

      // Ensure result diversity (vendor, type, price variety)
      // This improves user experience by avoiding too many similar products
      // CRITICAL FIX: Use allCandidatesEnriched (not just gatedCandidates) to ensure handles from bundle selection are found
      // Convert enriched candidates to format expected by ensureResultDiversity
      const candidatesForDiversity = allCandidatesEnriched.map(c => ({
        handle: c.handle,
        title: c.title,
        tags: c.tags,
        productType: c.productType,
        vendor: c.vendor,
        price: c.price,
        description: c.description,
        available: c.available,
        sizes: c.sizes,
        colors: c.colors,
        materials: c.materials,
        optionValues: c.optionValues,
      }));
      
      // Only apply diversity if we have handles to diversify
      // CRITICAL: Use finalHandles (which contains AI result) for diversity, not finalHandlesGuaranteed
      // finalHandlesGuaranteed might be empty if validation filtered everything, but AI handles should be preserved
      const handlesToDiversify = (finalSource === "ai" && finalHandles.length > 0) 
        ? finalHandles.slice(0, targetCount)
        : finalHandlesGuaranteed.slice(0, targetCount);
      
      // Log before diversity (especially important for bundles)
      if (isBundleMode) {
        console.log(`[Bundle] handles_before_diversity count=${handlesToDiversify.length} preview=[${handlesToDiversify.slice(0, 5).join(", ")}${handlesToDiversify.length > 5 ? "..." : ""}] finalSource=${finalSource}`);
      }
      
      // Declare diverseHandles outside if/else for scope
      let diverseHandles: string[] = [];
      
      // Hard guard: prevent empty diversity input when AI succeeded
      if (finalSource === "ai" && handlesToDiversify.length === 0) {
        console.warn("[Bundle] ERROR: AI source but handlesToDiversify empty before diversity - using finalHandles directly");
        // Use finalHandles if available
        if (finalHandles.length > 0) {
          diverseHandles = ensureResultDiversity(finalHandles.slice(0, targetCount), candidatesForDiversity, finalResultCount);
          console.log("[App Proxy] After diversity check:", diverseHandles.length, "handles (was", finalHandles.length, ")");
        } else {
          console.error("[Bundle] CRITICAL: AI source but both handlesToDiversify and finalHandles are empty");
          diverseHandles = [];
          console.log("[App Proxy] After diversity check:", diverseHandles.length, "handles (was", handlesToDiversify.length, ")");
        }
      } else {
        diverseHandles = handlesToDiversify.length > 0
          ? ensureResultDiversity(handlesToDiversify, candidatesForDiversity, finalResultCount)
          : handlesToDiversify; // If empty, return as-is (diversity check will return empty anyway)
        
        console.log("[App Proxy] After diversity check:", diverseHandles.length, "handles (was", handlesToDiversify.length, ")");
      }
      
      // ============================================
      // POST-DIVERSITY REFILL (for bundle mode) - REQUIREMENT 3: Per-item refill from itemGatedPools
      // ============================================
      // If diversity reduced handles below requestedCount, refill back to requestedCount
      // by selecting additional valid handles from itemGatedPools while respecting per-item slotPlan and constraints
      if (isBundleMode && diverseHandles.length < finalResultCount && bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        const beforeRefill = diverseHandles.length;
        const usedHandlesSet = new Set(diverseHandles);
        const refillNeeded = finalResultCount - diverseHandles.length;
        
        // Get slotPlan for bundle items
        const slotPlan = allocateSlotsAcrossTypes(bundleIntent.items, finalResultCount);
        
        // Count current handles per item type using aiItemIndexMap (preferred) or inferring
        const handlesPerItem = new Map<number, string[]>();
        diverseHandles.forEach(handle => {
          let itemIdx: number | null = null;
          // Use aiItemIndexMap if available (preferred)
          if (aiItemIndexMap && aiItemIndexMap.has(handle)) {
            itemIdx = aiItemIndexMap.get(handle)!;
          } else {
            // Fallback: infer from candidate matching
          const candidate = allCandidatesEnriched.find(c => c.handle === handle);
          if (candidate) {
              for (let idx = 0; idx < bundleIntent.items.length; idx++) {
                const item = bundleIntent.items[idx];
              const itemHardTerms = item.hardTerms || [];
              const slotDescriptor = itemHardTerms.join(" ");
              const slotScore = scoreProductForSlot(candidate, slotDescriptor);
              
              if (slotScore >= 0.1) {
                  itemIdx = idx;
                  break;
                }
              }
            }
          }
          
          if (itemIdx !== null) {
                if (!handlesPerItem.has(itemIdx)) {
                  handlesPerItem.set(itemIdx, []);
                }
                handlesPerItem.get(itemIdx)!.push(handle);
          }
        });
        
        // REQUIREMENT 3: Refill per-item from itemGatedPools (not global remaining_candidates)
        const refillHandlesByItem = new Map<number, string[]>();
        for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
          const currentCount = handlesPerItem.get(itemIdx)?.length || 0;
          const targetSlots = slotPlan.get(itemIdx) || 0;
          const neededForThisItem = Math.max(0, targetSlots - currentCount);
          
          if (neededForThisItem > 0) {
            // Get item pool from itemGatedPools (built earlier in bundle flow)
            const itemPoolData = itemGatedPools.find(pool => pool.itemIndex === itemIdx);
            const itemPool = itemPoolData?.candidates || [];
            
            if (itemPool.length === 0) {
              // Fallback: build itemPool from allCandidatesEnriched if itemGatedPools not available
              const item = bundleIntent.items[itemIdx];
              const itemHardTerms = item.hardTerms || [];
              const fallbackPool: EnrichedCandidate[] = [];
              for (const c of allCandidatesEnriched) {
                const haystack = [
                  c.title || "",
                  c.productType || "",
                  (c.tags || []).join(" "),
                  c.vendor || "",
                  c.searchText || "",
                ].join(" ");
                const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
                if (hasItemMatch) {
                  fallbackPool.push(c);
                }
              }
              itemPool.push(...fallbackPool);
            }
            
            // Get item-specific constraints for gating
            const item = bundleIntent.items[itemIdx];
            const itemConstraints = item.constraints;
            const itemOptionConstraints = itemConstraints?.optionConstraints;
            const itemHardTerms = item.hardTerms || [];
            
            // Build merged per-item constraints (item-specific only in bundle mode)
            const itemGenericConstraints: Array<{ key: string; value: string }> = [];
            
            // Add item-specific constraints
            if (itemOptionConstraints?.size) {
              itemGenericConstraints.push({ key: "size", value: itemOptionConstraints.size });
            }
            if (itemOptionConstraints?.color) {
              itemGenericConstraints.push({ key: "color", value: itemOptionConstraints.color });
            }
            if (itemOptionConstraints?.material) {
              itemGenericConstraints.push({ key: "material", value: itemOptionConstraints.material });
            }
            
            // In bundle mode, do NOT merge global hardFacets to prevent over-constraint
            if (!bundleIntent.isBundle) {
              if (hardFacets.size && !itemOptionConstraints?.size) {
                itemGenericConstraints.push({ key: "size", value: hardFacets.size });
              }
              if (hardFacets.color && !itemOptionConstraints?.color) {
                itemGenericConstraints.push({ key: "color", value: hardFacets.color });
              }
              if (hardFacets.material && !itemOptionConstraints?.material) {
                itemGenericConstraints.push({ key: "material", value: hardFacets.material });
              }
            }
            
            // Filter candidates from itemPool by constraints and availability
            const itemCandidates: EnrichedCandidate[] = [];
            for (const c of itemPool) {
              if (usedHandlesSet.has(c.handle) || refillHandlesByItem.get(itemIdx)?.includes(c.handle)) continue;
              
              // Check constraints using satisfiesConstraintsStructuredOrTags (constraint-aware)
              if (itemGenericConstraints.length > 0) {
                const constraintResult = await satisfiesConstraintsStructuredOrTags(c, itemGenericConstraints, facetVocabulary);
                if (!constraintResult.ok) {
                  if (constraintResult.conflict) {
                    console.log(`[TopUp] bundle_refill skip_conflict itemIndex=${itemIdx} facet=${constraintResult.conflict.facet} expected=${constraintResult.conflict.expected} actual=${constraintResult.conflict.actual} source=${constraintResult.conflict.source} handle=${c.handle}`);
                  }
                  continue; // Skip this candidate - doesn't satisfy constraints
                }
              }
                
                // Check availability
              if (experience.inStockOnly && !c.available) continue;
              
              itemCandidates.push(c);
            }
            
            // Sort candidates by slot score (descending), then price (ascending)
            const sortedItemCandidates = itemCandidates
              .sort((a, b) => {
                const slotDescriptor = itemHardTerms.join(" ");
                const scoreA = scoreProductForSlot(a, slotDescriptor);
                const scoreB = scoreProductForSlot(b, slotDescriptor);
                if (Math.abs(scoreA - scoreB) > 0.01) {
                  return scoreB - scoreA;
                }
                const priceA = a.price ? parseFloat(String(a.price)) : Infinity;
                const priceB = b.price ? parseFloat(String(b.price)) : Infinity;
                return priceA - priceB;
              })
              .slice(0, neededForThisItem);
            
            const refillHandlesForItem = sortedItemCandidates.map(c => c.handle);
            refillHandlesByItem.set(itemIdx, refillHandlesForItem);
            
            // Update aiItemIndexMap for refilled handles
            for (const handle of refillHandlesForItem) {
              if (aiItemIndexMap) {
                aiItemIndexMap.set(handle, itemIdx);
              }
            }
            
            console.log(`[BundleRefill] itemIndex=${itemIdx} added=${refillHandlesForItem.length} reason=needed_${neededForThisItem}_slots`);
          }
        }
        
        // REQUIREMENT 4: Assemble final handles by interleaving per-item lists (preserve per-item balance)
        // DO NOT just slice a flat list - that can remove the only shirts
        const allRefillHandles: string[] = [];
        for (const handles of refillHandlesByItem.values()) {
          allRefillHandles.push(...handles);
        }
        
        // Interleave diverseHandles and refillHandles to preserve per-item balance
        // First, group diverseHandles by itemIdx
        const diverseHandlesByItem = new Map<number, string[]>();
        for (const handle of diverseHandles) {
          let itemIdx: number | null = null;
            if (aiItemIndexMap && 'has' in aiItemIndexMap) {
              const map = aiItemIndexMap as Map<string, number>;
              if (map.has(handle)) {
                itemIdx = map.get(handle)!;
              }
        } else {
            // Fallback: infer from candidate
            const candidate = allCandidatesEnriched.find(c => c.handle === handle);
            if (candidate) {
              for (let idx = 0; idx < bundleIntent.items.length; idx++) {
                const item = bundleIntent.items[idx];
                const itemHardTerms = item.hardTerms || [];
                const slotDescriptor = itemHardTerms.join(" ");
                const slotScore = scoreProductForSlot(candidate, slotDescriptor);
                if (slotScore >= 0.1) {
                  itemIdx = idx;
                  break;
                }
              }
            }
          }
          
          if (itemIdx !== null) {
            if (!diverseHandlesByItem.has(itemIdx)) {
              diverseHandlesByItem.set(itemIdx, []);
            }
            diverseHandlesByItem.get(itemIdx)!.push(handle);
          }
        }
        
        // Build final handles by interleaving per-item (round-robin style, respecting slotPlan)
        const finalHandlesByItem = new Map<number, string[]>();
        for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
          const diverse = diverseHandlesByItem.get(itemIdx) || [];
          const refill = refillHandlesByItem.get(itemIdx) || [];
          finalHandlesByItem.set(itemIdx, [...diverse, ...refill]);
        }
        
        // Interleave handles per-item to preserve balance (ensure at least 1 per type if available)
        const interleavedHandles: string[] = [];
        const maxPerItem = Math.max(...Array.from(finalHandlesByItem.values()).map(h => h.length));
        
        for (let round = 0; round < maxPerItem && interleavedHandles.length < finalResultCount; round++) {
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length && interleavedHandles.length < finalResultCount; itemIdx++) {
            const handles = finalHandlesByItem.get(itemIdx) || [];
            if (round < handles.length) {
              interleavedHandles.push(handles[round]);
            }
          }
        }
        
        // If still under target, add remaining handles in order
        if (interleavedHandles.length < finalResultCount) {
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length && interleavedHandles.length < finalResultCount; itemIdx++) {
            const handles = finalHandlesByItem.get(itemIdx) || [];
            for (const handle of handles) {
              if (!interleavedHandles.includes(handle) && interleavedHandles.length < finalResultCount) {
                interleavedHandles.push(handle);
              }
            }
          }
        }
        
        diverseHandles = interleavedHandles.slice(0, finalResultCount);
        
        // Log per-item counts after refill
        const perItemCountsAfterRefill = Array.from(finalHandlesByItem.entries()).map(([idx, handles]) => {
          return `item${idx}=${handles.length}`;
        }).join(" ");
        console.log(`[BundleRefill] per_item_after_refill ${perItemCountsAfterRefill}`);
        
        const aiCoreUsed = finalSource === "ai" && !trustFallback;
        console.log(`[Bundle] post-diversity refill: before=${beforeRefill} after=${diverseHandles.length} added=${allRefillHandles.length} source=itemGatedPools aiCoreUsed=${aiCoreUsed}`);
        if (aiCoreUsed) {
          console.log(`[ResultSource] final=ai aiCoreUsed=true diversityRefill=true refillCount=${allRefillHandles.length}`);
        }
      }
      
      // Update finalHandles with diverse result (potentially refilled)
      finalHandles = diverseHandles;
      finalHandlesGuaranteed = diverseHandles;
      
      // REQUIREMENT 5: Log final per-item counts after all processing
      if (isBundleMode && bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        const finalHandlesByItemForLog = new Map<number, string[]>();
        for (const handle of finalHandles) {
          let itemIdx: number | null = null;
            if (aiItemIndexMap && 'has' in aiItemIndexMap) {
              const map = aiItemIndexMap as Map<string, number>;
              if (map.has(handle)) {
                itemIdx = map.get(handle)!;
              }
          } else {
            // Fallback: infer from candidate
            const candidate = allCandidatesEnriched.find(c => c.handle === handle);
            if (candidate) {
              for (let idx = 0; idx < bundleIntent.items.length; idx++) {
                const item = bundleIntent.items[idx];
                const itemHardTerms = item.hardTerms || [];
                const slotDescriptor = itemHardTerms.join(" ");
                const slotScore = scoreProductForSlot(candidate, slotDescriptor);
                if (slotScore >= 0.1) {
                  itemIdx = idx;
                  break;
                }
              }
            }
          }
          
          if (itemIdx !== null) {
            if (!finalHandlesByItemForLog.has(itemIdx)) {
              finalHandlesByItemForLog.set(itemIdx, []);
            }
            finalHandlesByItemForLog.get(itemIdx)!.push(handle);
          }
        }
        
        const perItemCountsFinal = Array.from(finalHandlesByItemForLog.entries()).map(([idx, handles]) => {
          return `item${idx}=${handles.length}`;
        }).join(" ");
        console.log(`[BundleFinal] per_item_final ${perItemCountsFinal} total=${finalHandles.length}`);
      }

      // Final reasoning string (prioritize AI reasoning, make notes customer-friendly)
      // Check if reasoningParts contains AI-generated reasoning (human-like, professional)
      // AI reasoning typically doesn't contain technical prefixes like "Include:", "Matched:", etc.
      const hasAIReasoning = reasoningParts.some(part => 
        part && 
        part.trim() && 
        !part.includes("Include:") && 
        !part.includes("Matched:") && 
        !part.includes("Variant preferences:") &&
        !part.includes("Broadened category") &&
        part.length > 20 // AI reasoning is usually longer than technical notes
      );
      
      let reasoning = "";
      
      if (hasAIReasoning) {
        // Use AI reasoning as primary source (most human-like)
        // Filter out technical parts and keep only customer-facing reasoning
        const aiReasoningParts = reasoningParts.filter(part => 
          part && 
          !part.includes("Include:") && 
          !part.includes("Matched:") && 
          !part.includes("Variant preferences:") &&
          !part.includes("Broadened category")
        );
        reasoning = aiReasoningParts.filter(Boolean).join(" ");
        
        // Only add customer-friendly context if needed
        if (relaxNotes.some(n => n.includes("budget") || n.includes("Budget"))) {
          reasoning = "Showing the best matches we found within your budget. " + reasoning;
        }
      } else {
        // Fallback: build reasoning from parts, but make it customer-friendly
        // Remove all technical prefixes and convert to natural language
        const customerFriendlyParts = reasoningParts
          .filter(part => part && part.trim())
          .map(part => {
            // Remove technical prefixes
            if (part.includes("Include:")) {
              const terms = part.replace(/Include:\s*/i, "").replace(/\.$/, "");
              return `Looking for ${terms}.`;
            }
            if (part.includes("Matched:")) {
              const matches = part.replace(/Matched:\s*/i, "").replace(/\.$/, "");
              // Extract category and attributes in customer-friendly way
              const categoryMatch = matches.match(/category:\s*([^,]+)/i);
              const colorMatch = matches.match(/color:\s*([^,]+)/i);
              if (categoryMatch && colorMatch) {
                return `Found ${categoryMatch[1].trim()} in ${colorMatch[1].trim()}.`;
              }
              if (categoryMatch) {
                return `Found ${categoryMatch[1].trim()}.`;
              }
              return null; // Skip if can't parse nicely
            }
            if (part.includes("Variant preferences:")) {
              return null; // Skip technical preferences
            }
            if (part.includes("Broadened category matching")) {
              return null; // Skip technical matching notes
            }
            return part;
          })
          .filter(Boolean) as string[];
        
        const customerFriendlyNotes = relaxNotes.map(note => {
          // Convert technical notes to customer-friendly language
          if (note.includes("Broadened category matching")) {
            return null; // Skip technical matching notes
          }
          if (note.includes("Budget filter relaxed")) {
            return "Showing the closest matches within your budget.";
          }
          if (note.includes("out-of-stock")) {
            return "Including some options that may have limited availability.";
          }
          if (note.includes("closest matches across")) {
            return "Showing the best matches we found.";
          }
          return note;
        }).filter(Boolean) as string[];
        
        reasoning = [...customerFriendlyNotes, ...customerFriendlyParts].filter(Boolean).join(" ");
        
        // If still empty or too technical, provide a default friendly message
        if (!reasoning || reasoning.length < 10) {
          const categoryNames = hardTerms.length > 0 ? hardTerms.join(", ") : "your preferences";
          reasoning = `Selected the best matches for ${categoryNames}.`;
        }
      }
      const finalHandlesArray = Array.isArray(finalHandlesGuaranteed) ? finalHandlesGuaranteed : [];
      productHandles = (Array.isArray(diverseHandles) ? diverseHandles : finalHandlesArray).slice(0, targetCount);
      
      // NOTE: Do NOT add delivered count to reasoning here - it will be added AFTER handlesToSave is finalized
      // This prevents the "Showing 0 results" bug where intermediate variables are used instead of final saved result

      // NOTE: Do NOT check "No products found" here - productHandles is an intermediate variable
      // This check will happen AFTER validation/dedupe/availability/budget enforcement are complete
      // See deliveredHandlesFinal check below
      
      let finalReasoning = reasoning;
      
      // Guard: finalHandles must be defined and an array before saving
      if (finalHandles === undefined || !Array.isArray(finalHandles)) {
        const errorMsg = `[App Proxy] FATAL: finalHandles is undefined or not an array. Cannot save or mark COMPLETE. finalHandles=${finalHandles}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // Ensure productHandles is always an array before saving
      const finalHandlesToSave = Array.isArray(productHandles) ? productHandles : [];
      
      // Double-check: if finalHandlesToSave is empty but finalHandles has items, use finalHandles
      let handlesToSave = finalHandlesToSave.length > 0 ? finalHandlesToSave : (Array.isArray(finalHandles) ? finalHandles.slice(0, targetCount) : []);
      let deliveredCount = handlesToSave.length;
      const requestedCount = finalResultCount;
      // billedCount will be calculated later based on resultSource
      
      // Bundle mode validation: verify each requested type has at least 1 match (BEFORE Layer 3 validation)
      let missingTypes: Array<{ index: number; type: string }> = [];
      if (isBundleMode && bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        // Check which types are missing from finalHandlesGuaranteed
        const handlesSet = new Set(finalHandlesGuaranteed);
        const candidateMapForTypeCheck = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
        
        for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
          const bundleItem = bundleIntent.items[itemIdx];
          const itemHardTerms = bundleItem.hardTerms;
          
          // Check if any handle in finalHandlesGuaranteed matches this item's hard terms
          let hasMatch = false;
          for (const handle of finalHandlesGuaranteed) {
            const candidate = candidateMapForTypeCheck.get(handle);
            if (!candidate) continue;
            
            const haystack = [
              candidate.title || "",
              candidate.productType || "",
              (candidate.tags || []).join(" "),
              candidate.vendor || "",
              candidate.searchText || "",
            ].join(" ");
            
            const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (hasItemMatch) {
              hasMatch = true;
              break;
            }
          }
          
          if (!hasMatch) {
            missingTypes.push({
              index: itemIdx,
              type: itemHardTerms[0] || "unknown"
            });
          }
        }
        
        // Log missing types before top-up
        if (missingTypes.length > 0) {
          console.log("[Bundle] validation_missing_types", {
            missingTypes: missingTypes.map(m => ({ index: m.index, type: m.type })),
            beforeTopUp: true
          });
          
          // Top-up per missing type from broader pool
          const usedHandles = new Set(finalHandlesGuaranteed);
          const topUpCandidates: EnrichedCandidate[] = [];
          
          for (const missing of missingTypes) {
            const bundleItem = bundleIntent.items[missing.index];
            const itemHardTerms = bundleItem.hardTerms;
            
            // Find candidates from broader pool (allCandidatesEnriched) that match this type
            // and are not already in finalHandlesGuaranteed
            const typeCandidates = allCandidatesEnriched
              .filter(c => {
                // Skip if already used
                if (usedHandles.has(c.handle)) return false;
                
                // Check availability if inStockOnly is enabled
                if (experience.inStockOnly && c.available !== true) return false;
                
                // Check if matches this item's hard terms
                const haystack = [
                  c.title || "",
                  c.productType || "",
                  (c.tags || []).join(" "),
                  c.vendor || "",
                  c.searchText || "",
                ].join(" ");
                
                return itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
              })
              .slice(0, Math.min(entitlements.candidateCap || 100, 10)); // Limit per type
            
            if (typeCandidates.length > 0) {
              // Use BM25 ranking for this type
              const itemTokens = itemHardTerms.flatMap(t => tokenize(t));
              const itemIdf = calculateIDF(typeCandidates.map(c => ({ tokens: tokenize(c.searchText) })));
              const itemAvgLen = typeCandidates.reduce((sum, c) => sum + tokenize(c.searchText).length, 0) / typeCandidates.length || 1;
              
              const itemRanked = typeCandidates.map(c => {
                const docTokens = tokenize(c.searchText);
                const docTokenFreq = new Map<string, number>();
                for (const token of docTokens) {
                  docTokenFreq.set(token, (docTokenFreq.get(token) || 0) + 1);
                }
                const score = bm25Score(itemTokens, docTokens, docTokenFreq, docTokens.length, itemAvgLen, itemIdf);
                return { candidate: c, score };
              });
              
              itemRanked.sort((a, b) => b.score - a.score);
              
              // Add top 1-2 candidates per missing type
              const topCandidatesForType = itemRanked.slice(0, Math.min(2, itemRanked.length)).map(r => r.candidate);
              topUpCandidates.push(...topCandidatesForType);
              
              console.log("[Bundle] validation_top_up_type", {
                missingTypeIndex: missing.index,
                missingType: missing.type,
                candidatesFound: typeCandidates.length,
                topCandidatesAdded: topCandidatesForType.length,
                topHandles: topCandidatesForType.map(c => c.handle).slice(0, 3)
              });
            } else {
              console.log("[Bundle] validation_no_candidates_for_type", {
                missingTypeIndex: missing.index,
                missingType: missing.type,
                note: "No candidates found in broader pool for this type"
              });
            }
          }
          
          // Add top-up candidates to finalHandlesGuaranteed
          if (topUpCandidates.length > 0) {
            const newHandles = topUpCandidates
              .map(c => c.handle)
              .filter(h => !usedHandles.has(h));
            
            finalHandlesGuaranteed.push(...newHandles);
            
            console.log("[Bundle] validation_top_up_result", {
              missingTypesBefore: missingTypes.length,
              topUpCandidatesAdded: newHandles.length,
              newHandles: newHandles.slice(0, 5)
            });
            
            // Re-check which types are still missing after top-up
            const handlesSetAfter = new Set(finalHandlesGuaranteed);
            const stillMissing: Array<{ index: number; type: string }> = [];
            
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              const bundleItem = bundleIntent.items[itemIdx];
              const itemHardTerms = bundleItem.hardTerms;
              
              let hasMatch = false;
              for (const handle of finalHandlesGuaranteed) {
                const candidate = candidateMapForTypeCheck.get(handle);
                if (!candidate) continue;
                
                const haystack = [
                  candidate.title || "",
                  candidate.productType || "",
                  (candidate.tags || []).join(" "),
                  candidate.vendor || "",
                  candidate.searchText || "",
                ].join(" ");
                
                const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
                if (hasItemMatch) {
                  hasMatch = true;
                  break;
                }
              }
              
              if (!hasMatch) {
                stillMissing.push({
                  index: itemIdx,
                  type: itemHardTerms[0] || "unknown"
                });
              }
            }
            
            missingTypes = stillMissing;
            
            // Update handlesToSave with updated finalHandlesGuaranteed
            const updatedHandlesToSave = Array.isArray(productHandles) ? productHandles : [];
            const finalHandlesToSaveUpdated = updatedHandlesToSave.length > 0 
              ? updatedHandlesToSave 
              : (Array.isArray(finalHandles) ? finalHandles.slice(0, targetCount) : []);
            
            // Merge with finalHandlesGuaranteed (avoid duplicates)
            const mergedHandles = Array.from(new Set([...finalHandlesToSaveUpdated, ...finalHandlesGuaranteed]));
            handlesToSave = mergedHandles.slice(0, requestedCount);
            deliveredCount = handlesToSave.length;
            // billedCount will be calculated later based on resultSource
          }
        }
        
        // Log final missing types (if any remain after top-up)
        if (missingTypes.length > 0) {
          console.log("[Bundle] validation_final_missing_types", {
            missingTypes: missingTypes.map(m => ({ index: m.index, type: m.type })),
            reason: "PARTIAL_BUNDLE",
            note: "Some requested types have no matches in the product pool"
          });
          
          // Update reasoning to indicate partial bundle
          if (reasoning && !reasoning.includes("partial bundle")) {
            const missingTypesList = missingTypes.map(m => m.type).join(", ");
            reasoning += ` Note: Some requested types (${missingTypesList}) could not be matched from available products.`;
          }
        } else {
          console.log("[Bundle] validation_all_types_satisfied", {
            requestedTypes: bundleIntent.items.length,
            note: "All requested types have at least one match"
          });
        }
      }
      
      // Layer 3 final handle validation: track rejection reasons
      const candidateMapForValidation = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
      let notFound = 0;
      let unavailable = 0;
      let filteredByConstraints = 0; // Note: constraints filtering happens earlier, this would be additional filtering
      const seenHandles = new Set<string>();
      let duplicates = 0;
      
      for (const handle of handlesToSave) {
        // Check for duplicates
        if (seenHandles.has(handle)) {
          duplicates++;
          continue;
        }
        seenHandles.add(handle);
        
        // Check if handle exists in candidate map
        const candidate = candidateMapForValidation.get(handle);
        if (!candidate) {
          notFound++;
          continue;
        }
        
        // Check if handle is unavailable / not active
        if (candidate.available !== true) {
          unavailable++;
          continue;
        }
      }
      
      // Log validation rejection reasons
      const valid = handlesToSave.length - notFound - unavailable - duplicates;
      console.log("[Validation] handle_rejections", {
        requested: requestedCount,
        valid,
        notFound,
        unavailable,
        filteredByConstraints,
        duplicates
      });
      
      // BUDGET ENFORCEMENT: Apply budget per-item (single) or per-outfit (bundle), NOT per-list-sum
      let constraintExceeded = false;
      const maxPriceCeiling = priceMax; // priceMax is the numeric ceiling extracted from user input
      if (typeof maxPriceCeiling === "number" && maxPriceCeiling > 0 && handlesToSave.length > 0) {
        const candidateMapForCheck = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
        
        // BUNDLE BUDGET SEMANTICS: For bundles, budget applies to ONE complete outfit (1 per group), not all options
        // Check if this is a bundle with totalBudget
        const isBundleWithBudget = isBundleMode && bundleIntent.isBundle && bundleIntent.items.length >= 2 && bundleIntent.totalBudget !== null;
        
        // Prepare handles with prices for analysis
        const handlesWithPrices = handlesToSave.map(handle => {
          const candidate = candidateMapForCheck.get(handle);
          const price = candidate && candidate.price ? parseFloat(String(candidate.price)) : 0;
          return { handle, price: Number.isFinite(price) ? price : 0 };
        });
        
        if (isBundleWithBudget) {
          // BUNDLE FLOW: Budget applies to one complete outfit (1 per group)
          // Prepare handles with prices for grouping/analysis
          const handlesWithPrices = handlesToSave.map(handle => {
            const candidate = candidateMapForCheck.get(handle);
            const price = candidate && candidate.price ? parseFloat(String(candidate.price)) : 0;
            return { handle, price: Number.isFinite(price) ? price : 0 };
          });
          
          // Step 1: Group handles by matching item type using proper matching logic (industry-agnostic)
          const handlesByType = new Map<number, Array<{ handle: string; price: number }>>();
          const groupPoolSizes: Array<{ index: number; label: string; poolSize: number }> = [];
          
          if (isBundleMode && bundleIntent.isBundle && bundleIntent.items.length >= 2) {
            // Initialize empty arrays for each required group
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              handlesByType.set(itemIdx, []);
            }
            
            // Group handles by matching item type using proper matching logic
            for (const { handle, price } of handlesWithPrices) {
              const candidate = candidateMapForCheck.get(handle);
              if (!candidate) continue;
              
              const haystack = [
                candidate.title || "",
                candidate.productType || "",
                (candidate.tags || []).join(" "),
                candidate.vendor || "",
                candidate.searchText || "",
              ].join(" ");
              
              // Find which item type this handle matches (industry-agnostic matching)
              let matched = false;
              for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
                const bundleItem = bundleIntent.items[itemIdx];
                const itemHardTerms = bundleItem.hardTerms;
                const matches = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
                if (matches) {
                  handlesByType.get(itemIdx)!.push({ handle, price });
                  matched = true;
                  break;
                }
              }
              
              // If no match found, assign to first type (fallback - should be rare)
              if (!matched && bundleIntent.items.length > 0) {
                handlesByType.get(0)!.push({ handle, price });
              }
            }
            
            // Log pool sizes per group
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              const bundleItem = bundleIntent.items[itemIdx];
              const label = normalizeItemLabel(bundleItem.hardTerms[0] || "unknown");
              const poolSize = handlesByType.get(itemIdx)?.length || 0;
              groupPoolSizes.push({ index: itemIdx, label, poolSize });
            }
            console.log("[Bundle] groupPoolSizes", groupPoolSizes);
          } else {
            // Single-item: all handles belong to one group
            handlesByType.set(0, handlesWithPrices);
          }
          
          // Step 2: Calculate cheapest one-per-group total (for bundles) or cheapest single item (for single-item)
          let cheapestOnePerGroupTotal = 0;
          const cheapestOnePerGroup: string[] = [];
          
          if (isBundleMode && bundleIntent.isBundle && bundleIntent.items.length >= 2) {
            // For bundles: find cheapest item per required group
            for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
              const groupHandles = handlesByType.get(itemIdx) || [];
              if (groupHandles.length > 0) {
                // Sort by price ascending and take cheapest
                const sorted = [...groupHandles].sort((a, b) => a.price - b.price);
                cheapestOnePerGroup.push(sorted[0].handle);
                cheapestOnePerGroupTotal += sorted[0].price;
              }
            }
          } else {
            // Single-item: just take cheapest
            const sorted = [...handlesWithPrices].sort((a, b) => a.price - b.price);
            if (sorted.length > 0) {
              cheapestOnePerGroup.push(sorted[0].handle);
              cheapestOnePerGroupTotal = sorted[0].price;
            }
          }
          
          const canMeetBudget = cheapestOnePerGroupTotal <= maxPriceCeiling;
          
          console.log("[Bundle Budget] budget_scope=per_outfit", {
            primariesTotal: cheapestOnePerGroupTotal,
            maxPriceCeiling,
            canMeetBudget,
            primariesHandles: cheapestOnePerGroup,
            allItemsCount: handlesToSave.length
          });
          
          // BUNDLE BUDGET: Budget applies to one complete outfit (1 per group), NOT sum of all options
          // If canMeetBudget=true, keep all items (alternatives are not part of budget sum)
          // If canMeetBudget=false, still keep all items but mark budgetExceeded
          if (canMeetBudget) {
            // Budget is satisfied for one complete outfit - keep all items (up to requestedCount)
            // Reorder so primaries come first, but don't filter
            const primaryHandlesSet = new Set(cheapestOnePerGroup);
            const reorderedHandles: string[] = [];
            const nonPrimaryHandles: string[] = [];
            
            for (const handle of handlesToSave) {
              if (primaryHandlesSet.has(handle)) {
                reorderedHandles.push(handle);
              } else {
                nonPrimaryHandles.push(handle);
              }
            }
            
            // Add primaries first, then alternatives
            handlesToSave = [...reorderedHandles, ...nonPrimaryHandles].slice(0, finalResultCount);
            deliveredCount = handlesToSave.length;
            
            console.log(`[Bundle Budget] ✅ canMeetBudget=true - keeping all ${handlesToSave.length} items (budget applies to primaries only, not alternatives)`);
          } else {
            // Cannot meet budget even with cheapest one-per-group - still keep all items but mark exceeded
          constraintExceeded = true;
            trustFallback = true;
            console.log("[Bundle Budget] ❌ cannot meet budget - cheapest one-per-group exceeds budget", {
              cheapestOnePerGroupTotal,
            maxPriceCeiling,
              difference: cheapestOnePerGroupTotal - maxPriceCeiling,
            });
            // Still keep all items - budget is a soft constraint
          }
        } else {
          // SINGLE-ITEM FLOW: Budget applies per item, NOT per list sum
          // Filter items individually: remove items where price > maxPriceCeiling
          const beforeCount = handlesToSave.length;
          const filteredHandles = handlesWithPrices
            .filter(({ price }) => price <= maxPriceCeiling)
            .map(({ handle }) => handle)
            .slice(0, finalResultCount); // Cap at requested count (8, 12, or 16)
          
          const removedOverCeiling = beforeCount - filteredHandles.length;
          
          if (removedOverCeiling > 0 || filteredHandles.length < handlesToSave.length) {
            handlesToSave = filteredHandles;
            deliveredCount = filteredHandles.length;
            if (removedOverCeiling > 0) {
              constraintExceeded = true;
              trustFallback = true;
            }
          }
          
          console.log("[Constraints] budget_scope=per_item", {
            ceiling: maxPriceCeiling,
            removedOverCeiling,
            kept: filteredHandles.length,
            beforeCount,
            requestedCount: finalResultCount
          });
          
          // ============================================
          // BUDGET REFILL (after budget constraints)
          // ============================================
          // If deliveredCount < requestedCount after budget filtering, refill from remaining candidates
          if (filteredHandles.length < finalResultCount && filteredHandles.length < beforeCount) {
            const handlesToRefill = finalResultCount - filteredHandles.length;
            const usedHandlesSet = new Set(filteredHandles);
            
            // Get remaining candidates that satisfy constraints (price, availability, non-duplicate)
            const remainingCandidates = allCandidatesEnriched
              .filter(c => {
                if (usedHandlesSet.has(c.handle)) return false; // Skip already used
                if (!c.available && experience.inStockOnly) return false; // Skip unavailable if inStockOnly
                const price = c.price ? parseFloat(String(c.price)) : 0;
                if (Number.isFinite(price) && price > maxPriceCeiling) return false; // Skip over budget
                return true;
              });
            
            // If collectionIntent=true, preserve family coverage when refilling
            if (collectionIntent && !bundleIntent.isBundle) {
              // Get current family coverage
              const currentFamilies = new Set<string>();
              filteredHandles.forEach(handle => {
                const candidate = candidateMapForCheck.get(handle);
                if (candidate) {
                  const familyInfo = deriveFamilyKey(candidate);
                  currentFamilies.add(familyInfo.key);
                }
              });
              
              // Get the chosen families from earlier (same logic as window selection)
              const candidatesWithFamilies = remainingCandidates.map(c => {
                const familyInfo = deriveFamilyKey(c);
                return {
                  candidate: c,
                  familyKey: familyInfo.key
                };
              });
              
              const familyFreq = new Map<string, number>();
              candidatesWithFamilies.forEach(c => {
                familyFreq.set(c.familyKey, (familyFreq.get(c.familyKey) || 0) + 1);
              });
              
              const rankedFamilies = Array.from(familyFreq.entries())
                .map(([key, count]) => ({ key, count }))
                .sort((a, b) => b.count - a.count);
              
              // Pick distinct families (up to 4)
              const chosenFamilies: string[] = [];
              for (const family of rankedFamilies) {
                if (chosenFamilies.length >= 4) break;
                const isSimilar = chosenFamilies.some(chosen => 
                  chosen.includes(family.key) || family.key.includes(chosen)
                );
                if (!isSimilar) {
                  chosenFamilies.push(family.key);
                }
              }
              
              if (chosenFamilies.length < 2) {
                chosenFamilies.push(...rankedFamilies.slice(0, 2 - chosenFamilies.length).map(f => f.key));
              }
              
              // Prioritize refilling missing families first, then fill remaining slots
              const refillHandles: string[] = [];
              const missingFamilies = chosenFamilies.filter((f: string) => !currentFamilies.has(f));
              
              // First, refill missing families (one per missing family)
              for (const missingFamily of missingFamilies) {
                if (refillHandles.length >= handlesToRefill) break;
                
                const familyCandidates = remainingCandidates
                  .filter(c => {
                    const familyInfo = deriveFamilyKey(c);
                    return familyInfo.key === missingFamily && !usedHandlesSet.has(c.handle);
                  })
                  .sort((a, b) => {
                    // Sort by BM25-like score (use searchText match with hardTerms)
                    const aScore = hardTerms.length > 0 ? (extractSearchText(a).toLowerCase().includes(hardTerms[0]?.toLowerCase() || "") ? 1 : 0) : 0;
                    const bScore = hardTerms.length > 0 ? (extractSearchText(b).toLowerCase().includes(hardTerms[0]?.toLowerCase() || "") ? 1 : 0) : 0;
                    return bScore - aScore;
                  });
                
                if (familyCandidates.length > 0) {
                  refillHandles.push(familyCandidates[0].handle);
                  usedHandlesSet.add(familyCandidates[0].handle);
                }
              }
              
              // Then fill remaining slots from any group (prioritize by BM25-like score)
              if (refillHandles.length < handlesToRefill) {
                const remaining = remainingCandidates
                  .filter(c => !usedHandlesSet.has(c.handle))
                  .sort((a, b) => {
                    const aScore = hardTerms.length > 0 ? (extractSearchText(a).toLowerCase().includes(hardTerms[0]?.toLowerCase() || "") ? 1 : 0) : 0;
                    const bScore = hardTerms.length > 0 ? (extractSearchText(b).toLowerCase().includes(hardTerms[0]?.toLowerCase() || "") ? 1 : 0) : 0;
                    return bScore - aScore;
                  })
                  .slice(0, handlesToRefill - refillHandles.length)
                  .map(c => c.handle);
                
                refillHandles.push(...remaining);
              }
              
              filteredHandles.push(...refillHandles);
              // Mark that we refilled from remaining candidates (resultSource will be set to "fallback" later, not "ai")
              if (refillHandles.length > 0) {
                usedRefillFromRemaining = true;
              }
              console.log(`[Refill] after_budget delivered=${filteredHandles.length} requested=${finalResultCount} added=${refillHandles.length} reason=budget collectionIntent=true`);
            } else {
              // Standard refill: just take top remaining candidates
              const refillHandles = remainingCandidates
                .slice(0, handlesToRefill)
                .map(c => c.handle);
              
              filteredHandles.push(...refillHandles);
              // Mark that we refilled from remaining candidates (resultSource will be set to "fallback" later, not "ai")
              if (refillHandles.length > 0) {
                usedRefillFromRemaining = true;
              }
              console.log(`[Refill] after_budget delivered=${filteredHandles.length} requested=${finalResultCount} added=${refillHandles.length} reason=budget`);
            }
            
            // Update handlesToSave and deliveredCount
            handlesToSave = filteredHandles.slice(0, finalResultCount); // Cap at requested count
            deliveredCount = handlesToSave.length;
          }
        }
      }
      
      // Track if emergency fallback was used (for billing protection)
      let emergencyFallbackUsed = false;
      let resultSource: "ai" | "fallback" | "emergency_fallback_unmatched" = "ai";
      
      // Update resultSource based on validation fallback or refills
      // Diversity refill is NOT a fallback - it's just filling gaps from AI result
      // Only mark as fallback if we truly fell back from AI (AI failed or trustFallback=true)
      // usedRefillFromRemaining should only be true for true fallbacks, not diversity refills
      const aiCoreUsed = finalSource === "ai" && !trustFallback;
      if (usedValidationFallback || (usedRefillFromRemaining && !aiCoreUsed) || usedRefillFromBM25) {
        resultSource = "fallback";
        console.log(`[App Proxy] resultSource set to "fallback" (validationFallback=${usedValidationFallback}, refillRemaining=${usedRefillFromRemaining && !aiCoreUsed}, refillBM25=${usedRefillFromBM25})`);
      } else if (aiCoreUsed) {
        resultSource = "ai";
        console.log(`[ResultSource] final=ai aiCoreUsed=true diversityRefill=${usedRefillFromRemaining} validationFallback=${usedValidationFallback}`);
      }
      
      // FINAL SAFETY CHECK: Only use emergency fallback if absolutely no results (rare occurrence)
      // AI ranking should handle most cases - this is truly a last resort
      if (handlesToSave.length === 0 && allCandidatesEnriched.length > 0) {
        // Check if all gating stages failed (no matches found)
        const allStagesFailed = trustFallback && gatedCandidates.length === 0;
        
        if (allStagesFailed) {
          // All staged fallback failed - mark as emergency_fallback_unmatched (no billing)
          emergencyFallbackUsed = true;
          resultSource = "emergency_fallback_unmatched";
          console.warn("[App Proxy] ⚠️  EMERGENCY FALLBACK (UNMATCHED): All gating stages failed - no matches found");
          console.warn("[App Proxy] ⚠️  No handles to save - applying emergency fallback (NO BILLING)");
          
          // Still provide results but mark as unmatched
          const emergencyCandidates = allCandidatesEnriched
            .filter(c => c.available) // Prefer in-stock
            .sort((a, b) => {
              // Sort by: available first, then by handle for consistency
              if (a.available !== b.available) return a.available ? -1 : 1;
              return a.handle.localeCompare(b.handle);
            })
            .slice(0, Math.min(finalResultCount, 12)); // Cap at 12 for safety
          
          // Apply budget constraint to emergency candidates if needed
          if (typeof maxPriceCeiling === "number" && maxPriceCeiling > 0) {
            const emergencyWithPrices = emergencyCandidates.map(c => {
              const price = c.price ? parseFloat(String(c.price)) : 0;
              return { handle: c.handle, price: Number.isFinite(price) ? price : 0 };
            }).sort((a, b) => a.price - b.price); // Sort by price ascending (cheapest first)
            
            let emergencyTotal = 0;
            const emergencyFiltered: string[] = [];
            for (const { handle, price } of emergencyWithPrices) {
              if (emergencyTotal + price <= maxPriceCeiling) {
                emergencyFiltered.push(handle);
                emergencyTotal += price;
              }
            }
            
            handlesToSave = emergencyFiltered.length > 0 ? emergencyFiltered : emergencyCandidates.slice(0, 1).map(c => c.handle);
          } else {
            handlesToSave = emergencyCandidates.map(c => c.handle);
          }
          
          deliveredCount = handlesToSave.length;
          console.log(`[App Proxy] ✅ Emergency fallback (unmatched) applied: ${deliveredCount} products selected - NO BILLING`);
          
          // Update reasoning to reflect emergency fallback
          if (handlesToSave.length > 0) {
            reasoning = "No matches found for your request after searching. Showing available products.";
          }
        } else {
          // Regular emergency fallback (shouldn't happen often)
          emergencyFallbackUsed = true;
          resultSource = "fallback";
          console.warn("[App Proxy] ⚠️  EMERGENCY FALLBACK: No handles after all processing - this should be rare");
          console.warn("[App Proxy] ⚠️  No handles to save - applying emergency fallback");
          
          // Emergency fallback: use any available candidates, prioritizing in-stock items
          const emergencyCandidates = allCandidatesEnriched
            .filter(c => c.available) // Prefer in-stock
            .sort((a, b) => {
              // Sort by: available first, then by handle for consistency
              if (a.available !== b.available) return a.available ? -1 : 1;
              return a.handle.localeCompare(b.handle);
            })
            .slice(0, Math.min(finalResultCount, 12)); // Cap at 12 for safety
          
          // Apply budget constraint to emergency candidates if needed
          if (typeof maxPriceCeiling === "number" && maxPriceCeiling > 0) {
            const emergencyWithPrices = emergencyCandidates.map(c => {
              const price = c.price ? parseFloat(String(c.price)) : 0;
              return { handle: c.handle, price: Number.isFinite(price) ? price : 0 };
            }).sort((a, b) => a.price - b.price); // Sort by price ascending (cheapest first)
            
            let emergencyTotal = 0;
            const emergencyFiltered: string[] = [];
            for (const { handle, price } of emergencyWithPrices) {
              if (emergencyTotal + price <= maxPriceCeiling) {
                emergencyFiltered.push(handle);
                emergencyTotal += price;
              }
            }
            
            handlesToSave = emergencyFiltered.length > 0 ? emergencyFiltered : emergencyCandidates.slice(0, 1).map(c => c.handle);
          } else {
            handlesToSave = emergencyCandidates.map(c => c.handle);
          }
          
          deliveredCount = handlesToSave.length;
          console.log(`[App Proxy] ✅ Emergency fallback applied: ${deliveredCount} products selected`);
          
          // Update reasoning to reflect emergency fallback
          if (handlesToSave.length > 0) {
            reasoning = reasoning || "Showing available products that best match your preferences.";
          }
        }
      }
      
      // FINAL VALIDATION: Ensure handlesToSave contains valid handles
      const validHandles = handlesToSave.filter(handle => {
        const candidate = allCandidatesEnriched.find(c => c.handle === handle);
        return candidate !== undefined;
      });
      
      if (validHandles.length < handlesToSave.length) {
        console.warn(`[App Proxy] ⚠️  Filtered out ${handlesToSave.length - validHandles.length} invalid handles`);
        handlesToSave = validHandles;
        deliveredCount = validHandles.length;
      }
      
      // ABSOLUTE FINAL CHECK: If still empty, use first available product (guaranteed result)
      if (handlesToSave.length === 0 && allCandidatesEnriched.length > 0) {
        const firstAvailable = allCandidatesEnriched.find(c => c.available) || allCandidatesEnriched[0];
        handlesToSave = [firstAvailable.handle];
        deliveredCount = 1;
        console.log(`[App Proxy] ✅ Absolute fallback: using single product ${firstAvailable.handle}`);
        reasoning = "Showing the best available match for your request.";
      }
      
      // CRITICAL FIX: Use authoritative final saved result count
      // This is the ONLY source of truth for delivered count - computed AFTER all processing
      const deliveredHandlesFinal = handlesToSave; // Authoritative: final saved handles
      const deliveredCountFinal = deliveredHandlesFinal.length; // Authoritative: use saved handles count
      const requestedCountFinal = finalResultCount;
      const isBundleModeForReasoning = bundleIntent?.isBundle === true;
      
      // BUG FIX #3: Group bundle results by item type (for structured return)
      // Declare early so it's available when saving
      let bundleGroupedResult: {
        items: Array<{ type: string; primary: string; alternatives: string[] }>;
        flatHandles: string[];
      } | null = null;
      
      if (isBundleModeForReasoning && bundleIntent.items.length >= 2 && deliveredHandlesFinal.length > 0) {
        // Group handles by item type
        const handlesByItemType = new Map<number, string[]>();
        const candidateMapForGrouping = new Map(allCandidatesEnriched.map(c => [c.handle, c]));
        
        for (const handle of deliveredHandlesFinal) {
          const candidate = candidateMapForGrouping.get(handle);
          if (!candidate) continue;
          
          // Find which bundle item this handle matches
          for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
            const bundleItem = bundleIntent.items[itemIdx];
            const itemHardTerms = bundleItem.hardTerms;
            const haystack = [
              candidate.title || "",
              candidate.productType || "",
              (candidate.tags || []).join(" "),
              candidate.vendor || "",
              candidate.searchText || "",
            ].join(" ");
            
            const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (hasItemMatch) {
              if (!handlesByItemType.has(itemIdx)) {
                handlesByItemType.set(itemIdx, []);
              }
              handlesByItemType.get(itemIdx)!.push(handle);
              break; // Handle can only match one item type
            }
          }
        }
        
        // Build grouped structure: primary (first) + alternatives (rest)
        // Stable ordering: sort by itemIdx, then by handle order in deliveredHandlesFinal
        const groupedItems: Array<{ type: string; primary: string; alternatives: string[] }> = [];
        for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
          const bundleItem = bundleIntent.items[itemIdx];
          const itemType = bundleItem.hardTerms[0] || `item${itemIdx}`;
          const handlesForType = handlesByItemType.get(itemIdx) || [];
          
          if (handlesForType.length > 0) {
            // Sort handles to maintain stable ordering (by position in deliveredHandlesFinal)
            const sortedHandles = handlesForType.sort((a, b) => {
              const idxA = deliveredHandlesFinal.indexOf(a);
              const idxB = deliveredHandlesFinal.indexOf(b);
              return idxA - idxB;
            });
            
            groupedItems.push({
              type: itemType,
              primary: sortedHandles[0], // First handle is primary
              alternatives: sortedHandles.slice(1), // Rest are alternatives
            });
          }
        }
        
        bundleGroupedResult = {
          items: groupedItems,
          flatHandles: deliveredHandlesFinal, // Keep flat list for backward compatibility
        };
        
        console.log(`[Bundle Grouping] grouped ${groupedItems.length} item types:`, groupedItems.map(item => `${item.type}=${1 + item.alternatives.length}`).join(", "));
      }
      
      // Log final delivery metrics (authoritative values)
      console.log("[App Proxy] Final handles after top-up:", deliveredCountFinal, "requested:", requestedCountFinal);
      
      // Generate helpful suggestions ONLY if deliveredCountFinal === 0 (authoritative check)
      if (deliveredCountFinal === 0) {
        const suggestions = generateEmptyResultSuggestions(
          userIntent,
          filteredProducts.length,
          baseProducts.length
        );
        finalReasoning = suggestions.length > 0 
          ? `No products match your criteria. ${suggestions[0]}`
          : "No products available. Please try adjusting your search criteria or filters.";
        console.log("[App Proxy] No products found - generated suggestions:", suggestions);
      }
      
      // Remove any existing "Showing X results" from reasoning to avoid duplication
      let finalReasoningToSave = reasoning || finalReasoning || "";
      finalReasoningToSave = finalReasoningToSave.replace(/\s*Showing\s+\d+\s+results\s+\(requested\s+\d+\)[^.]*/gi, "");
      
      // Update reasoning with final delivered count (only if different from requested)
      if (deliveredCountFinal < requestedCountFinal) {
        // Explain why fewer results
        let whyFewer = "";
        if (isBundleModeForReasoning) {
          // Bundle-specific reasons
          if (relaxNotes.some(n => n.includes("budget") || n.includes("Budget"))) {
            whyFewer = "Limited matches available within budget and stock constraints.";
          } else if (relaxNotes.some(n => n.includes("stock") || n.includes("Stock"))) {
            whyFewer = "Limited in-stock matches available for the requested bundle categories.";
          } else {
            whyFewer = "Limited matches available for the requested bundle categories.";
          }
        } else {
          // Single-item reasons
          if (relaxNotes.some(n => n.includes("budget") || n.includes("Budget"))) {
            whyFewer = "Limited matches available within budget constraints.";
          } else if (relaxNotes.some(n => n.includes("stock") || n.includes("Stock"))) {
            whyFewer = "Limited in-stock matches available.";
          } else {
            whyFewer = "Limited matches available for your criteria.";
          }
        }
        finalReasoningToSave += ` Showing ${deliveredCountFinal} results (requested ${requestedCountFinal}). ${whyFewer}`;
      } else if (deliveredCountFinal === requestedCountFinal && relaxNotes.some(n => n.includes("exceed") || n.includes("Exceed") || n.includes("relaxed"))) {
        // Budget was exceeded in pass 3
        finalReasoningToSave += ` Showing ${deliveredCountFinal} results (requested ${requestedCountFinal}). Budget was relaxed to show more options.`;
      }
      
      // Calculate billedCount: 0 if emergency_fallback_unmatched, otherwise deliveredCount
      const billedCount = resultSource === "emergency_fallback_unmatched" ? 0 : deliveredCountFinal;
      
      console.log("[App Proxy] Saving: requested=", requestedCount, "delivered=", deliveredCount, "deliveredCountFinal=", deliveredCountFinal, "billedCount=", billedCount, "resultSource=", resultSource, "handlesPreview=", deliveredHandlesFinal.slice(0, 5));
      
      // Save results and mark session as COMPLETE (ONLY AFTER finalHandles is computed)
      // Note: If missingTypes.length > 0, this is a PARTIAL_BUNDLE (still marked COMPLETE)
      // BUG FIX #3: Store grouped bundle info if available (as JSON in reasoning or separate field)
      const saveStart = performance.now();
      
      // For bundles, include grouped structure in reasoning (as JSON string for now)
      // TODO: Add separate field to ConciergeResult schema for bundleGroupedData
      let reasoningToSave = deliveredCountFinal > 0 ? finalReasoningToSave : finalReasoning;
      if (bundleGroupedResult && deliveredCountFinal > 0) {
        // Append grouped structure as JSON (can be parsed by frontend if needed)
        const groupedJson = JSON.stringify(bundleGroupedResult);
        reasoningToSave += ` [BUNDLE_GROUPED:${groupedJson}]`;
      }
      
      await saveConciergeResult({
        sessionToken,
        productHandles: deliveredHandlesFinal, // Use authoritative final handles (flat list for backward compatibility)
        productIds: null,
        reasoning: reasoningToSave,
      });
      saveMs = Math.round(performance.now() - saveStart);

      console.log("[App Proxy] Results saved, session marked COMPLETE. deliveredCount=", deliveredCount);

      // BUG FIX #4: Log metrics - per-item stats for bundle mode, single-item stats otherwise
      if (isBundleModeForReasoning && bundleIntent.items.length >= 2) {
        // Bundle metrics: per-item stats
        const perItemStats: Array<{ itemType: string; strictGateCount: number; gatedPoolCount: number }> = [];
        
        // Build item pools for metrics (reuse logic from validation)
        for (let itemIdx = 0; itemIdx < bundleIntent.items.length; itemIdx++) {
          const bundleItem = bundleIntent.items[itemIdx];
          const itemHardTerms = bundleItem.hardTerms;
          const itemType = itemHardTerms[0] || `item${itemIdx}`;
          
          // Count strict gate candidates for this item (if strictGate exists)
          let itemStrictGateCount = 0;
          if (strictGate && strictGate.length > 0) {
            itemStrictGateCount = strictGate.filter(c => {
              const haystack = [
                c.title || "",
                c.productType || "",
                (c.tags || []).join(" "),
                c.vendor || "",
                c.searchText || "",
              ].join(" ");
              return itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            }).length;
          }
          
          // Count gated pool candidates for this item
          const itemGatedPoolCount = gatedCandidates.filter(c => {
            const haystack = [
              c.title || "",
              c.productType || "",
              (c.tags || []).join(" "),
              c.vendor || "",
              c.searchText || "",
            ].join(" ");
            return itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
          }).length;
          
          perItemStats.push({
            itemType,
            strictGateCount: itemStrictGateCount,
            gatedPoolCount: itemGatedPoolCount,
          });
        }
        
        const perItemStatsText = perItemStats.map(s => `${s.itemType}=${s.strictGateCount}/${s.gatedPoolCount}`).join(" ");
        console.log(`[App Proxy] [Bundle Metrics] per_item_stats: ${perItemStatsText} | AI window: ${aiWindow} | Trust fallback: ${trustFallback} | Hard terms: ${hardTerms.length}`);
      } else {
        // Single-item metrics (existing logic)
        console.log("[App Proxy] [Metrics] Strict gate:", strictGateCount || 0, "| AI window:", aiWindow, "| Trust fallback:", trustFallback, "| Hard terms:", hardTerms.length, "| Gated pool:", gatedCandidates.length);
      }
      
      // Log final gating stage used and top matched tokens/fields
      if (hardTerms.length > 0) {
        const finalStage = strictGateCount >= (finalResultCount + 6) ? "A" : 
                          (gatedCandidates.length > 0 && !trustFallback) ? "B/C/D" : "D (emergency)";
        console.log(`[Gating] Final stage used: ${finalStage} strictGateCount=${strictGateCount} gatedCount=${gatedCandidates.length} trustFallback=${trustFallback}`);
        
        // Log top matched tokens/fields for debugging (sample from final gated pool)
        if (gatedCandidates.length > 0) {
          const sampleSize = Math.min(3, gatedCandidates.length);
          const topMatches = gatedCandidates.slice(0, sampleSize).map(c => {
            const searchText = unifiedNormalize(c.searchText || extractSearchText(c));
            const tokens = tokenize(searchText);
            const matchedTokens = hardTerms.flatMap(term => {
              const normalized = unifiedNormalize(term);
              const termTokens = tokenize(normalized);
              return termTokens.filter(t => tokens.includes(t));
            });
            return {
              handle: c.handle,
              title: c.title?.substring(0, 30),
              matchedTokens: Array.from(new Set(matchedTokens))
            };
          });
          console.log(`[Gating] Top matched tokens/fields (sample ${sampleSize}):`, JSON.stringify(topMatches));
        }
      }
      
      // Log AI call counts
      console.log("[Perf] ai_calls", { 
        intentParsing: intentParseCallCount,
        productRanking: aiCallCount,
        total: intentParseCallCount + aiCallCount
      });
      
      // Safety clamp: aiMs should never exceed total duration
      const totalDurationMs = Math.round(performance.now() - processStartTime);
      const aiMsBefore = aiMs;
      if (aiMs > totalDurationMs) {
        aiMs = Math.min(aiMs, totalDurationMs);
        console.log("[Perf] aiMs_clamped", { aiMsBefore, totalDurationMs, aiMsAfter: aiMs });
      }
      
      // Log performance timings
      console.log("[Perf] timings", {
        sid: sessionToken,
        shopifyFetchMs,
        enrichmentMs,
        gatingMs,
        bm25Ms,
        aiMs,
        saveMs,
      });

      // NOTE: Billing is NOT performed here - will be handled separately when results are delivered
    } else {
      console.log("[App Proxy] No access token available - skipping product fetch");

      // Save empty results if no access token
      await saveConciergeResult({
        sessionToken,
        productHandles: [],
        productIds: null,
        reasoning: "No products available. Please ensure the app is installed and products exist.",
      });
      
      // Mark session as FAILED
      await prisma.conciergeSession.update({
        where: { publicToken: sessionToken },
        data: { status: ConciergeSessionStatus.FAILED },
      }).catch(() => {});
      
      // Log AI call count (should be 0)
      console.log("[Perf] ai_calls", { 
        intentParsing: intentParseCallCount,
        productRanking: aiCallCount,
        total: intentParseCallCount + aiCallCount
      });
    }
  } catch (error: any) {
    // If error occurs in product fetching/processing, re-throw to be caught by outer try-catch
    console.error("[App Proxy] Error in product fetching/processing:", error);
      // Mark session as FAILED
      await prisma.conciergeSession.update({
        where: { publicToken: sessionToken },
        data: { 
          status: ConciergeSessionStatus.FAILED,
        },
      }).catch(() => {});
      
      // Save error result
      await saveConciergeResult({
        sessionToken,
        productHandles: [],
        productIds: null,
        reasoning: error instanceof Error ? error.message : "Error processing request. Please try again.",
      }).catch(() => {});
      
      // Re-throw to be caught by outer handler in setImmediate
      throw error;
    }
}



