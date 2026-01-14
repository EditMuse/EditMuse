import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { getConciergeSessionByToken } from "~/models/concierge.server";

/**
 * Webhook handler for orders/create event from Shopify
 * This webhook is triggered when a new order is created in the store.
 * 
 * NOTE: This webhook requires Shopify approval for protected customer data.
 * Orders tracking will only work if this webhook is enabled.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Webhook] orders/create");

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate webhook
    const { shop, topic } = await authenticate.webhook(request);
    console.log(`[Webhook] Received ${topic} webhook for ${shop}`);

    const body = await request.json();

    // Find shop
    const shopRecord = await prisma.shop.findUnique({
      where: { domain: shop },
    });

    if (!shopRecord) {
      console.error("[Webhook] Shop not found:", shop);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract order information
    const orderId = String(body.id || "");
    const orderNumber = body.order_number ? String(body.order_number) : null;
    const orderName = body.name ? String(body.name) : null;
    const totalPrice = body.total_price ? String(body.total_price) : "0";
    const currencyCode = body.currency || body.presentment_currency_code || null;
    const lineItems = body.line_items || [];
    const customer = body.customer;
    const noteAttributes = body.note_attributes || [];
    const cartToken = body.cart_token;

    // Extract session token from note attributes (set by frontend tracking)
    let sessionToken: string | null = null;
    for (const attr of noteAttributes) {
      if (attr.name === "_editmuse_sid" && attr.value) {
        sessionToken = String(attr.value);
        break;
      }
    }

    // Also check line item properties for session token
    if (!sessionToken) {
      for (const item of lineItems) {
        const properties = item.properties || [];
        for (const prop of properties) {
          if (prop.name === "_editmuse_sid" && prop.value) {
            sessionToken = String(prop.value);
            break;
          }
        }
        if (sessionToken) break;
      }
    }

    // Determine attribution type and session
    let attributionType: "direct" | "assisted" | "unattributed" = "unattributed";
    let sessionId: string | null = null;

    if (sessionToken) {
      // Try to find session by token
      const session = await getConciergeSessionByToken(sessionToken);
      if (session && session.shopId === shopRecord.id) {
        sessionId = session.id;
        // Direct attribution: order has session token from the same session
        attributionType = "direct";
      } else {
        // Assisted attribution: order has session token but session not found or from different shop
        // This could also be considered "unattributed" depending on business logic
        // For now, we'll mark as "assisted" if we have a token but no session
        attributionType = "assisted";
      }
    }

    // Check if order already exists (prevent duplicates)
    const existing = await prisma.orderAttribution.findFirst({
      where: {
        shopId: shopRecord.id,
        orderId: orderId,
      },
    });

    if (existing) {
      console.log("[Webhook] Order already attributed:", orderId);
      return Response.json({ success: true, message: "Order already attributed" });
    }

    // Create order attribution record
    await prisma.orderAttribution.create({
      data: {
        shopId: shopRecord.id,
        orderId: orderId,
        orderNumber: orderNumber,
        sessionId: sessionId,
        sessionToken: sessionToken,
        attributionType: attributionType,
        totalPrice: totalPrice,
        currencyCode: currencyCode ? String(currencyCode) : null,
      },
    });

    console.log("[Webhook] Order attributed:", {
      orderId,
      orderNumber,
      sessionToken,
      sessionId,
      attributionType,
      totalPrice,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing orders/create:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};
