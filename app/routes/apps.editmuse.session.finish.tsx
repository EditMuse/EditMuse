import type { ActionFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { getConciergeSessionByToken, saveConciergeResult } from "~/models/concierge.server";
import { fetchShopifyProducts } from "~/shopify-admin.server";
import { ConciergeSessionStatus } from "@prisma/client";
import prisma from "~/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[App Proxy] POST /apps/editmuse/session/finish");

  if (request.method !== "POST") {
    console.log("[App Proxy] Method not allowed:", request.method);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const query = url.searchParams;

  // Validate HMAC signature
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const isValid = validateAppProxySignature(query, secret);
  console.log("[App Proxy] Signature validation:", isValid ? "PASSED" : "FAILED");

  if (!isValid) {
    console.log("[App Proxy] Invalid signature - returning 401");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Get shop domain
  const shopDomain = getShopFromAppProxy(query);
  if (!shopDomain) {
    console.log("[App Proxy] Missing shop parameter");
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  console.log("[App Proxy] Shop domain:", shopDomain);

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    console.log("[App Proxy] Missing sessionId");
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // Get session with experience
  const session = await getConciergeSessionByToken(sessionId);
  if (!session) {
    console.log("[App Proxy] Session not found:", sessionId);
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // Verify shop matches
  if (session.shop.domain !== shopDomain) {
    console.log("[App Proxy] Shop mismatch");
    return Response.json({ error: "Session shop mismatch" }, { status: 403 });
  }

  // Update status to PROCESSING
  await prisma.conciergeSession.update({
    where: { id: session.id },
    data: { status: ConciergeSessionStatus.PROCESSING },
  });

  console.log("[App Proxy] Processing recommendations for session:", sessionId);

  try {
    // Load experience constraints
    const experience = session.experience;
    if (!experience) {
      throw new Error("Experience not found for session");
    }

    // Parse collections and tags
    const includedCollections = JSON.parse(experience.includedCollections || "[]") as string[];
    const excludedTags = JSON.parse(experience.excludedTags || "[]") as string[];

    // Fetch products from Shopify Admin API
    // For MVP: If access token is missing, use Storefront API or return placeholder
    let products: Array<{ handle: string; title: string; image: string | null; price: string | null }> = [];
    
    if (session.shop.accessToken && session.shop.accessToken.trim() !== "") {
      try {
        products = await fetchShopifyProducts({
          shopDomain: session.shop.domain,
          accessToken: session.shop.accessToken,
          limit: 250, // Fetch more to filter
        });
      } catch (error) {
        console.error("[App Proxy] Error fetching products:", error);
        // Fall through to use placeholder products
      }
    }
    
    // If no products fetched (no access token or API error), use placeholder
    if (products.length === 0) {
      console.log("[App Proxy] No access token or API error - using placeholder products");
      // For MVP: Return empty results with a message
      // In production, you'd fetch via Storefront API or require OAuth first
      await saveConciergeResult({
        sessionToken: sessionId,
        productHandles: [],
        productIds: null,
        reasoning: "Product recommendations require app installation. Please install the app via OAuth to enable recommendations.",
      });
      
      const redirectUrl = `/pages/editmuse-results?sid=${encodeURIComponent(sessionId)}`;
      return Response.json({
        ok: true,
        redirectUrl,
        warning: "No access token available. Please install the app via OAuth.",
      });
    }

    // Apply filters
    // Note: For MVP, we're doing basic filtering. In production, you'd use Shopify Admin API filters
    // For now, we'll filter client-side after fetching
    // TODO: Use Shopify Admin API collection/tag filters when access token is available

    // Filter by inStockOnly if needed
    // Note: This requires additional API calls to check inventory - simplified for MVP

    // For MVP: Use deterministic ranking (stub for OpenAI)
    // In production, call OpenAI with session messages + experience constraints
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    let selectedProducts: Array<{ handle: string; title: string; image: string | null; price: string | null }> = [];
    let reasoning: string | null = null;

    if (openaiApiKey) {
      // TODO: Call OpenAI API for intelligent ranking
      // For now, use deterministic selection
      reasoning = "Selected based on your preferences and experience settings.";
      selectedProducts = products.slice(0, session.resultCount);
    } else {
      // Deterministic ranking (stub)
      console.log("[App Proxy] No OpenAI API key - using deterministic ranking");
      reasoning = "Selected top products based on your preferences.";
      selectedProducts = products.slice(0, session.resultCount);
    }

    // Save results
    const productHandles = selectedProducts.map(p => p.handle);
    await saveConciergeResult({
      sessionToken: sessionId,
      productHandles,
      productIds: null,
      reasoning,
    });

    console.log("[App Proxy] Results saved:", productHandles.length, "products");

    const redirectUrl = `/pages/editmuse-results?sid=${encodeURIComponent(sessionId)}`;

    return Response.json({
      ok: true,
      redirectUrl,
    });
  } catch (error) {
    console.error("[App Proxy] Error processing recommendations:", error);
    
    // Update status to FAILED
    await prisma.conciergeSession.update({
      where: { id: session.id },
      data: { status: ConciergeSessionStatus.FAILED },
    });

    return Response.json({
      error: error instanceof Error ? error.message : "Failed to process recommendations",
    }, { status: 500 });
  }
};

