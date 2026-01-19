import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { getConciergeSessionByToken } from "~/models/concierge.server";
import {
  getOfflineAccessTokenForShop,
  fetchShopifyProductsByHandlesGraphQL,
} from "~/shopify-admin.server";
import { getOrCreateRequestId } from "~/utils/request-id.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /apps/editmuse/session");

  const requestId = getOrCreateRequestId(request);
  const url = new URL(request.url);
  const query = url.searchParams;

  // Get sessionId from query first (needed to get shop)
  const sessionId = query.get("sid");
  if (!sessionId) {
    console.log("[App Proxy] Missing sid parameter");
    return Response.json({ 
      ok: false, 
      status: "error",
      message: "Missing sid parameter",
      requestId,
    }, { 
      status: 400,
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    });
  }

  // Get session to determine shop (before validation)
  // Note: getConciergeSessionByToken now includes result relation
  const session = await getConciergeSessionByToken(sessionId);
  if (!session) {
    console.log("[App Proxy] Session not found:", sessionId);
    return Response.json({ 
      ok: false, 
      status: "error",
      message: "Session not found",
      requestId,
    }, { 
      status: 404,
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    });
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
      return Response.json({ 
        ok: false,
        status: "error",
        message: "Invalid signature",
        requestId,
      }, { 
        status: 401,
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    }

    // Verify shop matches if provided in query
    const queryShop = getShopFromAppProxy(query);
    if (queryShop && queryShop !== shopDomain) {
      console.log("[App Proxy] Shop mismatch");
      return Response.json({ 
        ok: false,
        status: "error",
        message: "Session shop mismatch",
        requestId,
      }, { 
        status: 403,
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    }
  } else {
    console.log("[App Proxy] No signature in query - allowing request (storefront direct call)");
  }

  // Get offline access token
  const accessToken = await getOfflineAccessTokenForShop(shopDomain);
  if (!accessToken) {
    console.log("[App Proxy] Offline access token not found for shop:", shopDomain);
    return Response.json({ 
      ok: false,
      status: "error",
      message: "App not properly installed. Please reinstall the app to continue.",
      requestId,
    }, { 
      status: 401,
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    });
  }

  // ✅ If results are already saved, fetch those exact products by handle and return.
  // This prevents "0 products" when the candidate pool is small/filtered.
  // Pure path: no experience filters, no candidate fetching, no inStockOnly filtering.
  // NEVER re-rank when ConciergeResult exists - return immediately.
  // NEVER run AI ranking from /session - only /session/start does AI.
  if (session.result) {
    const raw = session.result.productHandles;
    const savedHandles = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];

    if (savedHandles.length > 0) {
      console.log("[App Proxy] /session served saved result", { sid: sessionId, requestId, count: savedHandles.length });
      
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

      return Response.json({
        ok: true,
        sid: sessionId,
        status: "COMPLETE",
        products: ordered,
        reasoning: session.result.reasoning || null,
        warning: ordered.length === 0 ? "Saved results could not be loaded (products missing/unpublished)" : null,
        mode: "saved",
        requestId,
      }, {
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    } else {
      // ConciergeResult exists but has no handles - return empty but don't re-rank
      console.log("[App Proxy] /session served saved result", { sid: sessionId, requestId, count: 0 });
      return Response.json({
        ok: true,
        sid: sessionId,
        status: "COMPLETE",
        products: [],
        reasoning: session.result.reasoning || null,
        warning: "Saved result exists but contains no product handles",
        mode: "saved",
        requestId,
      }, {
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    }
  }
  
  // ConciergeResult is missing - return pending status (do NOT run AI ranking here)
  console.log("[App Proxy] /session pending", { sid: sessionId, requestId });
  return Response.json({
    ok: false,
    status: "pending",
    retryAfterMs: 1500,
    requestId,
  }, {
    headers: { "Content-Type": "application/json", "x-request-id": requestId },
  });

};

