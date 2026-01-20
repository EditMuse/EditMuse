import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { getConciergeSessionByToken } from "~/models/concierge.server";
import {
  getOfflineAccessTokenForShop,
  fetchShopifyProductsByHandlesGraphQL,
} from "~/shopify-admin.server";
import { ConciergeSessionStatus } from "@prisma/client";
import prisma from "~/db.server";
import { computeCreditsBurned, creditsToX2, trackUsageEvent } from "~/models/billing.server";

type UsageEventType = "SESSION_STARTED" | "AI_RANKING_EXECUTED";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /session (app proxy stripped path)");

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

  // Check session status and result existence
  const hasResult = !!session.result;
  const status = session.status;
  
  console.log("[Session Poll] status=", status, "hasResult=", hasResult);

  // Handle FAILED status
  if (status === ConciergeSessionStatus.FAILED) {
    return Response.json({
      ok: false,
      sid: sessionId,
      status: "FAILED",
      error: "Session processing failed. Please try again.",
    });
  }

  // Handle PROCESSING/COLLECTING status - return early without fetching or ranking
  if (status === ConciergeSessionStatus.PROCESSING || 
      status === ConciergeSessionStatus.COLLECTING) {
    if (!hasResult) {
      // No result yet - return PROCESSING/COLLECTING status
      const statusStr = status === ConciergeSessionStatus.PROCESSING ? "PROCESSING" : "COLLECTING";
      return Response.json({
        ok: true,
        sid: sessionId,
        status: statusStr,
      });
    }
    // If result exists but status is still PROCESSING/COLLECTING, fall through to return it
  }

  // Only return products when status is COMPLETE and result exists
  if (status === ConciergeSessionStatus.COMPLETE && hasResult && session.result) {
    // Reload session to get deliveredAt, chargedAt, and chargeLockAt fields
    const sessionWithBilling = await prisma.conciergeSession.findUnique({
      where: { id: session.id },
    });

    if (!sessionWithBilling) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Compute deliveredCount from actual handles being returned
    const raw = session.result.productHandles;
    const savedHandles = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];
    const deliveredCount = savedHandles.length;

    const now = new Date();
    const deliveredAt = (sessionWithBilling as any).deliveredAt;
    const chargedAt = (sessionWithBilling as any).chargedAt;
    const chargeLockAt = (sessionWithBilling as any).chargeLockAt;

    // Set deliveredAt on first delivery (idempotent using updateMany)
    if (!deliveredAt) {
      await prisma.conciergeSession.updateMany({
        where: { id: session.id, deliveredAt: null } as any,
        data: { deliveredAt: now } as any,
      });
    }

    // Charge on first delivery with lock-based concurrency safety
    // Only attempt billing when: status === COMPLETE, result exists, deliveredCount > 0
    if (!chargedAt && deliveredCount > 0) {
      // Acquire lock atomically using updateMany
      const lockNow = new Date();
      const locked = await prisma.conciergeSession.updateMany({
        where: { 
          id: session.id, 
          chargedAt: null, 
          chargeLockAt: null 
        } as any,
        data: { chargeLockAt: lockNow } as any,
      });

      if (locked.count === 0) {
        // Lock acquisition failed
        if (chargedAt) {
          // Already charged (race condition - another request charged between our check and lock attempt)
          console.log("[Billing] Already charged", { sid: sessionId });
        } else if (chargeLockAt) {
          // Another request is currently charging
          // Skip charging (do not charge)
        }
      } else if (locked.count === 1) {
        // Lock acquired - perform billing
        try {
          // Use computeCreditsBurned as canonical source of truth
          const creditsBurned = computeCreditsBurned(deliveredCount);
          // Derive burnX2 from canonical credits value
          const burnX2 = creditsToX2(creditsBurned);

          // Dev-only assertion to verify consistency (can be removed in production)
          if (process.env.NODE_ENV !== "production") {
            const oldBurnX2 = (await import("~/models/billing.server")).burnX2FromResultCount(deliveredCount);
            if (oldBurnX2 !== burnX2) {
              console.warn("[Billing] Credit calculation mismatch detected", {
                deliveredCount,
                canonical: burnX2,
                old: oldBurnX2,
              });
            }
          }

          console.log("[Billing] Charging on delivery", { 
            sid: sessionId, 
            deliveredCount, 
            credits: creditsBurned 
          });

          // Update subscription credits in a transaction
          const subscription = await prisma.$transaction(async (tx) => {
            // Load subscription with lock
            const sub = await tx.subscription.findUnique({
              where: { shopId: sessionWithBilling.shopId },
            });

            if (!sub) {
              throw new Error(`Subscription not found for shop: ${sessionWithBilling.shopId}`);
            }

            // Block access if subscription is cancelled
            if (sub.status === "cancelled") {
              throw new Error("Subscription has been cancelled. Please subscribe to continue using EditMuse.");
            }

            const totalCreditsX2 = (sub.creditsIncludedX2 || 0) + (sub.creditsAddonX2 || 0);
            const prevUsed = sub.creditsUsedX2 || 0;
            const newUsed = prevUsed + burnX2;

            // Calculate overage delta
            const prevOver = Math.max(0, prevUsed - totalCreditsX2);
            const newOver = Math.max(0, newUsed - totalCreditsX2);
            const deltaOverX2 = newOver - prevOver;

            // Update subscription
            await tx.subscription.update({
              where: { shopId: sessionWithBilling.shopId },
              data: {
                creditsUsedX2: newUsed,
              },
            });

            return {
              ...sub,
              creditsUsedX2: newUsed,
              deltaOverX2,
            };
          });

          // Create ONE billable UsageEvent (using canonical credits value)
          await trackUsageEvent(
            sessionWithBilling.shopId,
            "AI_RANKING_EXECUTED" as UsageEventType,
            {
              sessionToken: sessionId,
              experienceId: sessionWithBilling.experienceId || undefined,
              resultCount: deliveredCount,
            },
            creditsBurned
          );

          // On SUCCESS: set chargedAt and clear chargeLockAt
          await prisma.conciergeSession.update({
            where: { id: session.id },
            data: {
              chargedAt: now,
              chargeLockAt: null,
            } as any,
          });

          console.log("[Billing] Charged session", sessionId, "for", deliveredCount, "results =", creditsBurned, "credits, overage delta =", subscription.deltaOverX2);
        } catch (billingError) {
          // On FAILURE: clear chargeLockAt so a later poll can retry
          await prisma.conciergeSession.update({
            where: { id: session.id },
            data: { chargeLockAt: null } as any,
          });

          console.error("[Billing] Charge failed, lock released", { 
            sid: sessionId, 
            error: billingError instanceof Error ? billingError.message : String(billingError)
          });
          // Do not block delivering results to the client even if billing fails
        }
      }
    } else if (chargedAt) {
      console.log("[Billing] Already charged", { sid: sessionId });
    }

    // Get offline access token for fetching products by handles
    const accessToken = await getOfflineAccessTokenForShop(shopDomain);
    if (!accessToken) {
      console.log("[App Proxy] Offline access token not found for shop:", shopDomain);
      return Response.json({ 
        error: "App not properly installed. Please reinstall the app to continue." 
      }, { status: 401 });
    }

    // Fetch products by handles from saved result (savedHandles already computed above)

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
    } else {
      // Result exists but no handles - return empty
      return Response.json({
        ok: true,
        sid: sessionId,
        status: "COMPLETE",
        products: [],
        reasoning: session.result.reasoning || null,
        mode: "saved",
      });
    }
  }

  // If we reach here, status is not COMPLETE or result doesn't exist
  // Return appropriate status without fetching or ranking
  const statusStr = status === ConciergeSessionStatus.PROCESSING ? "PROCESSING" : 
                    status === ConciergeSessionStatus.COLLECTING ? "COLLECTING" : 
                    "COLLECTING"; // Default to COLLECTING if status is unknown
  
  return Response.json({
    ok: true,
    sid: sessionId,
    status: statusStr,
  });
};

