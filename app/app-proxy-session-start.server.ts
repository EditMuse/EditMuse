import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";
import { createConciergeSession, saveConciergeResult } from "~/models/concierge.server";
import { getAccessTokenForShop, fetchShopifyProducts } from "~/shopify-admin.server";
import { rankProductsWithAI, fallbackRanking } from "~/models/ai-ranking.server";
import { ConciergeSessionStatus } from "@prisma/client";
import { trackUsageEvent, chargeConciergeSessionOnce, getEntitlements } from "~/models/billing.server";
import { createOverageUsageCharge } from "~/models/shopify-billing.server";

type UsageEventType = "SESSION_STARTED" | "AI_RANKING_EXECUTED";

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

  // Material parsing (conservative)
  const materials = ["cotton","linen","silk","wool","leather","denim","polyester","viscose","nylon","cashmere"];
  let material: string | null = null;
  for (const m of materials) {
    const re = new RegExp(`\\b${m}\\b`, "i");
    if (re.test(text)) { material = m[0].toUpperCase() + m.slice(1); break; }
  }

  return { size, color, material };
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
  console.log(`[App Proxy] GET ${routePath}`);
  console.log("[App Proxy] Request method:", request.method);
  console.log("[App Proxy] Request URL:", request.url);
  console.log("[App Proxy] Request pathname:", new URL(request.url).pathname);
  
  return Response.json({ 
    ok: true, 
    route: "session/start",
    method: request.method,
    pathname: new URL(request.url).pathname,
    note: "This endpoint requires POST. Use POST to start a session or fetch questions.",
    troubleshooting: "If POST requests return 404, check Shopify app proxy configuration in Partners dashboard."
  });
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
  console.log(`[App Proxy] OPTIONS ${routePath} (CORS preflight)`);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
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

  const { experienceId, resultCount, answers, clientRequestId } = body;
  console.log("[App Proxy] Request body:", {
    experienceId,
    resultCount,
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
        sessionId: existing.publicToken,
        status: existing.status,
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
    
    // Validate and determine resultCount for response (must be 8/12/16)
    const validResultCounts = [8, 12, 16];
    const resultCountUsed = resultCount && validResultCounts.includes(resultCount)
      ? resultCount
      : (validResultCounts.includes(experience.resultCount) ? experience.resultCount : 8);

    console.log("[App Proxy] Returning questions-only response:", {
      ok: true,
      experienceIdUsed,
      modeUsed,
      resultCountUsed,
      questionsCount: questions.length,
      planTier: entitlements.planTier,
    });
    
    return Response.json({
      ok: true,
      experienceIdUsed: experienceIdUsed,
      modeUsed: modeUsed,
      resultCountUsed: resultCountUsed,
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

  // Validate and determine resultCount (must be 8/12/16)
  // Prefer body.resultCount if valid, else experience.resultCount if valid, else 8
  const validResultCounts = [8, 12, 16];
  const resultCountUsed = resultCount && validResultCounts.includes(resultCount)
    ? resultCount
    : (validResultCounts.includes(experience.resultCount) ? experience.resultCount : 8);
  console.log("[App Proxy] Using resultCount:", resultCountUsed);
  
  // Calculate dynamic AI window based on resultCount and entitlements
  // bundleWindow: 8->60, 12->90, 16->120
  const bundleWindow = resultCountUsed === 8 ? 60 : resultCountUsed === 12 ? 90 : 120;
  const aiWindow = Math.min(entitlements.candidateCap, bundleWindow);
  console.log("[App Proxy] AI window:", aiWindow, "(bundleWindow:", bundleWindow, ", candidateCap:", entitlements.candidateCap, ")");

  // Store answers as JSON
  const answersJson = Array.isArray(answers) 
    ? JSON.stringify(answers) 
    : (typeof answers === "string" ? answers : "[]");

  // Create session using helper
  const sessionToken = await createConciergeSession({
    shopId: shop.id,
    experienceId: experience.id,
    resultCount: resultCountUsed,
    answersJson,
    clientRequestId: clientRequestId && typeof clientRequestId === "string" ? clientRequestId.trim() : null,
  });
  
  console.log('[App Proxy] Creating new session', { clientRequestId: clientRequestId && typeof clientRequestId === "string" ? clientRequestId.trim() : null, resultCount: resultCountUsed });

  // Track usage: session started
  await trackUsageEvent(shop.id, "SESSION_STARTED" as UsageEventType, {
    sessionToken,
    experienceId: experience.id,
    resultCount: resultCountUsed,
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
  
  if (accessToken) {
    try {
      console.log("[App Proxy] Fetching products from Shopify Admin API");
      
      // Fetch products
      let products = await fetchShopifyProducts({
        shopDomain,
        accessToken,
        limit: PRODUCT_POOL_LIMIT,
        collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
      });

      console.log("[App Proxy] Fetched", products.length, "products");

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
      const minNeeded = Math.max(MIN_CANDIDATES_FOR_AI, MIN_CANDIDATES_FOR_DELIVERY, resultCountUsed);
      
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
      let userIntent = "";
      if (Array.isArray(answers)) {
        userIntent = answers.join("; ").trim();
      } else if (typeof answers === "string") {
        userIntent = answers.trim();
      }

      console.log("[App Proxy] User intent length:", userIntent.length);

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
      
      // Extract keywords early so they can be used for filtering
      const { includeTerms, avoidTerms } = extractKeywords(userIntent);
      console.log("[App Proxy] Include terms:", includeTerms);
      console.log("[App Proxy] Avoid terms:", avoidTerms);

      // Build candidates from filteredProducts
      let allCandidates = filteredProducts.map(p => ({
        handle: p.handle,
        title: p.title,
        productType: (p as any).productType || null,
        tags: p.tags || [],
        vendor: (p as any).vendor || null,
        price: p.priceAmount || p.price || null,
        description: (p as any).description || null,
        available: p.available,
        sizes: Array.isArray((p as any).sizes) ? (p as any).sizes : [],
        colors: Array.isArray((p as any).colors) ? (p as any).colors : [],
        materials: Array.isArray((p as any).materials) ? (p as any).materials : [],
        optionValues: (p as any).optionValues ?? {},
      }));

      // Apply avoidTerms as a soft filter BEFORE AI ranking
      if (avoidTerms.length > 0) {
        const beforeAvoidFilter = allCandidates.length;
        const filteredByAvoid = allCandidates.filter(candidate => {
          const titleLower = (candidate.title || "").toLowerCase();
          const tagsLower = (candidate.tags || []).map((t: string) => t.toLowerCase());
          
          // Check if title or tags contain any avoid term
          for (const avoidTerm of avoidTerms) {
            if (titleLower.includes(avoidTerm) || tagsLower.some((tag: string) => tag.includes(avoidTerm))) {
              return false; // Exclude this product
            }
          }
          return true; // Keep this product
        });
        
        // Check if filtering would cause pool < minNeeded
        if (filteredByAvoid.length < minNeeded) {
          relaxNotes.push("Avoid terms relaxed to fill results.");
          // Keep original candidates (don't filter)
        } else {
          allCandidates = filteredByAvoid;
          console.log("[App Proxy] Applied avoid terms filter:", allCandidates.length, "candidates (filtered from", beforeAvoidFilter, ")");
        }
      }

      // Build variantPreferences with priority (Answers > Text)
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

      const fromAnswers = parseConstraintsFromAnswers(answersJson);
      const fromText = parseConstraintsFromText(userIntent);
      const variantConstraints = mergeConstraints(fromAnswers, fromText);
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

      function preferenceScore(candidate: any, prefs: VariantPreferences): number {
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

      const sortedCandidates = [...allCandidates].sort((a, b) => {
        const sa = preferenceScore(a, variantPreferences);
        const sb = preferenceScore(b, variantPreferences);
        if (sa !== sb) return sb - sa;
        return a.handle.localeCompare(b.handle);
      });

      console.log("[App Proxy] Built", sortedCandidates.length, "candidates for AI ranking");

      // AI pass #1 + Top-up passes (no extra charge)
      const targetCount = Math.min(resultCountUsed, sortedCandidates.length);

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

      const window1 = buildWindow(offset, used);
      const ai1 = await rankProductsWithAI(
        userIntent,
        window1,
        targetCount,
        shop.id,
        sessionToken,
        variantConstraints2,
        variantPreferences,
        includeTerms,
        avoidTerms
      );

      if (ai1.rankedHandles?.length) {
        // Filter cached handles against current product availability
        // This ensures out-of-stock products from cache are excluded
        const validHandles = ai1.rankedHandles.filter((handle: string) => {
          const candidate = allCandidates.find(c => c.handle === handle);
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
        reasoningParts.push("Products selected using default ranking.");
      }

      // TOP-UP PASSES
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
          avoidTerms
        );

        if (aiTopUp.rankedHandles?.length) {
          // Filter cached handles against current product availability
          const validTopUpHandles = aiTopUp.rankedHandles.filter((handle: string) => {
            const candidate = allCandidates.find(c => c.handle === handle);
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

      // FINAL FILL (only if still short)
      if (finalHandles.length < targetCount) {
        const remaining = sortedCandidates.filter(c => !used.has(c.handle));
        const fallbackHandles = fallbackRanking(remaining, targetCount - finalHandles.length);
        finalHandles = [...finalHandles, ...fallbackHandles];
      }

      // Helper functions for guaranteed top-up
      function uniq<T>(arr: T[]) {
        return Array.from(new Set(arr));
      }

      function topUpHandles(
        ranked: string[],
        pool: Array<{ handle: string }>,
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

      // Hard guarantee: top-up after AI ranking
      // rankedHandles is what AI produced across passes (may be short)
      let finalHandlesGuaranteed = uniq(finalHandles);

      // IMPORTANT: use the relaxed pool here (NOT only strict filteredProducts)
      finalHandlesGuaranteed = topUpHandles(finalHandlesGuaranteed, allCandidates, resultCountUsed);

      // Safety: if still short (tiny store), fall back to baseProducts
      if (finalHandlesGuaranteed.length < resultCountUsed) {
        finalHandlesGuaranteed = topUpHandles(finalHandlesGuaranteed, baseProducts, resultCountUsed);
      }

      console.log(
        "[App Proxy] Final handles after top-up:",
        finalHandlesGuaranteed.length,
        "requested:",
        resultCountUsed
      );

      finalHandles = finalHandlesGuaranteed;

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

      // Final reasoning string (include relaxation notes)
      const notes = [...relaxNotes];
      const reasoning = [...notes, ...reasoningParts].filter(Boolean).join(" ");
      productHandles = finalHandles.slice(0, targetCount);

      console.log("[App Proxy] Final product handles:", productHandles.length, "out of", targetCount, "requested");
      
      // Save results and mark session as COMPLETE
      await saveConciergeResult({
        sessionToken,
        productHandles,
        productIds: null,
        reasoning: productHandles.length > 0 
          ? reasoning
          : "No products available. Please ensure the app is installed and products exist.",
      });

      console.log("[App Proxy] Results saved, session marked COMPLETE");

      // Charge session once for the final result count (prevents duplicate charges from multi-pass AI)
      // NOTE: Credits are charged regardless of cache hit/miss - you're paying for the ranking service, not the OpenAI API call
      const deliveredCount = productHandles.length;
      if (deliveredCount === 0) {
        console.log("[Billing] Skipping charge: deliveredCount=0");
      } else {
        try {
          chargeResult = await chargeConciergeSessionOnce({
            sessionToken,
            shopId: shop.id,
            resultCount: resultCountUsed, // Use requested count (8/12/16), not actual returned count
            experienceId: experience.id,
          });
          console.log("[App Proxy] Session charged for", resultCountUsed, "results, overage delta:", chargeResult.overageCreditsX2Delta);

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
                      return Response.json({
                        ok: false,
                        error: "Your usage cap has been reached. Please contact support or wait for the next billing cycle to continue using EditMuse.",
                        errorCode: "USAGE_CAP_REACHED",
                      }, { status: 403 });
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
                return Response.json({
                  ok: false,
                  error: "Your usage cap has been reached. Please contact support or wait for the next billing cycle to continue using EditMuse.",
                  errorCode: "USAGE_CAP_REACHED",
                }, { status: 403 });
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
            return Response.json({
              ok: false,
              error: errorMessage,
              errorCode: "SUBSCRIPTION_REQUIRED",
            }, { status: 403 });
          }
          
          // For other billing errors, still return success but log the error
          // (This allows the session to complete even if billing tracking fails)
          console.warn("[App Proxy] Billing error (non-blocking):", errorMessage);
        }
      }
    } catch (error) {
      console.error("[App Proxy] Error fetching products:", error);
      console.error("[App Proxy] Error details:", {
        shopDomain,
        hasAccessToken: !!accessToken,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
      });
      // Save empty results on error
      await saveConciergeResult({
        sessionToken,
        productHandles: [],
        productIds: null,
        reasoning: "Error fetching products. Please try again.",
      });
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
  }

  // Build redirect URL - preserve App Proxy query params for signature validation
  const redirectParams = new URLSearchParams();
  redirectParams.set("sid", sessionToken);
  // Preserve existing query params (shop, signature, etc.) for App Proxy
  query.forEach((value, key) => {
    if (key !== "sid" && key !== "sessionId" && key !== "editmuse_session") {
      redirectParams.set(key, value);
    }
  });
  const redirectPath = `/pages/editmuse-results?${redirectParams.toString()}`;

  return Response.json({
    ok: true,
    sessionId: sessionToken,
    experienceIdUsed: experienceIdUsed,
    modeUsed: modeUsed,
    resultCountUsed: resultCountUsed,
    questions: questions,
    redirectTo: redirectPath,
    billing: {
      planTier: entitlements.planTier,
      candidateCap: entitlements.candidateCap,
      creditsBurned: chargeResult?.creditsBurned ?? null,
      overageCredits: chargeResult?.overageCreditsX2Delta ? chargeResult.overageCreditsX2Delta / 2 : 0,
      showTrialBadge: entitlements.showTrialBadge,
    },
  });
}

