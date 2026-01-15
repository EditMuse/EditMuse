import type { ActionFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";
import { UsageEventType } from "@prisma/client";
import { trackUsageEvent } from "~/models/billing.server";
import { resolveSessionForAttribution, upsertAttributionAttempt } from "~/models/attribution.server";
import { withProxyLogging } from "~/utils/proxy-logging.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return Response.json({ error: "Missing SHOPIFY_API_SECRET" }, { status: 500 });
  }

  // Require valid proxy signature
  const valid = validateAppProxySignature(url.searchParams, secret);
  if (!valid) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const shopDomain = getShopFromAppProxy(url.searchParams);
  if (!shopDomain) {
    return Response.json({ error: "Missing shop" }, { status: 400 });
  }

  return withProxyLogging(
    async () => {
      const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
      if (!shop) {
        return Response.json({ error: "Shop not found" }, { status: 404 });
      }

      let body: any = null;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const eventType = String(body?.eventType || "");
      const sid = typeof body?.sid === "string" ? body.sid.trim() : "";

      if (!eventType) return Response.json({ error: "Missing eventType" }, { status: 400 });

      // Validate eventType against Prisma enum
      const allowed = new Set<string>(Object.values(UsageEventType));
      if (!allowed.has(eventType)) {
        return Response.json({ error: `Invalid eventType: ${eventType}` }, { status: 400 });
      }

      // Optional: resolve session by publicToken for richer metadata
      const session = sid
        ? await prisma.conciergeSession.findFirst({
            where: { publicToken: sid, shopId: shop.id },
            select: { id: true, publicToken: true, experienceId: true, resultCount: true, createdAt: true },
          })
        : null;

      // Keep metadata lightweight (store as JSON string in UsageEvent.metadata)
      const metadata = {
        sid: sid || session?.publicToken || null,
        conciergeSessionId: session?.id || null,
        experienceId: session?.experienceId || null,
        // client-provided metadata
        ...(body?.metadata && typeof body.metadata === "object" ? body.metadata : {}),
        // basic request info
        path: url.pathname,
        at: new Date().toISOString(),
      };

      await trackUsageEvent(shop.id, eventType as UsageEventType, metadata, 0);

      // Store AttributionAttempt on CHECKOUT_STARTED events
      if (eventType === UsageEventType.CHECKOUT_STARTED) {
        try {
          const clientMetadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
          const sessionToken = clientMetadata.sessionToken || metadata.sid || null;
          const sessionIdFromMeta = clientMetadata.sessionId || metadata.conciergeSessionId || null;
          const cartToken = clientMetadata.cartToken || null;
          const checkoutToken = clientMetadata.checkoutToken || null;

          // Only proceed if we have at least cartToken or checkoutToken
          if (cartToken || checkoutToken) {
            // Resolve session
            const resolvedSession = await resolveSessionForAttribution({
              shopId: shop.id,
              sessionToken: sessionToken || null,
              sessionId: sessionIdFromMeta || null,
            });

            if (resolvedSession) {
              await upsertAttributionAttempt({
                shopId: shop.id,
                sessionId: resolvedSession.id,
                sessionToken: resolvedSession.publicToken,
                cartToken: cartToken || null,
                checkoutToken: checkoutToken || null,
              });
            }
          }
        } catch (error) {
          // Log but don't fail the request if attribution attempt fails
          console.error("[Event] Error storing AttributionAttempt:", error);
        }
      }

      return Response.json({ ok: true });
    },
    request,
    "/apps/editmuse/event",
    shopDomain || undefined
  );
};

