import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";
import { createConciergeSession, saveConciergeResult } from "~/models/concierge.server";
import { getAccessTokenForShop, fetchShopifyProducts } from "~/shopify-admin.server";
import { rankProductsWithAI, fallbackRanking } from "~/models/ai-ranking.server";
import { ConciergeSessionStatus } from "@prisma/client";
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

const PRODUCT_POOL_LIMIT = 500;       // how many products we pull from Shopify
// CANDIDATE_WINDOW_SIZE is now dynamic based on entitlements (calculated per request)
const MAX_AI_PASSES = 3;              // first pass + up to 2 top-up passes
const MIN_CANDIDATES_FOR_AI = 50;     // enough variety for AI
const MIN_CANDIDATES_FOR_DELIVERY = 16; // ensures top-up has room (>=2x 8-pack)

type VariantConstraints = {
  size: string | null;
  color: string | null;
  material: string | null;
};

function pickString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
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

function parseConstraintsFromText(text: string): VariantConstraints {
  const t = (text || "").toLowerCase();

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

  // Common "UK 10" style sizes (fashion)
  const ukDress = t.match(/\buk\s?(\d{1,2})\b/);
  const numericSize = t.match(/\bsize\s?(\d{1,2})\b/);

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
  let material: string | null = null;
  for (const m of materials) {
    const re = new RegExp(`\\b${m.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(text)) { 
      material = m.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" "); 
      break; 
    }
  }

  return { size, color, material };
}

/**
 * Parse user intent into hard terms, soft terms, avoid terms, and facets
 * Industry-agnostic intent parsing
 */
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
  
  // Minimal synonym expansion for category-like hard terms (industry-agnostic, easy to extend)
  // Conservative: only expands specific terms, avoids broad words like "clothing"
  const categorySynonyms: Record<string, string[]> = {
    "suit": ["suit", "business suit", "men's suit", "ladies suit", "formal suit"],
    "dress": ["dress", "gown", "frock", "ladies dress"],
    "shirt": ["shirt", "button-up", "button down", "dress shirt"],
    "sofa": ["sofa", "couch", "settee", "chesterfield"],
    "treadmill": ["treadmill", "running machine", "running treadmill"],
    "serum": ["serum", "face serum", "facial serum", "serum treatment"],
    "mattress": ["mattress", "bed mattress", "sleep mattress"],
    "perfume": ["perfume", "fragrance", "cologne", "eau de parfum"],
    "laptop": ["laptop", "notebook", "laptop computer"],
    "headphone": ["headphone", "headphones", "earphones", "earbuds"],
  };
  
  /**
   * Expand hard terms with synonyms (conservative, only for known categories)
   */
  function expandHardTermsWithSynonyms(terms: string[]): string[] {
    const expanded = new Set<string>();
    for (const term of terms) {
      expanded.add(term);
      const synonyms = categorySynonyms[term.toLowerCase()];
      if (synonyms && synonyms.length > 0) {
        // Add 2-6 synonyms max per term (already limited by map)
        for (const synonym of synonyms.slice(0, 6)) {
          if (synonym.toLowerCase() !== term.toLowerCase()) {
            expanded.add(synonym);
          }
        }
      }
    }
    return Array.from(expanded);
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
  
  // Find category phrases (hard terms)
  for (const phrase of categoryPhrases) {
    const regex = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (regex.test(lowerText)) {
      hardTerms.push(phrase);
    }
  }
  
  // Expand hard terms with synonyms (conservative, only for known categories)
  const expandedHardTerms = expandHardTermsWithSynonyms(hardTerms);
  
  // Parse answers JSON for additional context
  let answersData: any = {};
  try {
    answersData = typeof answersJson === "string" ? JSON.parse(answersJson) : answersJson;
    if (Array.isArray(answersData)) {
      // If array, concatenate strings
      const answerText = answersData
        .filter((a: any) => typeof a === "string")
        .join(" ")
        .toLowerCase();
      
      // Check for category mentions in answers
      for (const phrase of categoryPhrases) {
        if (answerText.includes(phrase) && !expandedHardTerms.includes(phrase)) {
          expandedHardTerms.push(phrase);
        }
      }
    } else if (typeof answersData === "object") {
      // Check object keys/values for categories
      const answerText = JSON.stringify(answersData).toLowerCase();
      for (const phrase of categoryPhrases) {
        if (answerText.includes(phrase) && !expandedHardTerms.includes(phrase)) {
          expandedHardTerms.push(phrase);
        }
      }
    }
  } catch {
    // Ignore parse errors
  }
  
  // Apply synonym expansion to any newly found terms
  const finalHardTerms = expandHardTermsWithSynonyms(expandedHardTerms);
  
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
 * Parse bundle intent: detect multi-item queries (e.g., "3 piece suit, shirt and trousers")
 * Industry-agnostic bundle detection
 */
function parseBundleIntentGeneric(userIntent: string): {
  isBundle: boolean;
  items: Array<{ hardTerms: string[]; quantity: number }>;
  totalBudget: number | null;
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
  
  // Category synonyms (industry-agnostic, expanded for all industries)
  const categorySynonyms: Record<string, string[]> = {
    // Fashion & Apparel
    "suit": ["suit", "business suit", "men's suit", "ladies suit", "formal suit", "tuxedo"],
    "dress": ["dress", "gown", "frock", "ladies dress", "evening dress"],
    "shirt": ["shirt", "button-up", "button down", "dress shirt", "button shirt"],
    "pants": ["pants", "trousers", "slacks"],
    "jacket": ["jacket", "coat", "blazer", "outerwear"],
    // Home & Garden
    "sofa": ["sofa", "couch", "settee", "chesterfield", "loveseat"],
    "mattress": ["mattress", "bed mattress", "sleep mattress"],
    "chair": ["chair", "seat", "armchair"],
    "table": ["table", "desk", "dining table"],
    "lamp": ["lamp", "light", "lighting"],
    "rug": ["rug", "carpet", "mat"],
    // Beauty & Cosmetics
    "serum": ["serum", "face serum", "facial serum", "serum treatment"],
    "moisturizer": ["moisturizer", "moisturizing cream", "face cream"],
    "cleanser": ["cleanser", "face wash", "facial cleanser"],
    "perfume": ["perfume", "fragrance", "cologne", "eau de parfum"],
    "shampoo": ["shampoo", "hair shampoo"],
    "conditioner": ["conditioner", "hair conditioner"],
    // Health & Wellness
    "treadmill": ["treadmill", "running machine", "running treadmill"],
    "yoga mat": ["yoga mat", "exercise mat", "fitness mat"],
    "supplement": ["supplement", "dietary supplement", "nutritional supplement"],
    "vitamin": ["vitamin", "vitamins", "multivitamin"],
    // Electronics
    "laptop": ["laptop", "notebook", "laptop computer"],
    "headphone": ["headphone", "headphones", "earphones", "earbuds"],
    "phone": ["phone", "smartphone", "mobile phone", "cell phone"],
  };
  
  // Soft words that are NOT categories (ignore these)
  const softWords = new Set(["complete", "outfit", "set", "kit", "bundle", "package", "collection"]);
  
  // Find all category mentions in the intent
  const foundCategories: Array<{ term: string; position: number }> = [];
  
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
  
  // Check for bundle indicators: commas, "and", "+"
  const bundleIndicators = [
    /,\s*and\s+/i,
    /,\s+/,
    /\s+and\s+/i,
    /\s+\+\s+/,
  ];
  
  let hasBundleIndicator = false;
  for (const pattern of bundleIndicators) {
    if (pattern.test(userIntent)) {
      hasBundleIndicator = true;
      break;
    }
  }
  
  // Bundle detected if: ≥2 distinct categories AND bundle indicators present
  const uniqueCategories = Array.from(new Set(foundCategories.map(c => c.term)));
  const isBundle = uniqueCategories.length >= 2 && hasBundleIndicator;

  if (!isBundle) {
    return { isBundle: false, items: [], totalBudget: null };
  }
  
  // Extract items with quantities
  const items: Array<{ hardTerms: string[]; quantity: number }> = [];
  const seenTerms = new Set<string>();
  
  for (const { term } of foundCategories) {
    if (seenTerms.has(term.toLowerCase())) continue;
    seenTerms.add(term.toLowerCase());
    
    // Check for quantity prefix (e.g., "3 piece suit")
    const quantityMatch = lowerText.match(new RegExp(`(\\d+)\\s*(?:piece|pc|pcs)?\\s*${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    const quantity = quantityMatch ? parseInt(quantityMatch[1], 10) : 1;
    
    // Expand with synonyms
    const hardTerms = [term];
    const synonyms = categorySynonyms[term.toLowerCase()];
    if (synonyms) {
      hardTerms.push(...synonyms.filter(s => s.toLowerCase() !== term.toLowerCase()));
    }
    
    items.push({ hardTerms, quantity });
  }
  
  // Extract total budget if mentioned
  // Support phrases like:
  // - "total budget is $500"
  // - "my total budget is 500"
  // - "budget is $500"
  // - "under $500", "max $500", "up to $500"
  // Support $, £, €, and plain numbers
  let totalBudget: number | null = null;
  const normalizedIntent = userIntent.toLowerCase();
  
  const budgetPatterns = [
    // "total budget is $500" or "my total budget is 500"
    /(?:my\s+)?total\s+budget\s+is\s*[£$€]?(\d+(?:\.\d+)?)/i,
    // "budget is $500"
    /budget\s+is\s*[£$€]?(\d+(?:\.\d+)?)/i,
    // "under $500", "max $500", "up to $500"
    /(?:under|max|maximum|up\s+to)\s*[£$€]?(\d+(?:\.\d+)?)/i,
    // "$500 total" or "$500 budget" or "$500 for all"
    /[£$€](\d+(?:\.\d+)?)\s*(?:total|budget|for\s+all|for\s+everything)/i,
    // "total of $500" or "budget of $500"
    /(?:total|budget)\s+of\s*[£$€]?(\d+(?:\.\d+)?)/i,
    // Generic: "spend $500" or "spending $500"
    /spend(?:ing)?\s*[£$€]?(\d+(?:\.\d+)?)/i,
  ];
  
  for (const pattern of budgetPatterns) {
    const match = normalizedIntent.match(pattern);
    if (match && match[1]) {
      const parsed = parseFloat(match[1]);
      if (!isNaN(parsed) && isFinite(parsed) && parsed > 0) {
        totalBudget = parsed;
        console.log("[Bundle] Parsed budget:", totalBudget, "from pattern:", pattern.toString());
        break;
      }
    }
  }
  
  if (totalBudget === null) {
    console.log("[Bundle] No budget found in intent:", userIntent.substring(0, 100));
  }
  
  return { isBundle: true, items, totalBudget };
}

function mergeConstraints(a: VariantConstraints, b: VariantConstraints): VariantConstraints {
  // a has priority over b
  return {
    size: a.size ?? b.size,
    color: a.color ?? b.color,
    material: a.material ?? b.material,
  };
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

  const { experienceId, answers, clientRequestId } = body;
  // NOTE: resultCount is ignored - Experience.resultCount is the ONLY source of truth
  const bodyResultCount = (body as any).resultCount; // Only for logging
  console.log("[App Proxy] Request body:", {
    experienceId,
    bodyResultCount, // Log only, not used
    hasAnswers: !!answers,
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
        status: existing.status,
        resultCount: existing.resultCount || 8,
        idempotent: true,
      };
      
      // If COMPLETE and result exists, include handles/reasoning
      if (existing.status === "COMPLETE" && existing.result) {
        const productHandles = Array.isArray(existing.result.productHandles) 
          ? existing.result.productHandles 
          : (typeof existing.result.productHandles === "string" ? JSON.parse(existing.result.productHandles) : []);
        responseData.productHandles = productHandles;
        responseData.reasoning = existing.result.reasoning || null;
      }
      
      // If already COMPLETE, return immediately
      if (existing.status === "COMPLETE") {
        return Response.json(responseData);
      }
      
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
  // Note: hasAnswers was already calculated earlier as isQuestionOnlyRequest = !hasAnswers
  if (!hasAnswers) {
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

  // Answers provided - proceed with session creation and result processing
  console.log("[App Proxy] Answers provided - creating session and processing");

  // Block access if subscription is cancelled or trial expired
  if (entitlements.planTier === "TRIAL" && !entitlements.showTrialBadge) {
    // If planTier is TRIAL but trial has expired (showTrialBadge is false), block access
    return Response.json({
      ok: false,
      error: "Subscription required to use EditMuse. Please subscribe via the app admin.",
      errorCode: "SUBSCRIPTION_REQUIRED",
    }, { status: 403 });
  }

  // Calculate dynamic AI window - REDUCED for speed
  // Single-item: max 40 candidates (was 60-120)
  // Bundle: max 30 per item (was 30, but total could be 90+)
  // No hard terms: max 30 candidates (was 60)
  const singleItemWindow = 40;
  const bundlePerItemWindow = 30; // Max 30 per item
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

  // Create session
  const sessionToken = await createConciergeSession({
    shopId: shop.id,
    experienceId: experience.id,
    resultCount: finalResultCount,
    answersJson,
    clientRequestId: clientRequestId && typeof clientRequestId === "string" ? clientRequestId.trim() : null,
  });

  // Track usage: session started
  await trackUsageEvent(shop.id, "SESSION_STARTED" as UsageEventType, {
    sessionToken,
    experienceId: experience.id,
    resultCount: finalResultCount,
  });

  console.log("[App Proxy] Session created:", sessionToken, "mode:", modeUsed, "experienceId:", experienceIdUsed);

  // Parse experience filters
  const includedCollections = JSON.parse(experience.includedCollections || "[]") as string[];
  const excludedTags = JSON.parse(experience.excludedTags || "[]") as string[];

  // Parse answers to extract price/budget range if present
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  
  if (Array.isArray(answers)) {
    // Look for budget/price range answers - check if any answer matches common budget patterns
    for (const answer of answers) {
      const answerStr = String(answer).toLowerCase().trim();
      
      // Parse budget range patterns like "under-50", "50-100", "100-200", "200-500", "500-plus"
      // Also handle formats like "under $50", "$50 - $100", etc.
      
      // Handle "under-50" or "under 50" format
      if (answerStr.startsWith("under")) {
        const match = answerStr.match(/under[-\s]*\$?(\d+)/);
        if (match) {
          priceMax = parseFloat(match[1]) - 0.01; // Under $50 means < $50, so max is 49.99
          console.log("[App Proxy] Detected budget: under", match[1], "-> max:", priceMax);
        }
      } 
      // Handle "500-plus" or "500+" format
      else if (answerStr.includes("-plus") || answerStr.match(/\d+[\s]*\+/)) {
        const match = answerStr.match(/(\d+)[-\s]*plus|(\d+)[\s]*\+/i);
        const amount = match ? parseFloat(match[1] || match[2]) : null;
        if (amount) {
          priceMin = amount;
          console.log("[App Proxy] Detected budget:", amount, "and above -> min:", priceMin);
        }
      } 
      // Handle range like "50-100" or "$50 - $100"
      else if (answerStr.match(/\d+[-\s]+\d+/)) {
        const match = answerStr.match(/\$?(\d+)[-\s]+\$?(\d+)/);
        if (match) {
          priceMin = parseFloat(match[1]);
          priceMax = parseFloat(match[2]);
          console.log("[App Proxy] Detected budget range:", priceMin, "-", priceMax);
        }
      }
      // Handle "plus" or "+" with amount before it (e.g., "$500+", "500 and above")
      else if (answerStr.includes("plus") || answerStr.includes("+") || answerStr.includes("and above")) {
        const match = answerStr.match(/\$?(\d+)[-\s]*plus|\$?(\d+)[-\s]*\+|\$?(\d+)[-\s]*and\s*above/i);
        const amount = match ? parseFloat(match[1] || match[2] || match[3]) : null;
        if (amount) {
          priceMin = amount;
          console.log("[App Proxy] Detected budget:", amount, "and above -> min:", priceMin);
        }
      }
    }
  }

  // Get access token from Session table
  const accessToken = await getAccessTokenForShop(shopDomain);
  
  let productHandles: string[] = [];
  let chargeResult: { charged: boolean; creditsBurned: number; overageCreditsX2Delta: number } | null = null;
  
    try {
      if (accessToken) {
      console.log("[App Proxy] Fetching products from Shopify Admin API");
      
      // Fetch products
      let products = await fetchShopifyProducts({
        shopDomain,
        accessToken,
        limit: PRODUCT_POOL_LIMIT,
        collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
      });

      console.log("[App Proxy] Fetched", products.length, "products");

      // Debug log: Product/Variant counts
      const totalProducts = products.length;
      const totalVariants = products.reduce((sum, p) => sum + ((p as any).variants?.length || 0), 0);
      const avgVariantsPerProduct = totalProducts > 0 ? totalVariants / totalProducts : 0;
      console.log("[App Proxy] Product/Variant counts", { totalProducts, totalVariants, avgVariantsPerProduct });

      // Filter out ARCHIVED and DRAFT products
      const beforeStatusFilter = products.length;
      products = products.filter(p => {
        const status = (p as any).status;
        return status !== "ARCHIVED" && status !== "DRAFT";
      });
      console.log("[App Proxy] After status filter (excluding ARCHIVED/DRAFT):", products.length, "products (filtered from", beforeStatusFilter, ")");

      // Apply filters
      // Filter by excluded tags
      if (excludedTags.length > 0) {
        products = products.filter(p => {
          const productTags = p.tags || [];
          return !excludedTags.some(excludedTag => 
            productTags.some(tag => tag.toLowerCase() === excludedTag.toLowerCase())
          );
        });
        console.log("[App Proxy] After tag filter:", products.length, "products");
      }

      // Deduplicate by handle (in case collections overlap)
      const seen = new Set<string>();
      products = products.filter(p => {
        if (seen.has(p.handle)) return false;
        seen.add(p.handle);
        return true;
      });

      // Create baseProducts set (filters that should NEVER relax)
      const baseProducts = products; // after status + excludedTags (+ dedupe) are applied

      const relaxNotes: string[] = [];

      let filteredProducts = [...baseProducts];

      // Apply inStockOnly (experience setting)
      if (experience.inStockOnly) {
        filteredProducts = filteredProducts.filter(p => p.available);
      }

      // Apply budget (derived from answers)
      const hadBudget = typeof priceMin === "number" || typeof priceMax === "number";
      if (hadBudget) {
        filteredProducts = filteredProducts.filter(p => {
          const price = p.priceAmount ? parseFloat(String(p.priceAmount)) : (p.price ? parseFloat(String(p.price)) : NaN);
          if (!Number.isFinite(price)) return true; // don't drop unknown prices
          if (typeof priceMin === "number" && price < priceMin) return false;
          if (typeof priceMax === "number" && price > priceMax) return false;
          return true;
        });
      }

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
      let userIntent = "";
      if (Array.isArray(answers)) {
        // Filter out empty/null answers and preserve meaningful context
        const meaningfulAnswers = answers
          .filter(a => a !== null && a !== undefined && String(a).trim().length > 0)
          .map(a => String(a).trim());
        
        // Join with better separators to preserve context
        // Use ". " for natural flow instead of "; " which can feel mechanical
        userIntent = meaningfulAnswers.join(". ").trim();
        
        // If we have multiple answers, add context connectors for better AI understanding
        if (meaningfulAnswers.length > 1) {
          // The userIntent now flows naturally: "Answer 1. Answer 2. Answer 3"
          // This helps AI understand the full context better
        }
      } else if (typeof answers === "string") {
        userIntent = answers.trim();
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
      
      // LAYER 1: Description Enrichment
      // Build enriched candidates with normalized text and search tokens
      console.log("[App Proxy] [Layer 1] Building enriched candidates with description data");
      let allCandidates = filteredProducts.map(p => {
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
        available: p.available,
        sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
        colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
        materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
        optionValues: (p as any).optionValues ?? {},
        };
      });
      
      // Build searchText for each candidate
      type EnrichedCandidate = typeof allCandidates[0] & { searchText: string };
      const enrichedCandidates: EnrichedCandidate[] = allCandidates.map(c => {
        const searchText = buildSearchText({
          title: c.title,
          productType: c.productType,
          vendor: c.vendor,
          tags: c.tags,
          optionValues: c.optionValues,
          sizes: c.sizes,
          colors: c.colors,
          materials: c.materials,
          desc1000: c.desc1000,
        });
        return {
          ...c,
          searchText,
        } as EnrichedCandidate;
      });
      // Use enrichedCandidates for all subsequent operations
      let allCandidatesEnriched: EnrichedCandidate[] = enrichedCandidates;
      
      // Tokenize all candidates for indexing
      const candidateDocs = enrichedCandidates.map(c => ({
        candidate: c,
        tokens: tokenize(c.searchText),
      }));
      
      console.log("[App Proxy] [Layer 1] Enriched", candidateDocs.length, "candidates");
      
      // LAYER 2: Intent Parsing + Local Indexing + Gating
      // Parse intent into hard/soft/avoid terms and facets
      console.log("[App Proxy] [Layer 2] Parsing intent and building local index");
      
      // Get variant constraints for intent parsing
      const fromAnswersForIntent = parseConstraintsFromAnswers(answersJson);
      const fromTextForIntent = parseConstraintsFromText(userIntent);
      const variantConstraintsForIntent = mergeConstraints(fromAnswersForIntent, fromTextForIntent);
      
      // Parse intent (will update includeTerms/avoidTerms)
      const intentParse = parseIntentGeneric(userIntent, answersJson, variantConstraintsForIntent);
      const { hardTerms, softTerms, avoidTerms, hardFacets } = intentParse;
      
      // Parse bundle intent
      const bundleIntent = parseBundleIntentGeneric(userIntent);
      console.log("[Bundle] detected:", bundleIntent.isBundle, "items:", bundleIntent.items.length, "totalBudget:", bundleIntent.totalBudget);
      
      // For bundle/hard-term queries that require AI ranking, process asynchronously to avoid timeouts
      // Check if we need async processing (bundle queries or queries with hard terms that will use AI)
      const willUseAI = bundleIntent.isBundle === true || hardTerms.length > 0;
      
      // Allocate budget per item if total budget provided
      type BundleItemWithBudget = { hardTerms: string[]; quantity: number; budgetMin?: number; budgetMax?: number };
      
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
        rankedCandidatesByItem?: Map<number, EnrichedCandidate[]>
      ): {
        handles: string[];
        trustFallback: boolean;
        budgetExceeded: boolean;
        totalPrice: number;
        chosenPrimaries: Map<number, string>;
      } {
        const handles: string[] = [];
        let trustFallback = false;
        let budgetExceeded = false;
        let totalPrice = 0;
        const chosenPrimaries = new Map<number, string>();
        const used = new Set<string>();
        
        // Helper to get candidate price
        const getPrice = (c: EnrichedCandidate): number => {
          const price = c.price ? parseFloat(String(c.price)) : NaN;
          return Number.isFinite(price) ? price : Infinity;
        };
        
        // Step 1: Select primaries (at least 1 per itemIndex)
        for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
          const pool = itemPools.get(itemIdx) || [];
          if (pool.length === 0) {
            trustFallback = true;
            continue;
          }
          
          const allocatedBudget = allocatedBudgets.get(itemIdx);
          
          // Use ranked candidates if provided, otherwise use pool order
          const candidatesToCheck = rankedCandidatesByItem?.get(itemIdx) || pool;
          
          // Find best candidate within allocated budget
          let selected: EnrichedCandidate | null = null;
          if (allocatedBudget !== undefined && allocatedBudget !== null) {
            // Try to find candidate within allocated budget
            for (const c of candidatesToCheck) {
              if (used.has(c.handle)) continue;
              const price = getPrice(c);
              if (price <= allocatedBudget) {
                selected = c;
                break;
              }
            }
            
            // If none fit, pick cheapest and mark trustFallback
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
            // Check total budget constraint
            if (totalBudget !== null && totalPrice + price > totalBudget) {
              // Can't add primary without exceeding total budget
              budgetExceeded = true;
              trustFallback = true;
            } else {
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += price;
              chosenPrimaries.set(itemIdx, selected.handle);
            }
          }
        }
        
        // Step 2: Fill remaining slots round-robin, respecting budget constraints
        const itemIndices = Array.from({ length: itemCount }, (_, i) => i);
        let roundRobinIdx = 0;
        const handlesByItem = new Map<number, string[]>();
        
        // Initialize handlesByItem with primaries
        for (const [itemIdx, handle] of chosenPrimaries) {
          handlesByItem.set(itemIdx, [handle]);
        }
        
        while (handles.length < requestedCount && roundRobinIdx < 200) {
          const currentItemIdx = itemIndices[roundRobinIdx % itemIndices.length];
          const pool = itemPools.get(currentItemIdx) || [];
          const currentHandles = handlesByItem.get(currentItemIdx) || [];
          const allocatedBudget = allocatedBudgets.get(currentItemIdx);
          
          // Find next candidate that fits budget constraints
          let added = false;
          for (const candidate of pool) {
            if (used.has(candidate.handle)) continue;
            if (handles.length >= requestedCount) break;
            
            const price = getPrice(candidate);
            
            // Check allocated budget constraint
            if (allocatedBudget !== undefined && allocatedBudget !== null) {
              const remainingAllocated = allocatedBudget - (currentHandles.reduce((sum, h) => {
                const c = pool.find(p => p.handle === h);
                return sum + (c ? getPrice(c) : 0);
              }, 0));
              if (price > remainingAllocated) {
                continue; // Skip this candidate
              }
            }
            
            // Check total budget constraint
            if (totalBudget !== null && totalPrice + price > totalBudget) {
              // Can't add without exceeding total budget
              budgetExceeded = true;
              break; // Stop trying to add more
            }
            
            // Add candidate
            handles.push(candidate.handle);
            used.add(candidate.handle);
            totalPrice += price;
            if (!handlesByItem.has(currentItemIdx)) {
              handlesByItem.set(currentItemIdx, []);
            }
            handlesByItem.get(currentItemIdx)!.push(candidate.handle);
            added = true;
            break;
          }
          
          // If we couldn't add any candidate and we're under requestedCount, try cheapest remaining
          if (!added && handles.length < requestedCount && totalBudget === null) {
            // No total budget constraint, try cheapest from any pool
            let cheapest: { candidate: EnrichedCandidate; itemIdx: number } | null = null;
            for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
              const pool = itemPools.get(itemIdx) || [];
              for (const c of pool) {
                if (used.has(c.handle)) continue;
                const price = getPrice(c);
                if (!cheapest || price < getPrice(cheapest.candidate)) {
                  cheapest = { candidate: c, itemIdx };
                }
              }
            }
            
            if (cheapest) {
              handles.push(cheapest.candidate.handle);
              used.add(cheapest.candidate.handle);
              totalPrice += getPrice(cheapest.candidate);
              if (!handlesByItem.has(cheapest.itemIdx)) {
                handlesByItem.set(cheapest.itemIdx, []);
              }
              handlesByItem.get(cheapest.itemIdx)!.push(cheapest.candidate.handle);
            } else {
              break; // No more candidates available
            }
          }
          
          roundRobinIdx++;
          if (roundRobinIdx > 200) break;
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
        bundleItemsWithBudget: Array<{ hardTerms: string[]; quantity: number }>,
        inStockOnly: boolean,
        experience: any
      ): {
        handles: string[];
        trustFallback: boolean;
        budgetExceeded: boolean;
        totalPrice: number;
        pass1Added: number;
        pass2Added: number;
        pass3Added: number;
      } {
        const used = new Set<string>(existingHandles);
        const handles = [...existingHandles];
        let trustFallback = false;
        let budgetExceeded = false;
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
            
            // Filter candidates: available if needed, within allocated budget, within total budget
            const candidates = pool
              .filter(c => !used.has(c.handle))
              .filter(c => isAvailable(c))
              .filter(c => {
                const price = getPrice(c);
                if (allocatedBudget !== undefined && allocatedBudget !== null) {
                  if (price > allocatedBudget) return false;
                }
                if (totalBudget !== null) {
                  if (totalPrice + price > totalBudget) return false;
                }
                return true;
              })
              .sort((a, b) => getPrice(a) - getPrice(b)); // cheapest first
            
            if (candidates.length > 0) {
              const selected = candidates[0];
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += getPrice(selected);
              pass1Added++;
              added = true;
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
                if (totalBudget !== null) {
                  if (totalPrice + price > totalBudget) return false;
                }
                return true;
              })
              .sort((a, b) => getPrice(a) - getPrice(b));
            
            if (candidates.length > 0) {
              const selected = candidates[0];
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += getPrice(selected);
              pass2Added++;
              added = true;
              break;
            }
          }
          
          if (!added) break;
        }
        
        // PASS 3: Relaxed substitutes (allow substitutes, but try to stay within budget)
        // Only proceed if we still need more items AND haven't exceeded budget too much
        // If budget is already exceeded by >50%, stop adding more items
        const budgetExceededThreshold = totalBudget !== null ? totalBudget * 1.5 : Infinity;
        const shouldContinuePass3 = handles.length < requestedCount && 
          (totalBudget === null || totalPrice <= budgetExceededThreshold);
        
        if (shouldContinuePass3) {
          // Build substitute pools
          const substituteMap = new Map<number, string[]>(); // itemIdx -> substitute terms
          for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
            const item = bundleItemsWithBudget[itemIdx];
            const mainTerm = item.hardTerms[0]?.toLowerCase() || "";
            const substitutes: string[] = [];
            
            // Define substitutes
            if (mainTerm.includes("blazer") || mainTerm.includes("outerwear")) {
              substitutes.push("jacket", "coat", "waistcoat");
            }
            if (mainTerm.includes("trouser")) {
              substitutes.push("pant", "chino");
            }
            if (mainTerm.includes("shirt")) {
              substitutes.push("dress shirt", "button-up", "formal shirt");
            }
            if (mainTerm.includes("suit")) {
              // Only allow tuxedo if wedding/formal intent (check userIntent later, for now skip)
              // substitutes.push("tuxedo");
            }
            
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
          
          while (handles.length < requestedCount && (totalBudget === null || totalPrice <= budgetExceededThreshold)) {
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
            
            // Try to respect totalBudget first
            const withinBudget = candidates.filter(c => {
              const price = getPrice(c);
              if (totalBudget !== null) {
                return totalPrice + price <= totalBudget;
              }
              return true;
            });
            
            // Prefer within-budget candidates, but if none exist, use cheapest to minimize excess
            let selected: EnrichedCandidate | null = null;
            if (withinBudget.length > 0) {
              selected = withinBudget[0]; // Already sorted by price (cheapest first)
            } else if (candidates.length > 0) {
              // No within-budget candidates - use cheapest to minimize budget excess
              selected = candidates[0]; // Already sorted by price
              if (totalBudget !== null) {
                budgetExceeded = true;
                trustFallback = true;
              }
            }
            
            if (selected) {
              const price = getPrice(selected);
              if (totalBudget !== null && totalPrice + price > totalBudget) {
                budgetExceeded = true;
                trustFallback = true;
              }
              
              handles.push(selected.handle);
              used.add(selected.handle);
              totalPrice += price;
              pass3Added++;
              added = true;
              break;
            }
          }
          
            if (!added) break;
          }
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
      
      const bundleItemsWithBudget: BundleItemWithBudget[] = bundleIntent.isBundle && bundleIntent.totalBudget
        ? allocateBudgetPerItem(bundleIntent.items, bundleIntent.totalBudget)
        : bundleIntent.items.map(item => ({ ...item }));
      
      if (bundleIntent.isBundle) {
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
      
      // Calculate BM25 scores and apply gating
      console.log("[App Proxy] [Layer 2] Applying hard gating");
      
      // Gate 1: Hard facets (size/color/material must match)
      let gatedCandidates: EnrichedCandidate[] = allCandidatesEnriched.filter(c => {
        if (hardFacets.size && c.sizes.length > 0) {
          const sizeMatch = c.sizes.some((s: string) => 
            normalizeText(s) === normalizeText(hardFacets.size) ||
            normalizeText(s).includes(normalizeText(hardFacets.size)) ||
            normalizeText(hardFacets.size).includes(normalizeText(s))
          );
          if (!sizeMatch) return false;
        }
        if (hardFacets.color && c.colors.length > 0) {
          const colorMatch = c.colors.some((col: string) => 
            normalizeText(col) === normalizeText(hardFacets.color) ||
            normalizeText(col).includes(normalizeText(hardFacets.color)) ||
            normalizeText(hardFacets.color).includes(normalizeText(col))
          );
          if (!colorMatch) return false;
        }
        if (hardFacets.material && c.materials.length > 0) {
          const materialMatch = c.materials.some((m: string) => 
            normalizeText(m) === normalizeText(hardFacets.material) ||
            normalizeText(m).includes(normalizeText(hardFacets.material)) ||
            normalizeText(hardFacets.material).includes(normalizeText(m))
          );
          if (!materialMatch) return false;
        }
        return true;
      });
      
      console.log("[App Proxy] [Layer 2] After facet gating:", gatedCandidates.length, "candidates");
      
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
      
      // Special boost terms for fashion/apparel (detected from user intent)
      // These provide additional matching signals when present in user queries
      const boostTerms = new Set<string>();
      const lowerIntent = userIntent.toLowerCase();
      if (/\b(3\s*piece|three\s*piece)\b/i.test(lowerIntent)) {
        boostTerms.add("3 piece");
        boostTerms.add("three piece");
      }
      if (/\bwaistcoat\b/i.test(lowerIntent)) {
        boostTerms.add("waistcoat");
      }
      
      // Gate 2: Hard terms (must match at least one hard term if hard terms exist)
      // Use word-boundary matching on normalized text (title/productType/tags/descPlain), not substring
      let trustFallback = false;
      const strictGate: EnrichedCandidate[] = [];
      
      if (hardTerms.length > 0) {
        // Build normalized haystack: title + productType + tags.join(" ") + vendor + searchText
        for (const candidate of gatedCandidates) {
          // Combine fields into single normalized haystack for word-boundary matching
          const haystack = [
            candidate.title || "",
            candidate.productType || "",
            (candidate.tags || []).join(" "),
            candidate.vendor || "",
            candidate.searchText || "",
          ].join(" ");
          
          // Check hard terms with word-boundary matching (not substring/token matching)
          // Multi-word terms are matched as phrases, single-word terms use word boundaries
          const hasHardTermMatch = hardTerms.some(phrase => matchesHardTermWithBoundary(haystack, phrase));
          
          // Also check boost terms (if user intent suggests them)
          const hasBoostTerm = Array.from(boostTerms).some(term => matchesHardTermWithBoundary(haystack, term));
          
          if (hasHardTermMatch || hasBoostTerm) {
            strictGate.push(candidate);
          }
        }
        
        console.log("[App Proxy] [Layer 2] Strict gate (hard terms + facets):", strictGate.length, "candidates");
        
        // Check if strict gate meets minimum requirements
        const minRequired = Math.max(MIN_CANDIDATES_FOR_AI, finalResultCount * 2);
        if (strictGate.length >= minRequired || strictGate.length >= MIN_CANDIDATES_FOR_AI) {
          gatedCandidates = strictGate;
          console.log("[App Proxy] [Layer 2] Using strict gate");
        } else {
          // Relax: broaden hard term matching (still using word-boundary, but allow partial word matches)
          console.log("[App Proxy] [Layer 2] Strict gate too small, broadening...");
          
          // First try: word-boundary matching but allow any word from multi-word phrases
          const broadGate = gatedCandidates.filter(candidate => {
            // Build normalized haystack: title + productType + tags.join(" ") + vendor + searchText
            const haystack = [
              candidate.title || "",
              candidate.productType || "",
              (candidate.tags || []).join(" "),
              candidate.vendor || "",
              candidate.searchText || "",
            ].join(" ");
            
            // For multi-word hard terms, check if any individual word matches with word boundaries
            // For single-word terms, still use word-boundary matching
            return hardTerms.some(phrase => {
              const normalizedPhrase = normalizeText(phrase);
              if (normalizedPhrase.includes(" ")) {
                // Multi-word: check if any word from the phrase matches with word boundaries
                const words = normalizedPhrase.split(/\s+/);
                return words.some(word => matchesHardTermWithBoundary(haystack, word));
              } else {
                // Single-word: use word-boundary matching
                return matchesHardTermWithBoundary(haystack, phrase);
              }
            });
          });
          
          if (broadGate.length >= MIN_CANDIDATES_FOR_AI) {
            gatedCandidates = broadGate;
            relaxNotes.push(`Broadened category matching to find ${broadGate.length} candidates.`);
            console.log("[App Proxy] [Layer 2] Using broad gate (word-boundary matching):", broadGate.length);
          } else {
            // Last resort: trust fallback (allow cross-catalog)
            trustFallback = true;
            relaxNotes.push(`No exact matches found for "${hardTerms.join(", ")}"; showing closest alternatives.`);
            console.log("[App Proxy] [Layer 2] Trust fallback enabled - allowing cross-catalog results");
            // Keep gatedCandidates as-is (already facet-filtered)
          }
        }
      } else {
        // No hard terms, use facet-gated candidates
        console.log("[App Proxy] [Layer 2] No hard terms, using facet-gated candidates");
      }
      
      // Filter avoid terms (penalty/filter)
      if (avoidTerms.length > 0 && !trustFallback) {
        const beforeAvoid = gatedCandidates.length;
        gatedCandidates = gatedCandidates.filter(c => {
          const searchLower = c.searchText.toLowerCase();
          return !avoidTerms.some(avoid => searchLower.includes(avoid.toLowerCase()));
        });
        if (gatedCandidates.length < beforeAvoid) {
          console.log("[App Proxy] [Layer 2] Avoid terms filtered:", gatedCandidates.length, "candidates (from", beforeAvoid, ")");
        }
      }
      
      const strictGateCount = strictGate.length;
      console.log("[App Proxy] [Layer 2] Final gated pool:", gatedCandidates.length, "candidates");
      
      // BUNDLE/HARD-TERM PATH: Continue processing
      // Reduce AI window when no hardTerms (max 60 candidates)
      if (hardTerms.length === 0 && aiWindow > 60) {
        aiWindow = 60;
        console.log("[App Proxy] AI window reduced to 60 (no hardTerms)");
      }
      
      // Pre-rank gated candidates with BM25 + boosts
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
        
        // Boost for special terms (3 piece, waistcoat, etc.)
        for (const boostTerm of boostTerms) {
          if (matchesHardTermWithBoundary(haystack, boostTerm)) {
            score += 1.5; // Boost for related fashion terms
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
        
        // Penalty for avoid terms
        if (avoidTerms.length > 0) {
          const searchLower = c.searchText.toLowerCase();
          const avoidMatches = avoidTerms.filter(avoid => searchLower.includes(avoid.toLowerCase())).length;
          score -= avoidMatches * 1.0;
        }
        
        return { candidate: c, score };
      });
      
      // Sort by score descending
      rankedCandidates.sort((a, b) => b.score - a.score);
      
      // Take top aiWindow candidates for AI
      const topCandidates = rankedCandidates.slice(0, aiWindow).map(r => r.candidate);
      
      console.log("[App Proxy] [Layer 2] Pre-ranked top", topCandidates.length, "candidates for AI");
      
      // Update allCandidates to use gated pool for AI ranking
      // Store full pool for top-up, but AI only sees gated candidates
      const allCandidatesForTopUp = allCandidatesEnriched; // Full pool for fallback
      allCandidates = gatedCandidates; // Gated pool for AI (will be typed correctly when used)
      
      // Keep includeTerms for backward compatibility (used in existing code)
      const includeTerms = softTerms;

      // Build variantPreferences with priority (Answers > Text) - needed for AI prompt
      const prefsFromAnswers = parsePreferencesFromAnswers(answersJson, knownOptionNames);
      const prefsFromText = parsePreferencesFromText(userIntent, knownOptionNames);
      const variantPreferences = mergePreferences(prefsFromAnswers, prefsFromText);
      console.log("[App Proxy] Variant preferences:", variantPreferences);

      // Back-compat: keep Patch 2 constraints for display/legacy prompt
      // If you already computed variantConstraints, keep it — but fill blanks from preferences.
      const sizeKey = knownOptionNames.find(n => n.toLowerCase() === "size") ?? null;
      const colorKey = knownOptionNames.find(n => ["color","colour","shade"].includes(n.toLowerCase())) ?? null;
      const materialKey = knownOptionNames.find(n => ["material","fabric"].includes(n.toLowerCase())) ?? null;

      const derived = {
        size: sizeKey ? (variantPreferences[sizeKey] ?? null) : null,
        color: colorKey ? (variantPreferences[colorKey] ?? null) : null,
        material: materialKey ? (variantPreferences[materialKey] ?? null) : null,
      };

      const fromAnswersForVariant = parseConstraintsFromAnswers(answersJson);
      const fromTextForVariant = parseConstraintsFromText(userIntent);
      const variantConstraints = mergeConstraints(fromAnswersForVariant, fromTextForVariant);
      const variantConstraints2 = mergeConstraints(variantConstraints, derived);
      console.log("[App Proxy] Variant constraints:", variantConstraints2);

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
      
      if (bundleIntent.isBundle && bundleIntent.items.length >= 2) {
        // BUNDLE PATH: Handle multi-item queries
        isBundleMode = true;
        console.log("[Bundle] [Layer 3] Processing bundle with", bundleIntent.items.length, "items");
        
        // Gate candidates per item
        const itemGatedPools: Array<{ itemIndex: number; candidates: EnrichedCandidate[]; hardTerms: string[] }> = [];
        
        for (let itemIdx = 0; itemIdx < bundleItemsWithBudget.length; itemIdx++) {
          const bundleItem = bundleItemsWithBudget[itemIdx] as BundleItemWithBudget;
          const itemHardTerms = bundleItem.hardTerms;
          
          // Gate candidates for this item using existing gating logic
          // First pass: facet + hard term matching (no budget filter)
          const itemGatedUnfiltered: EnrichedCandidate[] = allCandidatesEnriched.filter(c => {
            // Apply facet gating
            if (hardFacets.size && c.sizes.length > 0) {
              const sizeMatch = c.sizes.some((s: string) => 
                normalizeText(s) === normalizeText(hardFacets.size) ||
                normalizeText(s).includes(normalizeText(hardFacets.size)) ||
                normalizeText(hardFacets.size).includes(normalizeText(s))
              );
              if (!sizeMatch) return false;
            }
            if (hardFacets.color && c.colors.length > 0) {
              const colorMatch = c.colors.some((col: string) => 
                normalizeText(col) === normalizeText(hardFacets.color) ||
                normalizeText(col).includes(normalizeText(hardFacets.color)) ||
                normalizeText(hardFacets.color).includes(normalizeText(col))
              );
              if (!colorMatch) return false;
            }
            if (hardFacets.material && c.materials.length > 0) {
              const materialMatch = c.materials.some((m: string) => 
                normalizeText(m) === normalizeText(hardFacets.material) ||
                normalizeText(m).includes(normalizeText(hardFacets.material)) ||
                normalizeText(hardFacets.material).includes(normalizeText(m))
              );
              if (!materialMatch) return false;
            }
            
            // Apply hard term matching for this item
            const haystack = [
              c.title || "",
              c.productType || "",
              (c.tags || []).join(" "),
              c.vendor || "",
              c.searchText || "",
            ].join(" ");
            
            const hasItemMatch = itemHardTerms.some(term => matchesHardTermWithBoundary(haystack, term));
            if (!hasItemMatch) return false;
            
            return true;
          });
          
          // Second pass: apply budget filter if allocated
          let itemGated: EnrichedCandidate[] = itemGatedUnfiltered;
          if (bundleItem.budgetMax !== undefined && bundleItem.budgetMax !== null) {
            const budgetMax = bundleItem.budgetMax;
            const itemGatedFiltered = itemGatedUnfiltered.filter(c => {
              const price = c.price ? parseFloat(String(c.price)) : NaN;
              return !Number.isFinite(price) || price <= budgetMax;
            });
            
            // If filtered pool is empty, keep unfiltered but mark for trustFallback
            if (itemGatedFiltered.length > 0) {
              itemGated = itemGatedFiltered;
            } else {
              itemGated = itemGatedUnfiltered;
              // Will set trustFallback later if needed
            }
          }
          
          // Pre-rank with BM25 for this item
          const itemTokens = itemHardTerms.flatMap(t => tokenize(t));
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
          // Reduced from 30 to 20 per item for speed (max 60 total for 3 items)
          const topK = Math.min(bundlePerItemWindow, itemRanked.length);
          const topCandidatesForItem = itemRanked.slice(0, topK).map(r => r.candidate);
          
          itemGatedPools.push({
            itemIndex: itemIdx,
            candidates: topCandidatesForItem,
            hardTerms: itemHardTerms,
          });
          
          console.log("[Bundle] item", itemIdx, `(${itemHardTerms[0]})`, "gated:", topCandidatesForItem.length, "candidates");
        }
        
        // Combine all item candidates for AI (with itemIndex metadata)
        const allBundleCandidates = itemGatedPools.flatMap(pool => 
          pool.candidates.map(c => ({ ...c, _bundleItemIndex: pool.itemIndex, _bundleHardTerms: pool.hardTerms }))
        ) as any[];
        
        console.log("[Bundle] total candidates for AI:", allBundleCandidates.length);
      
      // Use pre-ranked top candidates (already sorted by BM25 + boosts)
        sortedCandidates = allBundleCandidates;
        
        console.log("[App Proxy] [Layer 3] Sending", sortedCandidates.length, "bundle candidates to AI");
      } else {
        // SINGLE-ITEM PATH: Existing logic (unchanged)
        // Use pre-ranked top candidates (already sorted by BM25 + boosts)
        sortedCandidates = topCandidates;
      
      console.log("[App Proxy] [Layer 3] Sending", sortedCandidates.length, "pre-ranked candidates to AI");
      }

      // AI pass #1 + Top-up passes (no extra charge)
      const targetCount = Math.min(finalResultCount, sortedCandidates.length);

      let finalHandles: string[] = [];
      let reasoningParts: string[] = [];

      // helper to get next window excluding already used handles
      function buildWindow(offset: number, used: Set<string>) {
        const windowSlice = sortedCandidates.slice(offset, offset + aiWindow);
        return windowSlice.filter(c => !used.has(c.handle));
      }

      // PASS 1 (first window)
      let used = new Set<string>();
      let offset = 0;

      // Bundle handling: use AI bundle ranking
      if (isBundleMode && bundleIntent.items.length >= 2) {
        console.log("[Bundle] Using AI bundle ranking");
        
        // For bundle mode, pass ALL candidates (don't use aiWindow cap)
        // The candidates are already capped per-item (30 each) during gating
        const bundleCandidatesForAI = sortedCandidates.filter(c => !used.has(c.handle));
        console.log("[Bundle] aiCandidatesSent=", bundleCandidatesForAI.length);
        
        // Convert hardFacets to array format for AI prompt
        const hardFacetsForAI: { size?: string[]; color?: string[]; material?: string[] } = {};
        if (hardFacets.size) hardFacetsForAI.size = [hardFacets.size];
        if (hardFacets.color) hardFacetsForAI.color = [hardFacets.color];
        if (hardFacets.material) hardFacetsForAI.material = [hardFacets.material];
        
        try {
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
            }
          );
          
          if (aiBundle.rankedHandles?.length) {
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
            for (const handle of aiBundle.rankedHandles) {
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
            
            // Use budget-aware selection helper
            const selectionResult = selectBundleWithinBudget(
              itemPools,
              allocatedBudgets,
              bundleIntent.totalBudget,
              finalResultCount,
              bundleItemsWithBudget.length,
              rankedCandidatesByItem
            );
            
            finalHandles = selectionResult.handles;
            if (selectionResult.trustFallback) {
              trustFallback = true;
            }
            
            // Log budget selection details
            const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
              .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
            console.log("[Bundle Budget] chosenPrimaries", chosenPrimariesText);
            console.log("[Bundle Budget] finalTotalPrice=", selectionResult.totalPrice.toFixed(2), 
              "finalCount=", finalHandles.length, "trustFallback=", selectionResult.trustFallback,
              "budgetExceeded=", selectionResult.budgetExceeded);
            
            // Build reasoning - prioritize AI's human-like reasons from aiBundle.reasoning
            let reasoningText = "";
            if (aiBundle.reasoning && aiBundle.reasoning.trim()) {
              // Use AI's human-like reasoning as primary source
              reasoningText = aiBundle.reasoning.trim();
              
              // Add budget context if needed (but keep it natural)
              if (selectionResult.budgetExceeded || (bundleIntent.totalBudget && selectionResult.totalPrice > bundleIntent.totalBudget)) {
                const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
                // Only add budget note if AI reasoning doesn't already mention it
                if (!reasoningText.toLowerCase().includes('budget') && !reasoningText.toLowerCase().includes('$')) {
                  reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options. ${reasoningText}`;
                }
              }
            } else {
              // Fallback to generic reasoning if AI didn't provide reasons
              const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
              const budgetText = bundleIntent.totalBudget ? ` under $${bundleIntent.totalBudget}` : "";
              
              reasoningText = `Built a bundle: ${itemNames}${budgetText}.`;
              if (selectionResult.budgetExceeded || (bundleIntent.totalBudget && selectionResult.totalPrice > bundleIntent.totalBudget)) {
                reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options.`;
              }
            }
            
            // Add delivered vs requested count to reasoning (will be finalized after top-up)
            const deliveredAfterAI = finalHandles.length;
            if (deliveredAfterAI < finalResultCount) {
              reasoningText += ` Showing ${deliveredAfterAI} results (requested ${finalResultCount}).`;
            }
            
            reasoningParts.push(reasoningText);
            console.log("[Bundle] AI returned", aiBundle.rankedHandles.length, "handles with reasoning:", aiBundle.reasoning ? "present" : "missing", "final after budget-aware selection:", finalHandles.length);
          } else {
            // Fallback to deterministic selection if AI fails
            console.log("[Bundle] AI failed, using deterministic fallback");
            
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
              bundleItemsWithBudget.length
            );
            
            finalHandles = selectionResult.handles;
            if (selectionResult.trustFallback) {
              trustFallback = true;
            }
            
            // Log budget selection details
            const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
              .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
            console.log("[Bundle Budget] chosenPrimaries", chosenPrimariesText);
            console.log("[Bundle Budget] finalTotalPrice=", selectionResult.totalPrice.toFixed(2), 
              "finalCount=", finalHandles.length, "trustFallback=", selectionResult.trustFallback,
              "budgetExceeded=", selectionResult.budgetExceeded);
            
            const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
            const budgetText = bundleIntent.totalBudget ? ` under $${bundleIntent.totalBudget}` : "";
            
            // Build improved reasoning
            let reasoningText = `Built a bundle: ${itemNames}${budgetText}.`;
            if (selectionResult.budgetExceeded || (bundleIntent.totalBudget && selectionResult.totalPrice > bundleIntent.totalBudget)) {
              reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options.`;
            }
            
            reasoningParts.push(reasoningText);
          }
        } catch (error) {
          console.error("[Bundle] AI ranking error:", error);
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
            bundleItemsWithBudget.length
          );
          
          finalHandles = selectionResult.handles;
          if (selectionResult.trustFallback) {
            trustFallback = true;
          }
          
          // Log budget selection details
          const chosenPrimariesText = Array.from(selectionResult.chosenPrimaries.entries())
            .map(([idx, handle]) => `item${idx}=${handle}`).join(" ");
          console.log("[Bundle Budget] chosenPrimaries", chosenPrimariesText);
          console.log("[Bundle Budget] finalTotalPrice=", selectionResult.totalPrice.toFixed(2), 
            "finalCount=", finalHandles.length, "trustFallback=", selectionResult.trustFallback,
            "budgetExceeded=", selectionResult.budgetExceeded);
          
          const itemNames = bundleItemsWithBudget.map(item => item.hardTerms[0]).join(" + ");
          const budgetText = bundleIntent.totalBudget ? ` under $${bundleIntent.totalBudget}` : "";
          
          // Build improved reasoning
          let reasoningText = `Built a bundle: ${itemNames}${budgetText}.`;
          if (selectionResult.budgetExceeded || (bundleIntent.totalBudget && selectionResult.totalPrice > bundleIntent.totalBudget)) {
            reasoningText = `Found matching categories (${itemNames}), but couldn't meet the $${bundleIntent.totalBudget} total budget; showing closest-priced options.`;
          }
          
          reasoningParts.push(reasoningText);
        }
        
        console.log("[Bundle] selected", finalHandles.length, "handles across", bundleItemsWithBudget.length, "items");
        console.log("[Bundle] trustFallback=", trustFallback);
      } else {
        // SINGLE-ITEM PATH: Existing AI ranking logic
      const window1 = buildWindow(offset, used);
      
      // Convert hardFacets to array format for AI prompt
      const hardFacetsForAI: { size?: string[]; color?: string[]; material?: string[] } = {};
      if (hardFacets.size) hardFacetsForAI.size = [hardFacets.size];
      if (hardFacets.color) hardFacetsForAI.color = [hardFacets.color];
      if (hardFacets.material) hardFacetsForAI.material = [hardFacets.material];
      
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
        }
      );

      if (ai1.rankedHandles?.length) {
        // Filter cached handles against current product availability
        // This ensures out-of-stock products from cache are excluded
        const validHandles = ai1.rankedHandles.filter((handle: string) => {
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
        reasoningParts.push(ai1.reasoning);
        
        // Log if any cached handles were filtered out
        if (validHandles.length < ai1.rankedHandles.length) {
          const filteredCount = ai1.rankedHandles.length - validHandles.length;
          console.log(`[App Proxy] Filtered ${filteredCount} out-of-stock/unavailable products from cache`);
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

      // TOP-UP PASSES (skip for bundle mode - handled separately)
      if (!isBundleMode) {
      let pass = 2;
      while (finalHandles.length < targetCount && pass <= MAX_AI_PASSES) {
        offset += aiWindow;
        const missing = targetCount - finalHandles.length;
        const window = buildWindow(offset, used);

        if (window.length === 0) break;

        const aiTopUp = await rankProductsWithAI(
          userIntent,
          window,
          missing,
          shop.id,
          sessionToken, // IMPORTANT: prevents double charge within 5 minutes
          variantConstraints2,
          variantPreferences,
          includeTerms,
          avoidTerms,
          {
            hardTerms,
            hardFacets: Object.keys(hardFacetsForAI).length > 0 ? hardFacetsForAI : undefined,
            avoidTerms,
            trustFallback,
          }
        );

        if (aiTopUp.rankedHandles?.length) {
          // Filter cached handles against current product availability
          const validTopUpHandles = aiTopUp.rankedHandles.filter((handle: string) => {
            const candidate = sortedCandidates.find(c => c.handle === handle);
            if (!candidate) return false;
            // If inStockOnly is enabled, filter out unavailable products
            if (experience.inStockOnly && !candidate.available) return false;
            return true;
          });
          
          let added = 0;
          for (const h of validTopUpHandles) {
            if (!used.has(h) && finalHandles.length < targetCount) {
              used.add(h);
              finalHandles.push(h);
              added++;
            }
          }
          if (added > 0) {
            reasoningParts.push("Expanded search to find additional close matches.");
          }
        }

        pass++;
      }
      } else if (isBundleMode && finalHandles.length < finalResultCount) {
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
      }
      } // End of single-item path else block

      // LAYER 3: Post-validation (validate final handles against hard constraints)
      console.log("[App Proxy] [Layer 3] Validating final handles");
      
      /**
       * Validate final handles against hard constraints (when trustFallback=false)
       */
      function validateFinalHandles(
        handles: string[],
        candidates: EnrichedCandidate[],
        hardTerms: string[],
        hardFacets: { size: string | null; color: string | null; material: string | null },
        trustFallback: boolean
      ): string[] {
        if (trustFallback) {
          // Trust fallback: allow all handles
          return handles;
        }
        
        const validHandles: string[] = [];
        
        for (const handle of handles) {
          const candidate = candidates.find(c => c.handle === handle);
          if (!candidate) continue;
          
          // Check hard facets
          let passesFacets = true;
          if (hardFacets.size && candidate.sizes.length > 0) {
            const sizeMatch = candidate.sizes.some((s: string) => 
              normalizeText(s) === normalizeText(hardFacets.size) ||
              normalizeText(s).includes(normalizeText(hardFacets.size)) ||
              normalizeText(hardFacets.size).includes(normalizeText(s))
            );
            if (!sizeMatch) passesFacets = false;
          }
          if (hardFacets.color && candidate.colors.length > 0 && passesFacets) {
            const colorMatch = candidate.colors.some((col: string) => 
              normalizeText(col) === normalizeText(hardFacets.color) ||
              normalizeText(col).includes(normalizeText(hardFacets.color)) ||
              normalizeText(hardFacets.color).includes(normalizeText(col))
            );
            if (!colorMatch) passesFacets = false;
          }
          if (hardFacets.material && candidate.materials.length > 0 && passesFacets) {
            const materialMatch = candidate.materials.some((m: string) => 
              normalizeText(m) === normalizeText(hardFacets.material) ||
              normalizeText(m).includes(normalizeText(hardFacets.material)) ||
              normalizeText(hardFacets.material).includes(normalizeText(m))
            );
            if (!materialMatch) passesFacets = false;
          }
          
          // Check hard terms (if any) using word-boundary matching on normalized haystack
          if (hardTerms.length > 0 && passesFacets) {
            // Build normalized haystack: title + productType + tags.join(" ") + vendor + searchText
            const haystack = [
              candidate.title || "",
              candidate.productType || "",
              (candidate.tags || []).join(" "),
              candidate.vendor || "",
              candidate.searchText || "",
            ].join(" ");
            
            // Use word-boundary matching for all hard terms (not token matching)
            const hasHardTermMatch = hardTerms.some(phrase => matchesHardTermWithBoundary(haystack, phrase));
            
            // Also check boost terms
            const hasBoostTerm = Array.from(boostTerms).some(term => matchesHardTermWithBoundary(haystack, term));
            
            if (!hasHardTermMatch && !hasBoostTerm) {
              passesFacets = false;
            }
          }
          
          if (passesFacets) {
            validHandles.push(handle);
          }
        }
        
        return validHandles;
      }
      
      // Validate final handles (use enriched candidates)
      let validatedHandles: string[];
      if (isBundleMode && !trustFallback) {
        // Bundle validation: ensure each handle belongs to correct item's pool
        const itemPools = new Map<number, Set<string>>();
        for (const c of sortedCandidates) {
          const itemIdx = (c as any)._bundleItemIndex;
          if (typeof itemIdx === "number") {
            if (!itemPools.has(itemIdx)) {
              itemPools.set(itemIdx, new Set());
            }
            itemPools.get(itemIdx)!.add(c.handle);
          }
        }
        
        validatedHandles = finalHandles.filter(handle => {
          // Check if handle belongs to any item pool
          for (const pool of itemPools.values()) {
            if (pool.has(handle)) return true;
          }
          return false;
        });
        console.log("[Bundle] validated", validatedHandles.length, "handles (all from item pools)");
      } else {
        validatedHandles = validateFinalHandles(finalHandles, gatedCandidates, hardTerms, hardFacets, trustFallback);
      }
      console.log("[App Proxy] [Layer 3] Validated handles:", validatedHandles.length, "out of", finalHandles.length);
      
      // Bundle budget validation
      if (isBundleMode && bundleIntent.totalBudget) {
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

      function topUpHandlesFromGated(
        ranked: string[],
        pool: typeof allCandidates,
        target: number
      ) {
        const have = new Set(ranked);
        const out = ranked.slice();

        for (const p of pool) {
          if (out.length >= target) break;
          if (!p?.handle) continue;
          if (have.has(p.handle)) continue;
          have.add(p.handle);
          out.push(p.handle);
        }

        return out.slice(0, target);
      }

      // Hard guarantee: top-up after AI ranking (intent-safe enforcement)
      let finalHandlesGuaranteed = uniq(validatedHandles);

      // Bundle-safe top-up: only from bundle item pools
      if (isBundleMode && bundleIntent.items.length >= 2) {
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
          console.log("[Bundle] Strict itemPool", itemIdx, `(${itemHardTerms[0]})`, "size:", itemPool.length);
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
          
          // Use 3-pass bundle top-up ladder
          const topUpResult = bundleTopUp3Pass(
            finalHandlesGuaranteed,
            bundleItemPools,
            allocatedBudgets,
            bundleIntent.totalBudget,
            finalResultCount,
            bundleItemsWithBudget,
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
          console.log("[Bundle Budget] top-up finalTotalPrice=", topUpResult.totalPrice.toFixed(2), 
            "finalCount=", finalHandlesGuaranteed.length, "trustFallback=", topUpResult.trustFallback,
            "budgetExceeded=", topUpResult.budgetExceeded);
          
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
        
        console.log("[App Proxy] [Layer 3] Bundle-safe top-up complete:", finalHandlesGuaranteed.length, "handles (requested:", finalResultCount, ")");
      } else {
        // SINGLE-ITEM PATH: Existing top-up logic
      // Enforce intent-safe top-up: when trustFallback=false, ONLY use gated pool
      if (!trustFallback) {
        // Intent-safe: top-up ONLY from gated candidates (no drift allowed)
        if (gatedCandidates.length > 0) {
            finalHandlesGuaranteed = topUpHandlesFromGated(finalHandlesGuaranteed, gatedCandidates, finalResultCount);
        }
        // If still short after gated top-up, return fewer results (better than drift)
          console.log("[App Proxy] [Layer 3] Intent-safe top-up complete:", finalHandlesGuaranteed.length, "handles (requested:", finalResultCount, ")");
      } else {
        // Trust fallback: can use broader pool, but prefer gated first
        if (gatedCandidates.length > 0) {
            finalHandlesGuaranteed = topUpHandlesFromGated(finalHandlesGuaranteed, gatedCandidates, finalResultCount);
        }
        
        // If still short, use broader pool (allCandidatesForTopUp)
          if (finalHandlesGuaranteed.length < finalResultCount && allCandidatesForTopUp.length > 0) {
            finalHandlesGuaranteed = topUpHandlesFromGated(finalHandlesGuaranteed, allCandidatesForTopUp, finalResultCount);
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
            finalHandlesGuaranteed = topUpHandlesFromGated(finalHandlesGuaranteed, baseCandidates, finalResultCount);
          }
        }
      }

      console.log(
        "[App Proxy] Final handles after top-up:",
        finalHandlesGuaranteed.length,
        "requested:",
        finalResultCount
      );

      finalHandles = finalHandlesGuaranteed;

      // Add trust signals to reasoning
      if (!trustFallback && (hardTerms.length > 0 || hardFacets.size || hardFacets.color || hardFacets.material)) {
        const matchParts: string[] = [];
        if (hardTerms.length > 0) {
          matchParts.push(`category: ${hardTerms.join(", ")}`);
        }
        if (hardFacets.size) matchParts.push(`size: ${hardFacets.size}`);
        if (hardFacets.color) matchParts.push(`color: ${hardFacets.color}`);
        if (hardFacets.material) matchParts.push(`material: ${hardFacets.material}`);
        if (matchParts.length > 0) {
          reasoningParts.unshift(`Matched: ${matchParts.join(", ")}.`);
        }
      } else if (trustFallback) {
        const fallbackNote = hardTerms.length > 0
          ? `No exact matches found for "${hardTerms.join(", ")}"; showing closest alternatives.`
          : "No exact matches found; showing closest alternatives.";
        reasoningParts.unshift(fallbackNote);
      }

      // Reasoning header (generic, all industries)
      const prefPairs = Object.entries(variantPreferences).filter(([,v]) => !!v);
      if (prefPairs.length) {
        const text = prefPairs.map(([k,v]) => `${k}=${v}`).join(", ");
        reasoningParts.unshift(`Variant preferences: ${text}.`);
      }
      
      // Add include/avoid terms to reasoning header
      if (includeTerms.length > 0 || avoidTerms.length > 0) {
        const includeText = includeTerms.length > 0 ? `Include: ${includeTerms.join(", ")}` : "";
        const avoidText = avoidTerms.length > 0 ? `Avoid: ${avoidTerms.join(", ")}` : "";
        const keywordText = [includeText, avoidText].filter(Boolean).join(". ");
        if (keywordText) {
          reasoningParts.unshift(keywordText + ".");
        }
      }

      // Ensure result diversity (vendor, type, price variety)
      // This improves user experience by avoiding too many similar products
      // Convert enriched candidates to format expected by ensureResultDiversity
      const candidatesForDiversity = gatedCandidates.map(c => ({
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
      const diverseHandles = ensureResultDiversity(
        finalHandlesGuaranteed.slice(0, targetCount),
        candidatesForDiversity,
        finalResultCount
      );
      console.log("[App Proxy] After diversity check:", diverseHandles.length, "handles (was", finalHandlesGuaranteed.slice(0, targetCount).length, ")");

      // Final reasoning string (include relaxation notes)
      const notes = [...relaxNotes];
      let reasoning = [...notes, ...reasoningParts].filter(Boolean).join(" ");
      const finalHandlesArray = Array.isArray(finalHandlesGuaranteed) ? finalHandlesGuaranteed : [];
      productHandles = (Array.isArray(diverseHandles) ? diverseHandles : finalHandlesArray).slice(0, targetCount);
      
      // Add delivered vs requested count to reasoning
      const deliveredCountAtReasoning = productHandles.length;
      const requestedCountAtReasoning = targetCount;
      const isBundleModeForReasoning = bundleIntent?.isBundle === true;
      
      if (deliveredCountAtReasoning < requestedCountAtReasoning) {
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
        reasoning += ` Showing ${deliveredCountAtReasoning} results (requested ${requestedCountAtReasoning}). ${whyFewer}`;
      } else if (deliveredCountAtReasoning === requestedCountAtReasoning && relaxNotes.some(n => n.includes("exceed") || n.includes("Exceed") || n.includes("relaxed"))) {
        // Budget was exceeded in pass 3
        reasoning += ` Showing ${deliveredCountAtReasoning} results (requested ${requestedCountAtReasoning}). Budget was relaxed to show more options.`;
      }

      console.log("[App Proxy] Final product handles:", productHandles.length, "out of", targetCount, "requested");
      
      // Generate helpful suggestions if no results
      let finalReasoning = reasoning;
      if (productHandles.length === 0) {
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
      
      // Guard: finalHandles must be defined and an array before saving
      if (finalHandles === undefined || !Array.isArray(finalHandles)) {
        const errorMsg = `[App Proxy] FATAL: finalHandles is undefined or not an array. Cannot save or mark COMPLETE. finalHandles=${finalHandles}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // Ensure productHandles is always an array before saving
      const finalHandlesToSave = Array.isArray(productHandles) ? productHandles : [];
      
      // Double-check: if finalHandlesToSave is empty but finalHandles has items, use finalHandles
      const handlesToSave = finalHandlesToSave.length > 0 ? finalHandlesToSave : (Array.isArray(finalHandles) ? finalHandles.slice(0, targetCount) : []);
      const deliveredCount = handlesToSave.length;
      const requestedCount = finalResultCount;
      const billedCount = handlesToSave.length;
      
      console.log("[App Proxy] Saving: requested=", requestedCount, "delivered=", deliveredCount, "billedCount=", billedCount, "handlesPreview=", handlesToSave.slice(0, 5));
      
      // Save results and mark session as COMPLETE (ONLY AFTER finalHandles is computed)
      await saveConciergeResult({
        sessionToken,
        productHandles: handlesToSave,
        productIds: null,
        reasoning: handlesToSave.length > 0 
          ? reasoning
          : finalReasoning,
      });

      console.log("[App Proxy] Results saved, session marked COMPLETE. billedCount=", billedCount);

      // Log 3-layer pipeline metrics
      console.log("[App Proxy] [Metrics] Strict gate:", strictGateCount || 0, "| AI window:", aiWindow, "| Trust fallback:", trustFallback, "| Hard terms:", hardTerms.length, "| Gated pool:", gatedCandidates.length);

      // Charge session based on delivered results, not requested (ONLY AFTER saving)
      // NOTE: Credits are charged regardless of cache hit/miss - you're paying for the ranking service, not the OpenAI API call
      const credits = creditsForDeliveredCount(billedCount);
      
      if (billedCount === 0) {
        console.log("[Billing] Skipping charge: billedCount=0");
      } else {
        try {
          // Charge based on billedCount (delivered count)
          chargeResult = await chargeConciergeSessionOnce({
            sessionToken,
            shopId: shop.id,
            resultCount: billedCount, // Use delivered count for billing
            experienceId: experience.id,
          });
          console.log("[Billing] requested=", requestedCount, "delivered=", deliveredCount, "billedCount=", billedCount, "credits=", credits, "sid=", sessionToken, "experienceId=", experienceIdUsed);
          console.log("[App Proxy] Session charged for", deliveredCount, "delivered results, overage delta:", chargeResult.overageCreditsX2Delta);

          // Handle overage charges if any
          if (chargeResult.overageCreditsX2Delta > 0) {
            try {
              // Convert x2 units to credits
              const overageCredits = chargeResult.overageCreditsX2Delta / 2;
              const overageAmountUsd = overageCredits * entitlements.overageRatePerCredit;
              
              // Check if overage would exceed cap (best-effort check using cached balanceUsed)
              // Note: balanceUsed may be stale, but this prevents obvious cap violations
              const { getActiveCharge } = await import("~/models/shopify-billing.server");
              try {
                // Try to get access token for shop (for app proxy context)
                let accessToken: string | undefined;
                try {
                  const token = await getAccessTokenForShop(shopDomain);
                  accessToken = token || undefined;
                } catch (tokenError) {
                  // No access token available - skip cap check (non-fatal)
                  console.log("[App Proxy] No access token for overage cap check, skipping (non-fatal)");
                }
                
                // Only check cap if we have an access token
                if (accessToken) {
                  const activeCharge = await getActiveCharge(shopDomain, { accessToken });
                  if (activeCharge?.usageCapAmountUsd && activeCharge?.usageBalanceUsedUsd !== null) {
                    const projectedBalance = activeCharge.usageBalanceUsedUsd + overageAmountUsd;
                    if (projectedBalance > activeCharge.usageCapAmountUsd) {
                      // Cap would be exceeded - block the request
                      console.warn("[Billing] Overage charge would exceed cap", {
                        currentBalance: activeCharge.usageBalanceUsedUsd,
                        cap: activeCharge.usageCapAmountUsd,
                        overageAmount: overageAmountUsd,
                        projected: projectedBalance,
                      });
                      // Delete the session results since billing would fail
                      await saveConciergeResult({
                        sessionToken,
                        productHandles: [],
                        productIds: null,
                        reasoning: "Usage cap reached. Please contact support or wait for the next billing cycle.",
                      });
                      // Mark session as ERROR (don't return Response - we're in async callback)
                      await prisma.conciergeSession.update({
                        where: { publicToken: sessionToken },
                        data: { status: ConciergeSessionStatus.FAILED },
                      }).catch(() => {});
                      // Mark session as failed - will be handled by outer catch
                      throw new Error("Usage cap reached. Please contact support or wait for the next billing cycle.");
                    }
                  }
                }
              } catch (capCheckError) {
                // Non-fatal: if we can't check the cap, proceed anyway (cap check is best-effort)
                // Log but don't throw - this should never block the request
                console.warn("[Billing] Could not check usage cap (non-fatal, proceeding):", capCheckError instanceof Error ? capCheckError.message : String(capCheckError));
                console.warn("[Billing] Could not check usage cap, proceeding:", capCheckError);
              }
              
              // Note: No admin session in app proxy context - will use offline token fallback
              await createOverageUsageCharge({
                shopDomain,
                overageCredits,
                overageRate: entitlements.overageRatePerCredit,
                sessionPublicToken: sessionToken,
                // opts not provided - will fallback to offline session token
              });
              console.log("[App Proxy] Overage charge created for", overageCredits, "credits");
            } catch (error) {
              console.warn("[Billing] Overage usage charge failed", { 
                shop: shopDomain, 
                sid: sessionToken, 
                err: String(error) 
              });
              // If overage charge fails due to cap being reached, return error to user
              const errorMessage = error instanceof Error ? error.message : String(error);
              if (errorMessage.includes("capped") || errorMessage.includes("cap") || errorMessage.includes("limit") || errorMessage.includes("exceeded")) {
                // Delete the session results since billing failed
                await saveConciergeResult({
                  sessionToken,
                  productHandles: [],
                  productIds: null,
                  reasoning: "Usage cap reached. Please contact support or wait for the next billing cycle.",
                });
                // Mark session as ERROR (don't return Response - we're in async callback)
                await prisma.conciergeSession.update({
                  where: { publicToken: sessionToken },
                  data: { status: ConciergeSessionStatus.FAILED },
                }).catch(() => {});
                // Mark session as failed - will be handled by outer catch
                throw new Error(errorMessage);
              }
              // Never throw for other overage errors - this should not fail the request
            }
          }
        } catch (error) {
          console.error("[App Proxy] Error charging session:", error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          // If subscription is cancelled or trial expired, return error to user
          if (errorMessage.includes("cancelled") || errorMessage.includes("subscribe")) {
            // Delete the session results since billing failed
            await saveConciergeResult({
              sessionToken,
              productHandles: [],
              productIds: null,
              reasoning: errorMessage,
            });
            // Mark session as ERROR (don't return Response - we're in async callback)
            await prisma.conciergeSession.update({
              where: { publicToken: sessionToken },
              data: { status: ConciergeSessionStatus.FAILED },
            }).catch(() => {});
            // Mark session as failed and return error response
            return Response.json({
              ok: false,
              error: errorMessage,
              sid: sessionToken,
            }, { status: 403 });
          }
          
          // For other billing errors, still return success but log the error
          // (This allows the session to complete even if billing tracking fails)
          console.warn("[App Proxy] Billing error (non-blocking):", errorMessage);
        }
    }
  } else {
    console.log("[App Proxy] No access token available - skipping product fetch");

    // Save empty results if no access token
  await saveConciergeResult({
    sessionToken,
      productHandles: [],
    productIds: null,
      reasoning: "No products available. Please ensure the app is installed and products exist.",
  });
        
        // Mark session as ERROR
        await prisma.conciergeSession.update({
          where: { publicToken: sessionToken },
          data: { status: ConciergeSessionStatus.FAILED },
        }).catch(() => {});
      }
    } catch (error: any) {
    console.error("[App Proxy] Processing failed:", error);
    // Mark session as ERROR
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
    
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Error processing request. Please try again.",
      sid: sessionToken,
    }, { status: 500 });
  }
  
  // Return success with session ID (results are saved, frontend can poll /session endpoint)
  return Response.json({
    ok: true,
    sid: sessionToken,
    sessionId: sessionToken, // Keep for backward compatibility
    status: "COMPLETE",
    resultCount: finalResultCount,
  });
}

