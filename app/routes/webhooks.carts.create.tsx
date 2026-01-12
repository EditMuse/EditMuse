import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

/**
 * Webhook handler for carts/create event from Shopify
 * This webhook is triggered when a cart is created in the store.
 * 
 * Note: Shopify also has checkouts/create webhook for checkout creation.
 * If you need checkout-specific handling, create webhooks.checkouts.create.tsx
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Webhook] carts/create");

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate webhook
    const { shop, topic } = await authenticate.webhook(request);
    console.log(`[Webhook] Received ${topic} webhook for ${shop}`);

    const body = await request.json();
    console.log("[Webhook] carts/create payload:", JSON.stringify(body, null, 2));

    // Find shop
    const shopRecord = await prisma.shop.findUnique({
      where: { domain: shop },
    });

    if (!shopRecord) {
      console.error("[Webhook] Shop not found:", shop);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract cart information
    const cartToken = body.token;
    const cartId = body.id;
    const lineItems = body.line_items || [];
    const noteAttributes = body.note_attributes || [];
    const customer = body.customer;

    // TODO: Add your cart processing logic here
    // Examples:
    // - Track cart creation events
    // - Link carts to concierge sessions (via note_attributes or cart_token)
    // - Update analytics
    // - Track abandoned cart metrics

    console.log("[Webhook] Cart processed:", {
      cartToken,
      cartId,
      lineItemCount: lineItems.length,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing carts/create:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};

