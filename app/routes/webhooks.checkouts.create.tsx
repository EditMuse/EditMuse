import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

/**
 * Webhook handler for checkouts/create event from Shopify
 * This webhook is triggered when a checkout is created in the store.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Webhook] checkouts/create");

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate webhook
    const { shop, topic } = await authenticate.webhook(request);
    console.log(`[Webhook] Received ${topic} webhook for ${shop}`);

    const body = await request.json();
    console.log("[Webhook] checkouts/create payload:", JSON.stringify(body, null, 2));

    // Find shop
    const shopRecord = await prisma.shop.findUnique({
      where: { domain: shop },
    });

    if (!shopRecord) {
      console.error("[Webhook] Shop not found:", shop);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract checkout information
    const checkoutToken = body.token;
    const checkoutId = body.id;
    const lineItems = body.line_items || [];
    const noteAttributes = body.note_attributes || [];
    const customer = body.customer;
    const totalPrice = body.total_price;
    const cartToken = body.cart_token;

    // TODO: Add your checkout processing logic here
    // Examples:
    // - Track checkout creation events
    // - Link checkouts to concierge sessions (via note_attributes or cart_token)
    // - Update analytics
    // - Track conversion funnel metrics

    console.log("[Webhook] Checkout processed:", {
      checkoutToken,
      checkoutId,
      cartToken,
      totalPrice,
      lineItemCount: lineItems.length,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing checkouts/create:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};

