import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { updateSubscriptionFromCharge } from "~/models/shopify-billing.server";

type PlanTier = "TRIAL" | "BASIC" | "STARTER" | "PRO";

/**
 * Webhook handler for subscription_updated event from Shopify Billing API
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[Webhook] billing/subscription_updated");

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Authenticate webhook
    await authenticate.webhook(request);

    const body = await request.json();
    console.log("[Webhook] billing/subscription_updated payload:", JSON.stringify(body, null, 2));

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

    // Extract subscription info
    const chargeId = body.charge_id || body.id;
    const subscriptionId = body.subscription_id || body.id;
    const status = body.status || "active";
    
    // Determine plan tier
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
    await (prisma as any).subscription.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        planTier,
        shopifyChargeId: chargeId?.toString() || null,
        shopifySubscriptionId: subscriptionId?.toString() || null,
        status,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      update: {
        planTier,
        shopifyChargeId: chargeId?.toString() || null,
        shopifySubscriptionId: subscriptionId?.toString() || null,
        status,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    console.log("[Webhook] Subscription updated for shop:", shopDomain, "plan:", planTier, "status:", status);

    return Response.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Error processing subscription_updated:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
};

