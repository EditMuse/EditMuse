import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { getConciergeSessionByToken } from "~/models/concierge.server";
import {
  getOfflineAccessTokenForShop,
  fetchShopifyProductsGraphQL,
  fetchShopifyProductsByHandlesGraphQL,
} from "~/shopify-admin.server";
import { rankProductsWithAI, isAIRankingEnabled, getOpenAIModel, fallbackRanking } from "~/models/ai-ranking.server";
import { ConciergeSessionStatus } from "@prisma/client";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /apps/editmuse/session");

  const url = new URL(request.url);
  const query = url.searchParams;

  // Get sessionId from query first (needed to get shop)
  const sessionId = query.get("sid");
  if (!sessionId) {
    console.log("[App Proxy] Missing sid parameter");
    return Response.json({ error: "Missing sid parameter" }, { status: 400 });
  }

  // Get session to determine shop (before validation)
  const session = await getConciergeSessionByToken(sessionId);
  if (!session) {
    console.log("[App Proxy] Session not found:", sessionId);
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const shopDomain = session.shop.domain;
  console.log("[App Proxy] Shop domain from session:", shopDomain);

  // Validate HMAC signature if present (for App Proxy requests)
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const hasSignature = query.has("signature");
  
  if (hasSignature) {
    const isValid = validateAppProxySignature(query, secret);
    console.log("[App Proxy] Signature validation:", isValid ? "PASSED" : "FAILED");

    if (!isValid) {
      console.log("[App Proxy] Invalid signature - returning 401");
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Verify shop matches if provided in query
    const queryShop = getShopFromAppProxy(query);
    if (queryShop && queryShop !== shopDomain) {
      console.log("[App Proxy] Shop mismatch");
      return Response.json({ error: "Session shop mismatch" }, { status: 403 });
    }
  } else {
    console.log("[App Proxy] No signature in query - allowing request (storefront direct call)");
  }

  // Get offline access token
  const accessToken = await getOfflineAccessTokenForShop(shopDomain);
  if (!accessToken) {
    console.log("[App Proxy] Offline access token not found for shop:", shopDomain);
    return Response.json({ 
      error: "App not properly installed. Please reinstall the app to continue." 
    }, { status: 401 });
  }

  // ✅ If results are already saved, fetch those exact products by handle and return.
  // This prevents "0 products" when the candidate pool is small/filtered.
  // Pure path: no experience filters, no candidate fetching, no inStockOnly filtering.
  if (session.result) {
    const raw = session.result.productHandles;
    const savedHandles = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];

    console.log("[App Proxy] Using saved ConciergeResult with", savedHandles.length, "handles - fetching by handles");
    console.log("[App Proxy] Saved handles:", savedHandles);

    if (savedHandles.length > 0) {
      const savedProducts = await fetchShopifyProductsByHandlesGraphQL({
        shopDomain,
        accessToken,
        handles: savedHandles,
      });

      console.log("[App Proxy] Found products:", savedProducts.map(p => p.handle));

      const map = new Map(savedProducts.map((p) => [p.handle, p]));
      const ordered = savedHandles
        .map((h) => map.get(h))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({
          handle: p.handle,
          title: p.title,
          image: p.image,
          price: p.price,
          priceAmount: p.priceAmount || p.price,
          currencyCode: p.currencyCode || null,
          url: p.url,
        }));

      console.log("[App Proxy] Returning", ordered.length, "products (saved-by-handle)");

      if (ordered.length === 0) {
        console.log("[App Proxy] WARNING: Saved result exists but no products were fetched by handle.");
      }

      return Response.json({
        ok: true,
        sid: sessionId,
        status: "COMPLETE",
        products: ordered,
        reasoning: session.result.reasoning || null,
        warning: ordered.length === 0 ? "Saved results could not be loaded (products missing/unpublished)" : null,
        mode: "saved",
      });
    }
  }

  // Load Experience if available
  let experience = null;
  if (session.experienceId) {
    experience = await prisma.experience.findUnique({
      where: { id: session.experienceId },
    });
    console.log("[App Proxy] Loaded experience:", experience?.name || "not found");
  }

  // Parse Experience filters
  const includedCollections = experience
    ? (JSON.parse(experience.includedCollections || "[]") as string[])
    : [];
  const excludedTags = experience
    ? (JSON.parse(experience.excludedTags || "[]") as string[])
    : [];
  const inStockOnly = experience?.inStockOnly || false;
  const resultCount = session.resultCount || 8;

  console.log("[App Proxy] Experience filters:", {
    includedCollections: includedCollections.length,
    excludedTags: excludedTags.length,
    inStockOnly,
    resultCount,
  });

  // Build candidate product pool
  try {
    console.log("[App Proxy] Fetching candidate products from Shopify");
    
    // Fetch products based on collection filter
    let candidates = await fetchShopifyProductsGraphQL({
      shopDomain,
      accessToken,
      limit: 200, // Cap at 200 for speed
      collectionIds: includedCollections.length > 0 ? includedCollections : undefined,
    });

    console.log("[App Proxy] Fetched", candidates.length, "candidate products");

    // Filter out ARCHIVED and DRAFT products
    const beforeStatusFilter = candidates.length;
    candidates = candidates.filter(p => {
      const status = (p as any).status;
      return status !== "ARCHIVED" && status !== "DRAFT";
    });
    console.log("[App Proxy] After status filter (excluding ARCHIVED/DRAFT):", candidates.length, "products (filtered from", beforeStatusFilter, ")");

    // Apply excludedTags filter
    if (excludedTags.length > 0) {
      candidates = candidates.filter((p) => {
        const productTags = p.tags || [];
        return !excludedTags.some((excludedTag) =>
          productTags.some((tag) => tag.toLowerCase() === excludedTag.toLowerCase())
        );
      });
      console.log("[App Proxy] After excludedTags filter:", candidates.length, "products");
    }

    // Apply inStockOnly filter
    if (inStockOnly) {
      candidates = candidates.filter((p) => p.available);
      console.log("[App Proxy] After inStockOnly filter:", candidates.length, "products");
    }

    // Check if session has saved result (ConciergeResult)
    let rankedHandles: string[] = [];
    let reasoning: string | null = null;
    let usedFallback = false;

    if (session.result) {
      // ConciergeResult exists - use saved handles in exact order, skip AI ranking
      const productHandlesRaw = session.result.productHandles;
      const savedHandles = Array.isArray(productHandlesRaw)
        ? (productHandlesRaw as any[]).filter((h): h is string => typeof h === "string")
        : [];
      
      console.log("[App Proxy] Using saved ConciergeResult with", savedHandles.length, "handles - skipping AI ranking");
      rankedHandles = savedHandles;
      reasoning = session.result.reasoning || null;
      usedFallback = false; // Using saved results, not fallback
    } else {
      // No ConciergeResult - proceed with AI ranking
      console.log("[App Proxy] No ConciergeResult found - proceeding with AI ranking");

      // Parse answers to extract price/budget range if present
      let priceMin: number | null = null;
      let priceMax: number | null = null;
      
      try {
        const answersJson = (session as any).answersJson || "[]";
        const answers = JSON.parse(answersJson);
        
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
      } catch (e) {
        console.error("[App Proxy] Failed to parse answersJson for price filtering:", e);
      }

      // Apply price/budget range filter if specified
      if (priceMin !== null || priceMax !== null) {
        const beforeCount = candidates.length;
        candidates = candidates.filter((p) => {
          if (!p.priceAmount && !p.price) return false; // Exclude products without price
          const productPrice = parseFloat(p.priceAmount || p.price || "0");
          if (isNaN(productPrice)) return false;
          
          if (priceMin !== null && productPrice < priceMin) return false;
          if (priceMax !== null && productPrice > priceMax) return false;
          return true;
        });
        console.log("[App Proxy] After price filter (", priceMin || "any", "-", priceMax || "any", "):", candidates.length, "products (filtered from", beforeCount, ")");
      }

      // If no candidates after filtering, return empty results without calling AI
      if (candidates.length === 0) {
        console.log("[App Proxy] No candidates after filtering - returning empty results");
        return Response.json({
          ok: true,
          sid: sessionId,
          status: session.status === ConciergeSessionStatus.COMPLETE ? "COMPLETE" : 
                  session.status === ConciergeSessionStatus.PROCESSING ? "PROCESSING" : "COLLECTING",
          products: [],
          reasoning: "No products match your criteria. Please try adjusting your filters.",
          mode: "empty",
        });
      }

      // Build user intent from answers
      let userIntent = "";
      try {
        const answersJson = (session as any).answersJson || "[]";
        console.log("[App Proxy] answersJson from session:", answersJson.substring(0, 200));
        const answers = JSON.parse(answersJson);
        console.log("[App Proxy] Parsed answers:", Array.isArray(answers) ? answers.length + " items" : "not an array", answers);
        
        if (Array.isArray(answers) && answers.length > 0) {
          userIntent = answers
            .map((a: any) => {
              if (typeof a === "string") return a;
              if (a.question && a.answer) return `Q: ${a.question}\nA: ${a.answer}`;
              if (a.text) return a.text;
              return JSON.stringify(a);
            })
            .join("\n\n");
          console.log("[App Proxy] Built user intent, length:", userIntent.length);
        } else {
          console.warn("[App Proxy] No answers found or answers is not an array");
        }
      } catch (e) {
        console.error("[App Proxy] Failed to parse answersJson:", e);
      }
      
      console.log("[App Proxy] Final user intent length:", userIntent.length);

      // Use AI ranking if enabled
      reasoning = "MVP: default selection";

      // Log AI status check
      const aiEnabled = isAIRankingEnabled();
      const aiModel = getOpenAIModel();
      console.log("[App Proxy] AI Ranking check - Enabled:", aiEnabled, "Model:", aiModel, "Candidates:", candidates.length);

      if (aiEnabled && candidates.length > 0) {
        console.log("[AI Ranking] Starting AI ranking with model:", aiModel);
        console.log("[AI Ranking] Candidates:", candidates.length, "User intent length:", userIntent.length);

        const aiResult = await rankProductsWithAI(
          userIntent || "No specific intent",
          candidates.map((p) => ({
            handle: p.handle,
            title: p.title,
            tags: p.tags || [],
            productType: p.productType || null,
            vendor: p.vendor || null,
            price: p.price || null,
            description: p.description || null,
            available: p.available,
          })),
          resultCount,
          session.shopId, // Pass shopId for usage tracking
          sessionId // Pass sessionToken for charge prevention
        );

        if (aiResult) {
          rankedHandles = aiResult.rankedHandles;
          reasoning = aiResult.reasoning;
          console.log("[AI Ranking] AI ranking successful, returned", rankedHandles.length, "products");
        } else {
          usedFallback = true;
          console.log("[AI Ranking] AI ranking failed, using fallback");
          rankedHandles = fallbackRanking(
            candidates.map((p) => ({
              handle: p.handle,
              title: p.title,
              tags: p.tags || [],
              productType: p.productType || null,
              vendor: p.vendor || null,
              price: p.price || null,
              description: p.description || null,
              available: p.available,
            })),
            resultCount
          );
        }
      } else {
        usedFallback = true;
        console.log("[AI Ranking] AI ranking disabled, using fallback");
        rankedHandles = fallbackRanking(
          candidates.map((p) => ({
            handle: p.handle,
            title: p.title,
            tags: p.tags || [],
            productType: p.productType || null,
            vendor: p.vendor || null,
            price: p.price || null,
            description: p.description || null,
            available: p.available,
          })),
          resultCount
        );
      }
    }

    // Map handles back to products in the exact order of rankedHandles
    const handleMap = new Map(candidates.map(p => [p.handle, p]));
    const products = rankedHandles
      .map(handle => handleMap.get(handle))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .map((p) => ({
        handle: p.handle,
        title: p.title,
        image: p.image,
        price: p.price, // Keep for backwards compatibility
        priceAmount: p.priceAmount || p.price, // Use priceAmount if available, fallback to price
        currencyCode: p.currencyCode || null,
        url: p.url,
      }));

    console.log("[App Proxy] Returning", products.length, "products (requested:", resultCount, ")", session.result ? "(saved)" : (usedFallback ? "(fallback)" : "(AI-ranked)"));

    return Response.json({
      ok: true,
      sid: sessionId,
      status: session.status === ConciergeSessionStatus.COMPLETE ? "COMPLETE" : 
              session.status === ConciergeSessionStatus.PROCESSING ? "PROCESSING" : "COLLECTING",
      products,
      reasoning: reasoning || session.result?.reasoning || null,
      mode: session.result ? "saved" : (usedFallback ? "fallback" : "ai"),
    });
  } catch (error) {
    console.error("[App Proxy] Error fetching products:", error);
    return Response.json({
      ok: true,
      sid: sessionId,
      status: session.status === ConciergeSessionStatus.COMPLETE ? "COMPLETE" : 
              session.status === ConciergeSessionStatus.PROCESSING ? "PROCESSING" : "COLLECTING",
      products: [],
      reasoning: null,
    });
  }
};

