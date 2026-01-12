import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

/**
 * Webhook handler for orders/create event from Shopify
 * This webhook is triggered when a new order is created in the store.
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
    console.log("[Webhook] orders/create payload:", JSON.stringify(body, null, 2));

    // Find shop
    const shopRecord = await prisma.shop.findUnique({
      where: { domain: shop },
    });

    if (!shopRecord) {
      console.error("[Webhook] Shop not found:", shop);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract order information
    const orderId = body.id;
    const orderNumber = body.order_number;
    const orderName = body.name;
    const totalPrice = body.total_price;
    const lineItems = body.line_items || [];
    const customer = body.customer;
    const noteAttributes = body.note_attributes || [];

    // TODO: Add your order processing logic here
    // Examples:
    // - Track conversion events
    // - Link orders to concierge sessions (via note_attributes or cart_token)
    // - Update analytics
    // - Send notifications

    console.log("[Webhook] Order processed:", {
      orderId,
      orderNumber,
      orderName,
      totalPrice,
      lineItemCount: lineItems.length,
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

