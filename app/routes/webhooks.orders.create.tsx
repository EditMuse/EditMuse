import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType } from "@prisma/client";
import { upsertOrderAttribution } from "~/models/attribution.server";

/**
 * Extract non-PII tokens from order payload
 * Returns checkoutToken (preferred) or cartToken (fallback)
 */
function extractTokens(order: any): { checkoutToken?: string; cartToken?: string } {
  let checkoutToken: string | undefined;
  let cartToken: string | undefined;

  // Try checkout_token field
  if (order.checkout_token && typeof order.checkout_token === "string") {
    checkoutToken = order.checkout_token;
  }

  // Try cart_token field
  if (order.cart_token && typeof order.cart_token === "string") {
    cartToken = order.cart_token;
  }

  // Check note_attributes for tokens (but only specific token names)
  const noteAttributes = order.note_attributes || [];
  for (const attr of noteAttributes) {
    if (attr.name === "checkout_token" && attr.value && typeof attr.value === "string") {
      checkoutToken = attr.value;
    } else if (attr.name === "cart_token" && attr.value && typeof attr.value === "string") {
      cartToken = attr.value;
    }
  }

  // Check line_items properties (but only specific token names)
  const lineItems = order.line_items || [];
  for (const item of lineItems) {
    const properties = item.properties || [];
    for (const prop of properties) {
      if (prop.name === "checkout_token" && prop.value && typeof prop.value === "string") {
        checkoutToken = prop.value;
      } else if (prop.name === "cart_token" && prop.value && typeof prop.value === "string") {
        cartToken = prop.value;
      }
    }
  }

  return { checkoutToken, cartToken };
}

/**
 * Webhook handler for orders/create event from Shopify
 * This webhook is triggered when a new order is created in the store.
 * 
 * NOTE: This webhook requires Shopify approval for protected customer data.
 * Orders tracking will only work if this webhook is enabled.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[orders/create] HIT", new Date().toISOString());

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Feature flag guard
  const ordersWebhookEnabled = process.env.SHOPIFY_ORDERS_WEBHOOK_ENABLED === "true";

  try {
    // Authenticate webhook
    const { shop, topic } = await authenticate.webhook(request);
    console.log("[orders/create] VERIFIED", new Date().toISOString());

    const body = await request.json();

    // Find shop
    const shopRecord = await prisma.shop.findUnique({
      where: { domain: shop },
    });

    if (!shopRecord) {
      console.error("[Webhook] Shop not found:", shop);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract order information (no PII)
    const orderId = String(body.id || "");
    const orderNumber = body.order_number ? String(body.order_number) : null;
    const totalPrice = body.total_price ? String(body.total_price) : "0";
    const currencyCode = body.currency || body.presentment_currency_code || null;

    // Feature flag guard: if disabled, return 200 but do nothing
    if (!ordersWebhookEnabled) {
      console.log("[Webhook] Order attribution disabled (SHOPIFY_ORDERS_WEBHOOK_ENABLED=false)", {
        shopId: shopRecord.id,
        orderId,
        tokenPresence: "unknown",
        attributionResult: "skipped",
      });
      return Response.json({ success: true, message: "Attribution disabled" });
    }

    // Extract tokens (non-PII)
    const { checkoutToken, cartToken } = extractTokens(body);
    const hasToken = !!checkoutToken || !!cartToken;

    let attributionResult: "direct" | "assisted" | "none" = "none";
    let sessionId: string | null = null;
    let sessionToken: string | null = null;

    // Direct attribution: Find AttributionAttempt within last 48 hours
    if (hasToken) {
      const cutoffTime = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

      let attempt = null;
      if (checkoutToken) {
        attempt = await prisma.attributionAttempt.findFirst({
          where: {
            shopId: shopRecord.id,
            checkoutToken,
            createdAt: { gte: cutoffTime },
          },
          orderBy: { createdAt: "desc" },
        });
      } else if (cartToken) {
        attempt = await prisma.attributionAttempt.findFirst({
          where: {
            shopId: shopRecord.id,
            cartToken,
            createdAt: { gte: cutoffTime },
          },
          orderBy: { createdAt: "desc" },
        });
      }

      if (attempt) {
        sessionId = attempt.sessionId;
        sessionToken = attempt.sessionToken || null;
        attributionResult = "direct";
      } else {
        // Assisted attribution fallback: Find most recent session with product click/ATC/checkout within last 30 minutes
        const sessionCutoffTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

        // Find UsageEvents with relevant types in last 30 minutes
        const recentEvents = await prisma.usageEvent.findMany({
          where: {
            shopId: shopRecord.id,
            eventType: {
              in: [UsageEventType.RECOMMENDATION_CLICKED, UsageEventType.ADD_TO_CART_CLICKED, UsageEventType.CHECKOUT_STARTED],
            },
            createdAt: { gte: sessionCutoffTime },
          },
          orderBy: { createdAt: "desc" },
          take: 100, // Limit to avoid excessive queries
        });

        // Extract session IDs from event metadata
        const sessionIds = new Set<string>();
        for (const event of recentEvents) {
          try {
            const metadata = event.metadata ? JSON.parse(event.metadata) : null;
            if (metadata?.conciergeSessionId && typeof metadata.conciergeSessionId === "string") {
              sessionIds.add(metadata.conciergeSessionId);
            }
          } catch {
            // Skip invalid metadata
          }
        }

        // Find the most recent session from those IDs
        if (sessionIds.size > 0) {
          const session = await prisma.conciergeSession.findFirst({
            where: {
              shopId: shopRecord.id,
              id: { in: Array.from(sessionIds) },
            },
            orderBy: { createdAt: "desc" },
          });

          if (session) {
            sessionId = session.id;
            sessionToken = session.publicToken;
            attributionResult = "assisted";
          }
        }
      }
    }

    // Create OrderAttribution if we have a match
    if (sessionId && attributionResult !== "none") {
      await upsertOrderAttribution({
        shopId: shopRecord.id,
        orderId,
        sessionId,
        sessionToken: sessionToken || null,
        attributionType: attributionResult,
        totalPrice,
        currencyCode: currencyCode ? String(currencyCode) : null,
        orderNumber,
      });

      console.log("[Webhook] Order attributed:", {
        shopId: shopRecord.id,
        orderId,
        tokenPresence: hasToken ? "yes" : "no",
        attributionResult,
      });
    } else {
      console.log("[Webhook] Order not attributed:", {
        shopId: shopRecord.id,
        orderId,
        tokenPresence: hasToken ? "yes" : "no",
        attributionResult: "none",
      });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing orders/create:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};
