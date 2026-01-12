import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { updateSubscriptionFromCharge } from "~/models/shopify-billing.server";

type PlanTier = "TRIAL" | "BASIC" | "STARTER" | "PRO";

/**
 * Webhook handler for subscription_created event from Shopify Billing API
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Webhook] billing/subscription_created");

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate webhook
    await authenticate.webhook(request);

    const body = await request.json();
    console.log("[Webhook] billing/subscription_created payload:", JSON.stringify(body, null, 2));

    const shopDomain = body.shop_domain || body.shop;
    if (!shopDomain) {
      console.error("[Webhook] Missing shop_domain in payload");
      return Response.json({ error: "Missing shop_domain" }, { status: 400 });
    }

    // Find shop
    const shop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
    });

    if (!shop) {
      console.error("[Webhook] Shop not found:", shopDomain);
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // Extract subscription info from webhook payload
    // Note: Actual payload structure may vary - adjust based on Shopify's webhook format
    const chargeId = body.charge_id || body.id;
    const subscriptionId = body.subscription_id || body.id;
    
    // Determine plan tier from charge name or amount
    // This is a simplified mapping - adjust based on your actual charge structure
    let planTier: PlanTier = "BASIC";
    const chargeName = body.name || "";
    const chargeAmount = body.price || body.amount || 0;

    if (chargeName.includes("Pro") || chargeAmount >= 35) {
      planTier = "PRO";
    } else if (chargeName.includes("Starter") || chargeAmount >= 15) {
      planTier = "STARTER";
    } else {
      planTier = "BASIC";
    }

    // Update subscription
    await updateSubscriptionFromCharge(
      shop.id,
      chargeId?.toString() || "",
      subscriptionId?.toString() || "",
      planTier
    );

    console.log("[Webhook] Subscription updated for shop:", shopDomain, "plan:", planTier);

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing subscription_created:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};

