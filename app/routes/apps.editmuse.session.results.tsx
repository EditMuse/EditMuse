import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { getConciergeSessionByToken } from "~/models/concierge.server";
import { fetchShopifyProducts } from "~/shopify-admin.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /apps/editmuse/session/results");

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

  // Get sessionId from query
  const sessionId = query.get("sessionId");
  if (!sessionId) {
    console.log("[App Proxy] Missing sessionId parameter");
    return Response.json({ error: "Missing sessionId parameter" }, { status: 400 });
  }

  // Get session
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

  console.log("[App Proxy] Loading recommendations for session:", sessionId);

  // If result already exists, return it
  if (session.result) {
    const productHandles = Array.isArray(session.result.productHandles)
      ? session.result.productHandles
      : [];

    console.log("[App Proxy] Returning saved results:", productHandles.length, "products");

    return Response.json({
      ok: true,
      sessionId: session.publicToken,
      recommendations: productHandles
        .filter((h): h is string => typeof h === "string")
        .map((handle: string) => ({
          handle,
          // Note: Full product details would require additional API call
        })),
      mode: "saved",
    });
  }

  // Placeholder logic: Fetch products from Shopify Admin API
  try {
    if (!session.shop.accessToken) {
      console.log("[App Proxy] Shop access token not available");
      return Response.json({
        ok: true,
        sessionId: session.publicToken,
        recommendations: [],
        mode: "placeholder",
        error: "Shop access token not available",
      });
    }

    const products = await fetchShopifyProducts({
      shopDomain: session.shop.domain,
      accessToken: session.shop.accessToken,
      limit: 50,
    });

    // Return first N products based on session resultCount
    const recommendations = products
      .slice(0, session.resultCount)
      .map((product) => ({
        handle: product.handle,
        title: product.title,
        image: product.image,
        price: product.price, // Keep for backwards compatibility
        priceAmount: product.priceAmount || product.price,
        currencyCode: product.currencyCode || null,
      }));

    console.log("[App Proxy] Returning placeholder results:", recommendations.length, "products");

    return Response.json({
      ok: true,
      sessionId: session.publicToken,
      recommendations,
      mode: "placeholder",
    });
  } catch (error) {
    console.error("[App Proxy] Error fetching products:", error);
    return Response.json({
      ok: true,
      sessionId: session.publicToken,
      recommendations: [],
      mode: "placeholder",
      error: "Failed to fetch products",
    });
  }
};

