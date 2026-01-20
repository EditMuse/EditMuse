import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import {
  getOfflineAccessTokenForShop,
  fetchShopifyProductsByHandlesGraphQL,
} from "~/shopify-admin.server";
import { getOrCreateRequestId } from "~/utils/request-id.server";
import { ConciergeSessionStatus } from "@prisma/client";
import { chargeConciergeSessionOnce } from "~/models/billing.server";
import prisma from "~/db.server";

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
  // Need chargedAt and deliveredAt for billing on delivery
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionId },
    include: { 
      shop: true,
      result: true,
    },
  });
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

  // Return session status and products based on current state
  const status = session.status;
  
  // If COMPLETE and result exists, fetch products and charge on first delivery
  if (status === ConciergeSessionStatus.COMPLETE && session.result) {
    const raw = session.result.productHandles;
    const savedHandles = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];
    const deliveredCount = savedHandles.length;

    // Set deliveredAt on first delivery (idempotent)
    const now = new Date();
    if (!session.deliveredAt) {
      await prisma.conciergeSession.update({
        where: { id: session.id },
        data: { deliveredAt: now },
      });
      console.log("[App Proxy] /session marked deliveredAt", { sid: sessionId, requestId });
    }

    // Charge on first delivery (idempotent - guard by chargedAt)
    if (!session.chargedAt && deliveredCount > 0) {
      try {
        const credits = deliveredCount <= 8 ? 1 : deliveredCount <= 12 ? 1.5 : 2;
        console.log("[Billing] Charging on delivery", { 
          sid: sessionId, 
          deliveredCount, 
          credits,
          requestId 
        });

        await chargeConciergeSessionOnce({
          sessionToken: sessionId,
          shopId: session.shopId,
          resultCount: deliveredCount,
          experienceId: session.experienceId || undefined,
        });

        console.log("[Billing] Charged on delivery", { sid: sessionId, deliveredCount, credits, requestId });
      } catch (billingError) {
        // Log billing error but don't block delivery
        console.error("[Billing] Error charging on delivery", { 
          sid: sessionId, 
          error: billingError instanceof Error ? billingError.message : String(billingError),
          requestId 
        });
      }
    } else if (session.chargedAt) {
      console.log("[Billing] Already charged", { sid: sessionId, chargedAt: session.chargedAt, requestId });
    }

    if (savedHandles.length > 0) {
      console.log("[App Proxy] /session served COMPLETE result", { sid: sessionId, requestId, count: savedHandles.length });
      
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
        requestId,
      }, {
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    } else {
      // COMPLETE but no handles
      console.log("[App Proxy] /session served COMPLETE result", { sid: sessionId, requestId, count: 0 });
      return Response.json({
        ok: true,
        sid: sessionId,
        status: "COMPLETE",
        products: [],
        reasoning: session.result.reasoning || null,
        warning: "Saved result exists but contains no product handles",
        requestId,
      }, {
        headers: { "Content-Type": "application/json", "x-request-id": requestId },
      });
    }
  }
  
  // If not COMPLETE, return error or empty
  if (status !== ConciergeSessionStatus.COMPLETE) {
    console.log("[App Proxy] /session", status, { sid: sessionId, requestId });
    return Response.json({
      ok: true,
      sid: sessionId,
      status: status === ConciergeSessionStatus.FAILED ? "ERROR" : "PENDING",
      products: [],
      errorMessage: status === ConciergeSessionStatus.FAILED ? (session.result?.reasoning || "Session processing failed") : null,
      requestId,
    }, {
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    });
  }

};

