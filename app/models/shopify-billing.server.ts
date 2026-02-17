/**
 * Shopify Billing API integration (GraphQL)
 */

import shopify, { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { PLANS, creditsToX2 } from "./billing.server";
import { x2ToCredits } from "./billing.server";

type PlanTier = "TRIAL" | "LITE" | "GROWTH" | "SCALE" | "PRO";

// Plan pricing mapping
const PLAN_PRICES: Record<PlanTier, number> = {
  TRIAL: 0,
  LITE: 19,
  GROWTH: 39,
  SCALE: 79,
  PRO: 129,
};

/**
 * GraphQL helper function
 * Priority: admin.graphql > accessToken > offline session
 */
async function runGraphQL(
  shopDomain: string,
  query: string,
  variables?: any,
  opts?: { admin?: any; accessToken?: string }
): Promise<any> {
  // Priority 1: Use admin GraphQL client if available
  if (opts?.admin?.graphql) {
    const response = await opts.admin.graphql(query, { variables: variables || {} });
    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    
    return data.data;
  }

  // Priority 2: Use provided accessToken
  let token = opts?.accessToken;
  
  // Priority 3: Load offline session token
  if (!token) {
    const session = await shopify.sessionStorage.loadSession(shopDomain);
    if (!session || !session.accessToken) {
      throw new Error("No session found for shop. Reinstall app or re-authenticate.");
    }
    token = session.accessToken;
  }

  const apiVersion = "2026-01";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: variables || {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GraphQL API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

/**
 * Check if a shop is a development store
 * Returns true if partnerDevelopment is true
 */
export async function isDevelopmentStore(
  shopDomain: string,
  opts?: { admin?: any; accessToken?: string }
): Promise<boolean> {
  try {
    const query = `
      query {
        shop {
          plan {
            partnerDevelopment
          }
        }
      }
    `;

    const data = await runGraphQL(shopDomain, query, undefined, opts);
    return data.shop?.plan?.partnerDevelopment === true;
  } catch (error) {
    console.warn("[Billing] Failed to check if store is development store:", error);
    // If we can't check, assume it's not a dev store (safer)
    return false;
  }
}

/**
 * Create a recurring subscription charge via Shopify Billing API (GraphQL)
 * Uses appSubscriptionCreate with recurring and usage line items
 */
export async function createRecurringCharge(
  shopDomain: string,
  planTier: PlanTier,
  returnUrl: string,
  opts?: { admin?: any; accessToken?: string }
) {
  // TRIAL tier should not create a Shopify subscription (free plan)
  if (planTier === "TRIAL") {
    return {
      subscriptionGid: null,
      recurringLineItemGid: null,
      usageLineItemGid: null,
      confirmationUrl: null,
      status: null,
      currentPeriodEnd: null,
    };
  }

  const planPrice = PLAN_PRICES[planTier];
  if (!planPrice || planPrice === 0) {
    throw new Error(`Plan ${planTier} does not have a valid price`);
  }

  const plan = PLANS[planTier];
  const subscriptionName = `EditMuse - ${plan.name}`;

  const mutation = `
    mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
      ) {
        appSubscription {
          id
          name
          status
          currentPeriodEnd
          lineItems {
            id
            plan {
              ... on AppPlanV2 {
                pricingDetails {
                  ... on AppRecurringPricing {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                  ... on AppUsagePricing {
                    cappedAmount {
                      amount
                      currencyCode
                    }
                    terms
                  }
                }
              }
            }
          }
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Check if this is a development store - always use test mode for dev stores
  const isDevStore = await isDevelopmentStore(shopDomain, opts);
  
  // Use test mode if:
  // 1. Not in production environment, OR
  // 2. It's a development store (even in production-like environments)
  const useTestMode = process.env.NODE_ENV !== "production" || isDevStore;

  const variables = {
    name: subscriptionName,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: {
              amount: planPrice.toFixed(2),
              currencyCode: "USD",
            },
            interval: "EVERY_30_DAYS",
          },
        },
      },
      {
        plan: {
          appUsagePricingDetails: {
            cappedAmount: {
              amount: "500.00",
              currencyCode: "USD",
            },
            terms: "Usage charges for add-ons and overage credits",
          },
        },
      },
    ],
    returnUrl,
    test: useTestMode,
  };
  
  if (isDevStore) {
    console.log("[Billing] Development store detected - using test mode for subscription creation");
  }

  const data = await runGraphQL(shopDomain, mutation, variables, opts);

  if (data.appSubscriptionCreate?.userErrors?.length > 0) {
    const errors = data.appSubscriptionCreate.userErrors;
    const errorMessages = errors.map((e: any) => e.message).join(", ");
    
    // Check for custom app error
    if (errorMessages.includes("Custom apps cannot use the Billing API")) {
      throw new Error(
        "Billing API is not available for custom apps. " +
        "Please ensure your app is set up as a development or public app in the Shopify Partner Dashboard. " +
        "Custom apps (private apps) cannot use the Billing API."
      );
    }
    
    throw new Error(`User errors: ${JSON.stringify(errors)}`);
  }

  const appSubscription = data.appSubscriptionCreate?.appSubscription;
  const confirmationUrl = data.appSubscriptionCreate?.confirmationUrl;

  if (!appSubscription || !confirmationUrl) {
    throw new Error("Failed to create app subscription");
  }

  // Extract line item GIDs from the created subscription
  const lineItems = appSubscription.lineItems || [];
  const recurringLineItem = lineItems.find((item: any) => {
    // Check pricingDetails structure (AppPlanV2)
    if (item.plan?.pricingDetails?.__typename === "AppRecurringPricing") return true;
    // Legacy check
    if (item.plan?.appRecurringPricing) return true;
    return false;
  });
  const usageLineItem = lineItems.find((item: any) => {
    // Check pricingDetails structure (AppPlanV2)
    if (item.plan?.pricingDetails?.__typename === "AppUsagePricing") return true;
    // Legacy check
    if (item.plan?.appUsagePricing) return true;
    return false;
  });

  return {
    subscriptionGid: appSubscription.id,
    recurringLineItemGid: recurringLineItem?.id,
    usageLineItemGid: usageLineItem?.id,
    confirmationUrl,
    status: appSubscription.status,
    currentPeriodEnd: appSubscription.currentPeriodEnd,
  };
}

/**
 * Get payment history (usage records) for a shop
 */
export async function getPaymentHistory(shopDomain: string, limit: number = 20, opts?: { admin?: any; accessToken?: string }) {
  try {
    const query = `
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            lineItems {
              id
              usageRecords(first: ${limit}, orderBy: CREATED_AT) {
                edges {
                  node {
                    id
                    createdAt
                    description
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await runGraphQL(shopDomain, query, undefined, opts);
    const subscriptions = data.currentAppInstallation?.activeSubscriptions || [];
    
    // Collect all usage records from all subscriptions
    const allRecords: Array<{
      id: string;
      createdAt: string;
      description: string;
      amount: number;
      currencyCode: string;
    }> = [];
    
    subscriptions.forEach((sub: any) => {
      sub.lineItems?.forEach((item: any) => {
        item.usageRecords?.edges?.forEach((edge: any) => {
          const node = edge.node;
          allRecords.push({
            id: node.id,
            createdAt: node.createdAt,
            description: node.description || "Usage charge",
            amount: parseFloat(node.price?.amount || "0"),
            currencyCode: node.price?.currencyCode || "USD",
          });
        });
      });
    });
    
    // Sort by date (newest first)
    return allRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  } catch (error) {
    console.error("[getPaymentHistory] Error:", error);
    return [];
  }
}

/**
 * Get active subscription charge for a shop (GraphQL)
 */
export async function getActiveCharge(shopDomain: string, opts?: { admin?: any; accessToken?: string }) {
  try {
    const query = `
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            currentPeriodEnd
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                  ... on AppUsagePricing {
                    cappedAmount {
                      amount
                      currencyCode
                    }
                    balanceUsed {
                      amount
                      currencyCode
                    }
                    terms
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await runGraphQL(shopDomain, query, undefined, opts);
    const subscriptions = data.currentAppInstallation?.activeSubscriptions || [];

    // Filter all ACTIVE EditMuse subscriptions (case-insensitive)
    const candidates = subscriptions.filter((sub: any) => {
      const status = (sub.status || "").toString().toUpperCase();
      const name = (sub.name || "").toLowerCase();
      return name.includes("editmuse") && status === "ACTIVE";
    });

    if (candidates.length === 0) {
      return null;
    }

    // Determine tier rank from subscription name (higher number = higher tier)
    function tierRank(name: string): number {
      const n = (name || "").toLowerCase();
      if (n.includes("pro")) return 4;
      if (n.includes("scale")) return 3;
      if (n.includes("growth")) return 2;
      if (n.includes("lite")) return 1;
      return 0;
    }

    // Sort by tier rank (highest first) and pick the best one
    const activeSubscription = candidates.sort((a: any, b: any) => 
      tierRank(b.name || "") - tierRank(a.name || "")
    )[0];

    // Extract line items - parse from pricingDetails.__typename
    const lineItems = activeSubscription.lineItems || [];
    const recurringLineItem = lineItems.find((item: any) => 
      item.plan?.pricingDetails?.__typename === "AppRecurringPricing"
    );
    const usageLineItem = lineItems.find((item: any) => 
      item.plan?.pricingDetails?.__typename === "AppUsagePricing"
    );

    // Extract usage billing info from usage line item
    const usagePricing = usageLineItem?.plan?.pricingDetails;
    const usageCapAmountUsd = usagePricing?.cappedAmount?.amount 
      ? parseFloat(usagePricing.cappedAmount.amount) 
      : null;
    const usageBalanceUsedUsd = usagePricing?.balanceUsed?.amount 
      ? parseFloat(usagePricing.balanceUsed.amount) 
      : null;
    
    // Note: balanceUsed may not update immediately after creating a usage charge
    // Shopify updates this field asynchronously, typically during billing cycle processing

    const normalizedStatus = (activeSubscription.status || "").toString().toLowerCase();

    return {
      id: activeSubscription.id,
      name: activeSubscription.name,
      status: activeSubscription.status || "ACTIVE",
      normalizedStatus: normalizedStatus,
      currentPeriodEnd: activeSubscription.currentPeriodEnd,
      subscriptionGid: activeSubscription.id,
      recurringLineItemGid: recurringLineItem?.id || null,
      usageLineItemGid: usageLineItem?.id || null,
      lineItems: lineItems, // Include full lineItems for updateSubscriptionFromCharge
      usageCapAmountUsd,
      usageBalanceUsedUsd,
    };
  } catch (error) {
    console.error("[Billing] Error fetching active charge:", error);
    return null;
  }
}

/**
 * Update subscription after charge is activated
 * Syncs from active GraphQL subscription
 */
export async function updateSubscriptionFromCharge(
  shopId: string,
  shopDomain: string,
  planTier?: PlanTier,
  opts?: { admin?: any; accessToken?: string }
) {
  // Get active subscription from Shopify
  const activeCharge = await getActiveCharge(shopDomain, opts);
  
  if (!activeCharge) {
    throw new Error("No active subscription found");
  }

  // ALWAYS derive planTier from Shopify subscription name (case-insensitive)
  const name = (activeCharge.name || "").toLowerCase();
  let derivedTier: PlanTier | null = null;
  
  if (name.includes("lite")) {
    derivedTier = "LITE";
  } else if (name.includes("growth")) {
    derivedTier = "GROWTH";
  } else if (name.includes("scale")) {
    derivedTier = "SCALE";
  } else if (name.includes("pro")) {
    derivedTier = "PRO";
  }
  
  // Use derived tier first, then fallback to planTier param, then default to LITE
  const finalPlanTier = derivedTier || planTier || "LITE";

  const currentPeriodEnd = activeCharge.currentPeriodEnd 
    ? new Date(activeCharge.currentPeriodEnd)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Extract line item GIDs from activeCharge lineItems
  const lineItems = (activeCharge as any).lineItems || [];
  const recurringItem = lineItems.find((li: any) => 
    li.plan?.pricingDetails?.__typename === "AppRecurringPricing"
  );
  const usageItem = lineItems.find((li: any) => 
    li.plan?.pricingDetails?.__typename === "AppUsagePricing"
  );

  // Extract GIDs from parsed line items
  const recurringLineItemGid = recurringItem?.id || null;
  const usageLineItemGid = usageItem?.id || null;

  // Get the new plan's included credits and experiences
  const newPlan = PLANS[finalPlanTier];
  const newCreditsIncludedX2 = creditsToX2(newPlan.includedCredits);
  const newExperiencesIncluded = newPlan.experiences || 0;

  // Get current subscription to check if plan tier changed and for grace period restoration
  const currentSubscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  const planTierChanged = currentSubscription?.planTier !== finalPlanTier;

  // Check if resubscribing within grace period (30 days) and restore preserved credits and recurring add-ons
  let restoredCreditsAddonX2 = 0;
  let restoredExperiencesAddon = 0;
  
  if (currentSubscription?.cancelledAt) {
    const cancelledAt = currentSubscription.cancelledAt;
    const now = new Date();
    const daysSinceCancellation = (now.getTime() - cancelledAt.getTime()) / (1000 * 60 * 60 * 24);
    const GRACE_PERIOD_DAYS = 30;

    if (daysSinceCancellation <= GRACE_PERIOD_DAYS) {
      // Restore preserved one-time credits
      restoredCreditsAddonX2 = currentSubscription.preservedCreditsAddonX2 || 0;
      // Restore preserved recurring add-ons
      restoredExperiencesAddon = currentSubscription.preservedExperiencesAddon || 0;
      
      console.log("[Billing] Restoring preserved add-ons within grace period", {
        shop: shopDomain,
        preservedCredits: restoredCreditsAddonX2 / 2, // Convert X2 to actual credits for logging
        preservedExperiencesAddon: restoredExperiencesAddon,
        daysSinceCancellation: Math.floor(daysSinceCancellation),
      });
    } else {
      console.log("[Billing] Grace period expired, not restoring preserved add-ons", {
        shop: shopDomain,
        daysSinceCancellation: Math.floor(daysSinceCancellation),
        gracePeriodDays: GRACE_PERIOD_DAYS,
      });
    }
  }

  // Normalize status to lowercase for DB convention
  const normalizedStatus = activeCharge.normalizedStatus || (activeCharge.status || "").toString().toLowerCase();
  const dbStatus = normalizedStatus === "active" ? "active" : normalizedStatus;

  await prisma.subscription.update({
    where: { shopId },
    data: {
      planTier: finalPlanTier,
      shopifySubscriptionGid: activeCharge.subscriptionGid,
      shopifyRecurringLineItemGid: recurringLineItemGid,
      shopifyUsageLineItemGid: usageLineItemGid,
      status: dbStatus,
      currentPeriodStart: new Date(),
      currentPeriodEnd,
      // Restore preserved credits and recurring add-ons if within grace period
      ...(currentSubscription?.cancelledAt && {
        creditsAddonX2: restoredCreditsAddonX2,
        experiencesAddon: restoredExperiencesAddon,
        // Restore enable dates for monthly billing from enable date
        experiencesAddonEnabledAt: currentSubscription.preservedExperiencesAddonEnabledAt,
        preservedCreditsAddonX2: 0, // Clear preserved credits after restoration
        preservedExperiencesAddon: 0, // Clear preserved experiences addon after restoration
        preservedExperiencesAddonEnabledAt: null, // Clear preserved enable date after restoration
        cancelledAt: null, // Clear cancellation date
      }),
      // Update plan-specific fields when tier changes
      // Also reset usage on upgrade (new cycle starts)
      // creditsAddonX2 persists across upgrades - customers keep their purchased credits
      ...(planTierChanged && {
        creditsIncludedX2: newCreditsIncludedX2,
        experiencesIncluded: newExperiencesIncluded,
        creditsUsedX2: 0, // Reset usage on plan upgrade (new cycle)
        // creditsAddonX2 is NOT reset - one-time add-on credits persist until used up
      }),
    },
  });

  console.log("[Billing] Synced subscription", { 
    shop: shopDomain, 
    planTier: finalPlanTier,
    planTierChanged,
    hasUsage: Boolean(usageLineItemGid),
    creditsIncludedX2: planTierChanged ? newCreditsIncludedX2 : undefined,
    experiencesIncluded: planTierChanged ? newExperiencesIncluded : undefined,
    restoredCreditsAddonX2: restoredCreditsAddonX2 > 0 ? restoredCreditsAddonX2 : undefined,
    restoredExperiencesAddon: restoredExperiencesAddon > 0 ? restoredExperiencesAddon : undefined,
  });
}

/**
 * Cancel a Shopify subscription
 * Uses appSubscriptionCancel mutation
 */
export async function cancelSubscription(
  shopDomain: string,
  subscriptionGid: string,
  opts?: { admin?: any; accessToken?: string }
): Promise<{ success: boolean }> {
  const mutation = `
    mutation appSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: subscriptionGid,
  };

  const data = await runGraphQL(shopDomain, mutation, variables, opts);
  const payload = data?.appSubscriptionCancel;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(userErrors[0]?.message || "Failed to cancel subscription");
  }

  if (!payload?.appSubscription) {
    throw new Error("Subscription cancellation failed");
  }

  return {
    success: true,
  };
}

/**
 * Update subscription with Shopify GIDs after activation
 */
export async function updateSubscriptionGids(
  shopId: string,
  shopifySubscriptionGid: string,
  shopifyRecurringLineItemGid: string,
  shopifyUsageLineItemGid: string,
  currentPeriodStart?: Date,
  currentPeriodEnd?: Date
) {
  await prisma.subscription.update({
    where: { shopId },
    data: {
      shopifySubscriptionGid,
      shopifyRecurringLineItemGid,
      shopifyUsageLineItemGid,
      ...(currentPeriodStart && { currentPeriodStart }),
      ...(currentPeriodEnd && { currentPeriodEnd }),
    },
  });
}

/**
 * Ensure usage line item GID exists for a subscription
 * If missing, attempts to sync from Shopify and throws if still missing
 */
export async function ensureUsageLineItemGid(
  shopId: string,
  shopDomain: string,
  opts?: { admin?: any; accessToken?: string }
): Promise<string> {
  // Load subscription from prisma
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!subscription) {
    throw new Error(`Subscription not found for shop: ${shopId}`);
  }

  // If usage line item GID exists, return it
  if (subscription.shopifyUsageLineItemGid) {
    return subscription.shopifyUsageLineItemGid;
  }

  // Attempt to sync from Shopify
  try {
    await updateSubscriptionFromCharge(shopId, shopDomain, undefined, opts);
  } catch (error) {
    console.error("[Billing] Error syncing subscription from charge:", error);
  }

  // Reload subscription
  const updatedSubscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!updatedSubscription || !updatedSubscription.shopifyUsageLineItemGid) {
    throw new Error(
      "No usage line item GID found. This subscription isn't set up for usage billing. Please upgrade again to re-create the subscription with usage pricing."
    );
  }

  return updatedSubscription.shopifyUsageLineItemGid;
}

/**
 * Create a usage charge via Shopify Billing API
 * Generic function for creating usage records with idempotency
 */
export async function createUsageCharge(params: {
  shopDomain: string;
  subscriptionUsageLineItemGid: string;
  amountUsd: number;
  description: string;
  idempotencyKey: string;
  opts?: { admin?: any; accessToken?: string };
}): Promise<{ usageRecordId: string }> {
  const { shopDomain, subscriptionUsageLineItemGid, amountUsd, description, idempotencyKey, opts } = params;

  const mutation = `
    mutation appUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!, $idempotencyKey: String!) {
      appUsageRecordCreate(
        subscriptionLineItemId: $subscriptionLineItemId
        price: $price
        description: $description
        idempotencyKey: $idempotencyKey
      ) {
        appUsageRecord {
          id
          description
          price {
            amount
            currencyCode
          }
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    subscriptionLineItemId: subscriptionUsageLineItemGid,
    price: {
      amount: amountUsd.toFixed(2),
      currencyCode: "USD",
    },
    description,
    idempotencyKey,
  };

  const data = await runGraphQL(shopDomain, mutation, variables, opts);

  const payload = data?.appUsageRecordCreate;
  const userErrors = payload?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(userErrors[0]?.message || "Usage charge failed");
  }

  if (!payload?.appUsageRecord?.id) {
    throw new Error("Usage charge not created");
  }

  console.log("[Billing] Usage charge created successfully:", {
    id: payload.appUsageRecord.id,
    amount: payload.appUsageRecord.price?.amount,
    description: payload.appUsageRecord.description,
  });

  return { usageRecordId: payload.appUsageRecord.id };
}

/**
 * Create usage charge for overage credits
 */
export async function createOverageUsageCharge(params: {
  shopDomain: string;
  overageCredits: number;
  overageRate: number;
  sessionPublicToken: string;
  opts?: { admin?: any; accessToken?: string };
}): Promise<void> {
  const { shopDomain, overageCredits, overageRate, sessionPublicToken, opts } = params;

  if (overageCredits <= 0) {
    return;
  }

  // Get subscription to find usage line item GID
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    throw new Error(`Shop not found: ${shopDomain}`);
  }

  // Ensure usage line item GID exists (will sync if missing)
  let usageLineItemGid: string;
  try {
    usageLineItemGid = await ensureUsageLineItemGid(shop.id, shopDomain, opts);
  } catch (error) {
    console.warn("[Billing] No usage line item GID found, skipping overage charge:", error);
    return;
  }

  const amountUsd = overageCredits * overageRate;
  const description = `EditMuse overage - ${overageCredits.toFixed(1)} credits`;
  const idempotencyKey = `overage:${sessionPublicToken}`;

  try {
    await createUsageCharge({
      shopDomain,
      subscriptionUsageLineItemGid: usageLineItemGid,
      amountUsd,
      description,
      idempotencyKey,
      opts,
    });
  } catch (error) {
    console.error("[Billing] Error creating overage usage charge (non-fatal):", error);
    // Don't throw - this should never fail the request
  }
}

/**
 * Purchase an add-on usage charge
 */
export async function purchaseAddonUsageCharge(params: {
  shopDomain: string;
  addonKey: string;
  priceUsd: number;
  cycleKey: string;
  opts?: { admin?: any; accessToken?: string };
}): Promise<{ usageRecordId: string }> {
  const { shopDomain, addonKey, priceUsd, cycleKey, opts } = params;

  // Get subscription to find usage line item GID
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    throw new Error(`Shop not found: ${shopDomain}`);
  }

  // Ensure usage line item GID exists (will sync if missing)
  const usageLineItemGid = await ensureUsageLineItemGid(shop.id, shopDomain, opts);

  const description = `EditMuse addon - ${addonKey}`;
  const idempotencyKey = `addon:${addonKey}:${cycleKey}`;

  return await createUsageCharge({
    shopDomain,
    subscriptionUsageLineItemGid: usageLineItemGid,
    amountUsd: priceUsd,
    description,
    idempotencyKey,
    opts,
  });
}

/**
 * Charge recurring add-on for a billing cycle (once per cycle)
 * Used for recurring monthly add-ons: experience packs
 */
export async function chargeRecurringAddonForCycle(params: {
  shopDomain: string;
  addonKey: "exp_3" | "exp_10";
  priceUsd: number;
  cycleKey: string;
  opts?: { admin?: any; accessToken?: string };
}): Promise<{ usageRecordId: string }> {
  const { shopDomain, addonKey, priceUsd, cycleKey, opts } = params;

  // Get subscription to find usage line item GID
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    throw new Error(`Shop not found: ${shopDomain}`);
  }

  // Ensure usage line item GID exists (will sync if missing)
  const usageLineItemGid = await ensureUsageLineItemGid(shop.id, shopDomain, opts);

  const description = `EditMuse recurring addon (${addonKey}) - ${cycleKey}`;
  const idempotencyKey = `recurring-addon:${addonKey}:${cycleKey}`;

  return await createUsageCharge({
    shopDomain,
    subscriptionUsageLineItemGid: usageLineItemGid,
    amountUsd: priceUsd,
    description,
    idempotencyKey,
    opts,
  });
}

/**
 * Purchase an add-on (creates usage charge and updates Subscription)
 * Kept for backward compatibility
 */
export async function purchaseAddon(params: {
  shopId: string;
  shopDomain: string;
  addonKey: string;
  cycleKey: string;
}): Promise<void> {
  const { shopId, shopDomain, addonKey, cycleKey } = params;

  // Add-on definitions
  const addons: Record<string, { price: number; description: string; type: "credits" | "experiences" | "reporting"; amount?: number }> = {
    credits_2000: { price: 49, description: "2,000 Credits Pack", type: "credits", amount: 2000 },
    credits_5000: { price: 99, description: "5,000 Credits Pack", type: "credits", amount: 5000 },
    exp_3: { price: 15, description: "+3 Experiences Pack", type: "experiences", amount: 3 },
    exp_10: { price: 39, description: "+10 Experiences Pack", type: "experiences", amount: 10 },
  };

  const addon = addons[addonKey];
  if (!addon) {
    throw new Error(`Unknown add-on: ${addonKey}`);
  }

  // Create usage charge (return value not used in this legacy function)
  await purchaseAddonUsageCharge({
    shopDomain,
    addonKey,
    priceUsd: addon.price,
    cycleKey,
  });

  // Update subscription add-on fields
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!subscription) {
    throw new Error(`Subscription not found for shop: ${shopId}`);
  }

  const updateData: any = {};
  
  if (addon.type === "credits" && addon.amount) {
    // Convert credits to x2 units
    const creditsX2 = Math.round(addon.amount * 2);
    updateData.creditsAddonX2 = (subscription.creditsAddonX2 || 0) + creditsX2;
  } else if (addon.type === "experiences" && addon.amount) {
    updateData.experiencesAddon = (subscription.experiencesAddon || 0) + addon.amount;
  }

  await prisma.subscription.update({
    where: { shopId },
    data: updateData,
  });
}

