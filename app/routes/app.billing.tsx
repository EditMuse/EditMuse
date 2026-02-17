import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, redirect, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "~/db.server";

// Helper function for consistent JSON responses
const json = (data: any, init?: ResponseInit) => Response.json(data, init);
import { 
  getCurrentPlan, 
  isInTrial, 
  getCurrentMonthUsage,
  getEntitlements,
  getBillingCycleKey,
  applyAddonToSubscription,
  setRecurringExperiencePack,
  disableRecurringExperiencePack,
  getOrCreateSubscription,
  chargeRecurringAddonsMonthly,
  markSubscriptionAsCancelled,
  PLANS,
  type PlanInfo,
  creditsToX2,
  computeCreditsBurned
} from "~/models/billing.server";
import { createRecurringCharge, purchaseAddon, updateSubscriptionFromCharge, purchaseAddonUsageCharge, chargeRecurringAddonForCycle, getActiveCharge, getPaymentHistory, cancelSubscription, isDevelopmentStore } from "~/models/shopify-billing.server";

type PlanTier = "TRIAL" | "LITE" | "GROWTH" | "SCALE" | "PRO";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Handle returnUrl callback after Shopify approval (GET request)
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const planParam = url.searchParams.get("plan");
  
  if (shopParam && shopParam === session.shop && planParam) {
    // Merchant returned from Shopify billing approval
    // Always sync from Shopify's real subscription; don't trust plan param
    try {
      await updateSubscriptionFromCharge(shop.id, session.shop, undefined, { admin });
      // Redirect back to billing page without plan param (success handled by banner)
      return redirect(`/app/billing?shop=${session.shop}&approved=true`);
    } catch (error) {
      console.error("[Billing] Error syncing subscription:", error);
      return redirect(`/app/billing?shop=${session.shop}&error=sync_failed`);
    }
  }

  // Best-effort sync to ensure billing page reflects true Shopify subscription
  // (Do not throw; loader must still render even if sync fails)
  try {
    await updateSubscriptionFromCharge(shop.id, session.shop, undefined, { admin });
  } catch (e) {
    console.warn("[Billing] Background sync skipped", String(e));
  }

  // Ensure subscription exists and handle rollover (this may trigger rollover)
  await getOrCreateSubscription(shop.id);
  
  // Charge recurring add-ons monthly from their enable date (not cycle rollover)
  await chargeRecurringAddonsMonthly(shop.id);

  const currentPlan = await getCurrentPlan(shop.id);
  const inTrial = await isInTrial(shop.id);
  const usage = await getCurrentMonthUsage(shop.id);
  const entitlements = await getEntitlements(shop.id);
  const subscription = await prisma.subscription.findUnique({
    where: { shopId: shop.id },
  });

  // Get experience count for display
  const experienceCount = await prisma.experience.count({
    where: { shopId: shop.id },
  });

  // Get Shopify usage billing info
  const activeCharge = await getActiveCharge(session.shop, { admin });
  const usageBalanceUsedUsd = activeCharge?.usageBalanceUsedUsd ?? null;
  const usageCapAmountUsd = activeCharge?.usageCapAmountUsd ?? null;

  // Calculate available plans in the loader (server-side)
  // If cancelled, show all paid plans. Otherwise, show plans above current tier
  const allPlansList: PlanInfo[] = Object.values(PLANS);
  const availablePlans = subscription?.status === "cancelled"
    ? allPlansList.filter((plan) => plan.tier !== "TRIAL")
    : allPlansList.filter(
        (plan) => plan.tier !== "TRIAL" && plan.tier !== currentPlan.tier
      );

  // Check for success/error params from redirect
  const approved = url.searchParams.get("approved") === "true";
  const errorParam = url.searchParams.get("error");

  // Get payment history (with error handling)
  let paymentHistory: Array<{ id: string; createdAt: string; description: string; amount: number; currencyCode: string }> = [];
  try {
    paymentHistory = await getPaymentHistory(session.shop, 20, { admin });
  } catch (error) {
    console.error("[Billing] Error fetching payment history:", error);
    // Continue with empty array if payment history fails
  }

  // Get usage breakdown by experience
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  let usageByExperienceData: Array<{
    experienceId: string | null;
    _count: { id: number };
    _sum: { resultCount: number | null };
  }> = [];
  
  try {
    const groupByResult = await prisma.conciergeSession.groupBy({
      by: ["experienceId"],
      where: {
        shopId: shop.id,
        createdAt: { gte: thirtyDaysAgo },
        result: { isNot: null },
      },
      _count: { id: true },
      _sum: { resultCount: true },
    });
    usageByExperienceData = groupByResult;
  } catch (error) {
    console.error("[Billing] Error fetching usage by experience:", error);
    // Continue with empty array if query fails
  }

  // Optimize: Fetch all experiences in one query instead of in a loop
  const experienceIds = usageByExperienceData
    .map(item => item.experienceId)
    .filter((id): id is string => id !== null);
  
  const experiences = experienceIds.length > 0
    ? await prisma.experience.findMany({
        where: { id: { in: experienceIds } },
        select: { id: true, name: true },
      })
    : [];
  
  const experienceNameMap = new Map(experiences.map(exp => [exp.id, exp.name]));

  // Build experience map with accurate credit calculations
  const experienceMap = new Map<string, { name: string; sessions: number; credits: number }>();
  
  // Process in parallel batches to avoid timeout
  const batchSize = 5;
  for (let i = 0; i < usageByExperienceData.length; i += batchSize) {
    const batch = usageByExperienceData.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (item) => {
        if (item.experienceId && item._count && typeof item._count === 'object' && 'id' in item._count && item._count.id !== undefined) {
          const expName = experienceNameMap.get(item.experienceId);
          if (expName) {
            try {
              // Fetch sessions for this experience to calculate credits accurately
              const sessions = await prisma.conciergeSession.findMany({
                where: {
                  experienceId: item.experienceId,
                  shopId: shop.id,
                  createdAt: { gte: thirtyDaysAgo },
                  result: { isNot: null },
                  resultCount: { not: null } as any,
                },
                select: { resultCount: true },
              });
              
              // Calculate total credits by summing credits for each session
              const totalCredits = sessions.reduce((sum, session) => {
                if (session.resultCount) {
                  return sum + computeCreditsBurned(session.resultCount);
                }
                return sum;
              }, 0);
              
              experienceMap.set(item.experienceId, {
                name: expName,
                sessions: item._count.id,
                credits: totalCredits,
              });
            } catch (error) {
              console.error(`[Billing] Error calculating credits for experience ${item.experienceId}:`, error);
              // Fallback: use approximate calculation if session fetch fails
              const resultCount = item._sum?.resultCount || 0;
              const estimatedCredits = resultCount > 0 ? computeCreditsBurned(Math.min(resultCount, 16)) : 0;
              experienceMap.set(item.experienceId, {
                name: expName,
                sessions: item._count.id,
                credits: estimatedCredits,
              });
            }
          }
        }
      })
    );
  }

  // Plan recommendations
  // Use totalCreditsBurned from UsageEvent table (already calculated correctly using computeCreditsBurned)
  const currentMonthCredits = usage.totalCreditsBurned || 0;
  const currentPlanCredits = currentPlan.includedCredits;
  const usagePercent = currentPlanCredits > 0 ? (currentMonthCredits / currentPlanCredits) : 0;
  
  let recommendedPlan: PlanInfo | null = null;
  if (usagePercent > 0.8 && currentPlan.tier !== "PRO") {
    // Recommend upgrade if using >80% of credits
    const planTiers: PlanTier[] = ["LITE", "GROWTH", "SCALE", "PRO"];
    const currentIndex = planTiers.indexOf(currentPlan.tier as PlanTier);
    if (currentIndex < planTiers.length - 1) {
      recommendedPlan = PLANS[planTiers[currentIndex + 1]];
    }
  }

  return {
    currentPlan,
    inTrial,
    usage,
    entitlements,
    subscription,
    experienceCount,
    shopDomain: session.shop,
    availablePlans,
    approved,
    errorParam,
    usageBalanceUsedUsd,
    usageCapAmountUsd,
    currentPeriodEnd: activeCharge?.currentPeriodEnd ?? null,
    allPlans: allPlansList satisfies PlanInfo[], // Pass PLANS through loader to avoid client-side import
    paymentHistory,
    usageByExperience: Array.from(experienceMap.values()),
    recommendedPlan,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    return json({ error: "Shop not found" });
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

    if (actionType === "upgrade") {
    const planTier = formData.get("planTier") as string;
    
    const validPlans: PlanTier[] = ["LITE", "GROWTH", "SCALE", "PRO"];
    if (!planTier || !validPlans.includes(planTier as PlanTier)) {
      return json({ error: "Invalid plan selected" });
    }

    // TRIAL tier: just update DB, no Shopify subscription
    if (planTier === "TRIAL") {
      await prisma.subscription.update({
        where: { shopId: shop.id },
        data: { planTier: "TRIAL" },
      });
      return json({ approved: true });
    }

    // All paid plans go through Shopify billing (test mode for dev stores, real for production)
    try {
      // Create return URL with proper base (never localhost)
      const origin = process.env.SHOPIFY_APP_URL?.startsWith("https://")
        ? process.env.SHOPIFY_APP_URL
        : new URL(request.url).origin;
      
      const returnUrl = `${origin}/app/billing?shop=${session.shop}&plan=${planTier}`;
      
      const result = await createRecurringCharge(
        session.shop,
        planTier as PlanTier,
        returnUrl,
        { admin }
      );

      if (!result.confirmationUrl) {
        return json({ error: "Failed to create subscription" });
      }

      // Return confirmationUrl for client-side redirect (embedded app fix)
      return json({ ok: true, confirmationUrl: result.confirmationUrl });
    } catch (error) {
      console.error("[Billing] Error creating charge:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to create billing charge";
      
      // Provide helpful message for custom app error
      if (errorMessage.includes("Custom apps cannot use the Billing API")) {
        return json({ 
          error: "Billing is not available. Your app needs to be set up as a development or public app (not a custom app) in the Shopify Partner Dashboard to use billing features." 
        });
      }
      
      return json({ 
        error: errorMessage
      });
    }
  }

  // Add-on purchase actions
  // ONE-TIME: credits_2000, credits_5000 (reset each cycle)
  // RECURRING: exp_3, exp_10 (persist across cycles, charge monthly)
  const addonActions: Record<string, { price: number; key: string; type: "one-time" | "recurring" }> = {
    buy_addon_credits_2000: { price: 49, key: "credits_2000", type: "one-time" },
    buy_addon_credits_5000: { price: 99, key: "credits_5000", type: "one-time" },
    buy_addon_exp_3: { price: 15, key: "exp_3", type: "recurring" },
    buy_addon_exp_10: { price: 39, key: "exp_10", type: "recurring" },
  };

  if (addonActions[actionType]) {
    const addon = addonActions[actionType];
    
    // Get subscription to determine cycle key and check status
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
    });

    if (!subscription) {
      return json({ error: "Subscription not found. Please upgrade to a paid plan first." }, { status: 400 });
    }

    // Block add-on purchases if subscription is cancelled
    if (subscription.status === "cancelled") {
      return json({ 
        error: "Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons." 
      }, { status: 400 });
    }

    // Check if shop has an active Shopify subscription (not TRIAL)
    if (subscription.planTier === "TRIAL") {
      return json({ 
        error: "Add-ons are only available for paid plans. Please upgrade to a paid plan first." 
      }, { status: 400 });
    }

    // Check if subscription has an active Shopify subscription GID
    // For dev stores that skipped Shopify billing, we need to create a test subscription first
    if (!subscription.shopifySubscriptionGid) {
      const isDevStore = await isDevelopmentStore(session.shop, { admin });
      
      if (isDevStore) {
        // For dev stores, create a test Shopify subscription so add-ons can use test billing
        console.log("[Billing] Dev store has no Shopify subscription - creating test subscription for add-on billing");
        
        try {
          const origin = process.env.SHOPIFY_APP_URL?.startsWith("https://")
            ? process.env.SHOPIFY_APP_URL
            : new URL(request.url).origin;
          
          const returnUrl = `${origin}/app/billing?shop=${session.shop}&plan=${subscription.planTier}`;
          
          // Create a test subscription with the current plan tier
          const testSubscription = await createRecurringCharge(
            session.shop,
            subscription.planTier as PlanTier,
            returnUrl,
            { admin }
          );
          
          // Update subscription with Shopify GIDs
          await updateSubscriptionFromCharge(shop.id, session.shop, subscription.planTier as PlanTier, { admin });
          
          console.log("[Billing] Test subscription created for dev store add-on billing");
        } catch (error) {
          console.error("[Billing] Error creating test subscription for dev store:", error);
          return json({ 
            error: "Failed to set up billing. Please try upgrading your plan first." 
          }, { status: 400 });
        }
      } else {
        // Production store without subscription - error
        return json({ 
          error: "No active subscription found. Please upgrade to a paid plan first." 
        }, { status: 400 });
      }
    }

    // Verify subscription is active in Shopify (case-insensitive status check)
    try {
      const activeCharge = await getActiveCharge(session.shop, { admin });
      if (!activeCharge) {
        // Try to resync subscription status
        try {
          await updateSubscriptionFromCharge(shop.id, session.shop, undefined, { admin });
          // Check again after sync
          const recheckCharge = await getActiveCharge(session.shop, { admin });
          if (!recheckCharge) {
            return json({ 
              error: "Your subscription is not active. Please upgrade to a paid plan first." 
            }, { status: 400 });
          }
          // Case-insensitive status check after recheck
          const recheckStatus = (recheckCharge.status || recheckCharge.normalizedStatus || "").toString().toLowerCase();
          if (recheckStatus !== "active") {
            return json({ 
              error: "Your subscription is not active. Please upgrade to a paid plan or contact support." 
            }, { status: 400 });
          }
        } catch (syncError) {
          console.error("[Billing] Error syncing subscription:", syncError);
          return json({ 
            error: "Your subscription is not active. Please upgrade to a paid plan first." 
          }, { status: 400 });
        }
      } else {
        // Case-insensitive status check
        const status = (activeCharge.status || activeCharge.normalizedStatus || "").toString().toLowerCase();
        if (status !== "active") {
          return json({ 
            error: "Your subscription is not active. Please upgrade to a paid plan or contact support." 
          }, { status: 400 });
        }
      }
    } catch (error) {
      console.error("[Billing] Error checking active subscription:", error);
      return json({ 
        error: "Unable to verify subscription status. Please try again or contact support." 
      }, { status: 400 });
    }

    try {
      let usageRecordId: string;
      
      if (addon.type === "one-time") {
        // ONE-TIME credit top-ups: charge immediately, add to creditsAddonX2 (resets each cycle)
        // Use billing cycle key for one-time add-ons
        const cycleKey = getBillingCycleKey({
          currentPeriodStart: subscription?.currentPeriodStart || null,
          now: new Date(),
        });
        
        const result = await purchaseAddonUsageCharge({
          shopDomain: session.shop,
          addonKey: addon.key,
          priceUsd: addon.price,
          cycleKey,
          opts: { admin },
        });
        usageRecordId = result.usageRecordId;

        // Check if this usage record was just created (new purchase) or is from idempotency (duplicate)
        // Shopify's idempotency returns the same ID if the same add-on was purchased in the same cycle
        // We check the createdAt timestamp - if it's older than 30 seconds, it's likely a duplicate
        // (Both purchases happening within 30 seconds would be very rare, and even if they do, 
        //  the worst case is we skip a duplicate DB update, which is acceptable)
        try {
          const usageRecordQuery = `
            query GetUsageRecord($id: ID!) {
              node(id: $id) {
                ... on AppUsageRecord {
                  id
                  createdAt
                }
              }
            }
          `;
          const usageRecordResponse = await admin.graphql(usageRecordQuery, {
            variables: { id: usageRecordId },
          });
          const usageRecordData = await usageRecordResponse.json();
          const createdAt = usageRecordData.data?.node?.createdAt;
          
          // Check if the usage record was created very recently (within last 30 seconds)
          // If it's older, it's likely from a previous purchase (idempotency return)
          if (createdAt) {
            const recordDate = new Date(createdAt);
            const now = new Date();
            const ageMs = now.getTime() - recordDate.getTime();
            const ageSeconds = ageMs / 1000;
            
            // If the record is older than 30 seconds, it's likely a duplicate (idempotency return)
            // Skip DB update to prevent duplicate credit additions
            if (ageSeconds > 30) {
              console.log(`[Billing] Usage record ${usageRecordId} was created ${ageSeconds.toFixed(1)} seconds ago - likely duplicate (idempotency return), skipping DB update`);
              // Skip DB update for duplicate purchases
            } else {
              // Apply one-time add-on to subscription (updates DB)
              await applyAddonToSubscription({
                shopId: shop.id,
                addonKey: addon.key as "credits_2000" | "credits_5000",
              });
            }
          } else {
            // Fallback: if we can't determine, apply it (safer than missing a purchase)
            await applyAddonToSubscription({
              shopId: shop.id,
              addonKey: addon.key as "credits_2000" | "credits_5000",
            });
          }
        } catch (queryError) {
          console.error("[Billing] Error checking usage record creation time:", queryError);
          // On error, apply it anyway (safer than missing a purchase)
          await applyAddonToSubscription({
            shopId: shop.id,
            addonKey: addon.key as "credits_2000" | "credits_5000",
          });
        }
      } else {
        // RECURRING add-ons: charge immediately when enabled, then monthly from enable date
        // Use current date as cycle key for initial charge (YYYY-MM-DD format)
        const now = new Date();
        const cycleKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        const result = await chargeRecurringAddonForCycle({
          shopDomain: session.shop,
          addonKey: addon.key as "exp_3" | "exp_10",
          priceUsd: addon.price,
          cycleKey,
          opts: { admin },
        });
        usageRecordId = result.usageRecordId;

        // Check if this usage record was just created (new purchase) or is from idempotency (duplicate)
        // Shopify's idempotency returns the same ID if the same add-on was purchased in the same cycle
        // We check the createdAt timestamp - if it's older than 30 seconds, it's likely a duplicate
        try {
          const usageRecordQuery = `
            query GetUsageRecord($id: ID!) {
              node(id: $id) {
                ... on AppUsageRecord {
                  id
                  createdAt
                }
              }
            }
          `;
          const usageRecordResponse = await admin.graphql(usageRecordQuery, {
            variables: { id: usageRecordId },
          });
          const usageRecordData = await usageRecordResponse.json();
          const createdAt = usageRecordData.data?.node?.createdAt;
          
          if (createdAt) {
            const recordDate = new Date(createdAt);
            const now = new Date();
            const ageMs = now.getTime() - recordDate.getTime();
            const ageSeconds = ageMs / 1000;
            
            // If the record is older than 30 seconds, it's likely a duplicate (idempotency return)
            if (ageSeconds > 30) {
              console.log(`[Billing] Usage record ${usageRecordId} was created ${ageSeconds.toFixed(1)} seconds ago - likely duplicate, skipping DB update`);
              // Skip DB update for duplicate purchases
            } else {
              // Set recurring add-on state (persists across cycles)
              if (addon.key === "exp_3") {
                await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_3" });
              } else if (addon.key === "exp_10") {
                await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_10" });
              }
            }
          } else {
            // Fallback: if we can't determine, apply it (safe but might cause duplicates)
            if (addon.key === "exp_3") {
              await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_3" });
            } else if (addon.key === "exp_10") {
              await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_10" });
            }
          }
        } catch (queryError) {
          console.error("[Billing] Error checking usage record creation time:", queryError);
          // On error, apply it anyway (safer than missing a purchase)
          if (addon.key === "exp_3") {
            await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_3" });
          } else if (addon.key === "exp_10") {
            await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_10" });
          }
        }
      }

      return json({ addonPurchased: true, usageRecordId });
    } catch (error) {
      console.error("[Billing] Error purchasing add-on:", error);
      return json({ 
        error: error instanceof Error ? error.message : "Failed to purchase add-on" 
      }, { status: 400 });
    }
  }

  // Legacy buy_addon action (kept for backward compatibility)
  if (actionType === "buy_addon") {
    const addonKey = formData.get("addonKey") as string;
    
    if (!addonKey) {
      return json({ error: "Add-on key required" }, { status: 400 });
    }

    // Get subscription to determine cycle key
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
    });

    // Block add-on purchases if subscription is cancelled
    if (subscription?.status === "cancelled") {
      return json({ 
        error: "Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons." 
      }, { status: 400 });
    }

    // Generate cycle key using billing cycle
    const cycleKey = getBillingCycleKey({
      currentPeriodStart: subscription?.currentPeriodStart || null,
      now: new Date(),
    });

    try {
      // Create usage charge via Shopify
      const result = await purchaseAddonUsageCharge({
        shopDomain: session.shop,
        addonKey,
        priceUsd: addonActions[`buy_addon_${addonKey}`]?.price || 0,
        cycleKey,
        opts: { admin },
      });

      // Apply add-on to subscription
      await applyAddonToSubscription({
        shopId: shop.id,
        addonKey: addonKey as "credits_2000" | "credits_5000" | "exp_3" | "exp_10",
      });

      return json({ addonPurchased: true, usageRecordId: result.usageRecordId });
    } catch (error) {
      console.error("[Billing] Error purchasing add-on:", error);
      return json({ 
        error: error instanceof Error ? error.message : "Failed to purchase add-on" 
      }, { status: 400 });
    }
  }

  // Disable recurring add-ons
  if (actionType === "disable_exp_pack") {
    try {
      await disableRecurringExperiencePack(shop.id);
      return json({ ok: true, disabled: "exp_pack" });
    } catch (error) {
      console.error("[Billing] Error disabling experience pack:", error);
      return json({ 
        error: error instanceof Error ? error.message : "Failed to disable experience pack" 
      });
    }
  }


  // Cancel subscription
  if (actionType === "cancel_subscription") {
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
    });

    if (!subscription) {
      return json({ error: "Subscription not found" });
    }

    // Can't cancel if already TRIAL
    if (subscription.planTier === "TRIAL") {
      return json({ error: "You are already on the free trial plan" });
    }

    try {
      // Cancel Shopify subscription if it exists
      if (subscription.shopifySubscriptionGid) {
        await cancelSubscription(
          session.shop,
          subscription.shopifySubscriptionGid,
          { admin }
        );
      }

      // Mark subscription as cancelled - blocks all access
      await markSubscriptionAsCancelled(shop.id);

      return json({ 
        cancelled: true, 
        message: "Subscription cancelled. You'll need to subscribe again to continue using the service." 
      });
    } catch (error) {
      console.error("[Billing] Error cancelling subscription:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to cancel subscription";
      return json({ error: errorMessage }, { status: 400 });
    }
  }

  return json({ error: "Invalid action" });
};

export default function Billing() {
  const loaderData = useLoaderData<typeof loader>();
  const { currentPlan, inTrial, usage, entitlements, subscription, experienceCount, shopDomain, availablePlans, approved: loaderApproved, errorParam, usageBalanceUsedUsd, usageCapAmountUsd, currentPeriodEnd, allPlans, paymentHistory, usageByExperience, recommendedPlan } = loaderData;
  
  // Type assertion for allPlans to ensure TypeScript knows it's PlanInfo[]
  const typedAllPlans: PlanInfo[] = allPlans as PlanInfo[];
  const actionData = useActionData<typeof action>() as { approved?: boolean; addonPurchased?: boolean; usageRecordId?: string; disabled?: string; error?: string; ok?: boolean; confirmationUrl?: string; cancelled?: boolean; message?: string } | undefined;
  const navigation = useNavigation();
  const app = useAppBridge();
  
  // Derive recurring add-on state
  const expPackActive = subscription?.experiencesAddon === 3 ? "EXP_3" : subscription?.experiencesAddon === 10 ? "EXP_10" : "NONE";
  
  // Confirmation modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { 
    actionType: string; 
    planTier?: string; 
    label: string; 
    priceText: string; 
    note: string 
  }>(null);
  
  // Use navigation state for accurate form submission state
  const isSubmitting = navigation.state === "submitting";

  // Modal helpers
  function openConfirm(p: { actionType: string; planTier?: string; label: string; priceText: string; note: string }) {
    setPendingAction(p);
    setConfirmOpen(true);
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setPendingAction(null);
  }
  
  // Get URL params from loader or action data
  const approved = loaderApproved || actionData?.approved || false;
  const addonPurchased = actionData?.addonPurchased || false;
  const addonDisabled = actionData?.disabled || null;
  const error = errorParam === "sync_failed" ? "Failed to sync subscription. Please contact support." : (actionData?.error || null);
  
  // Refresh page after disable action, add-on purchase, or cancellation
  useEffect(() => {
    if (addonDisabled || addonPurchased || actionData?.cancelled) {
      closeConfirm();
      // Reload to show updated subscription, entitlements, and add-on state
      window.location.reload();
    }
  }, [addonDisabled, addonPurchased, actionData?.cancelled]);

  // Handle confirmationUrl redirect for embedded app using App Bridge
  useEffect(() => {
    const url = (actionData as any)?.confirmationUrl;
    if (!url) return;

    // Primary: App Bridge remote redirect (best for embedded)
    // Use dynamic import since @shopify/app-bridge/actions is client-only
    import("@shopify/app-bridge/actions")
      .then(({ Redirect }) => {
        if (app) {
          // @ts-ignore - App Bridge types may not match exactly
          Redirect.create(app as any).dispatch(Redirect.Action.REMOTE, url);
        }
      })
      .catch(() => {
        // Fallback: top navigation (reliable for embedded apps)
        try {
          if (window.top && window.top !== window) {
            window.top.location.href = url;
          } else {
            window.location.href = url;
          }
        } catch {
          window.location.href = url;
        }
      });
  }, [actionData, app]);

  return (
    <s-page heading="Billing & Plans">
      {approved && (
        <div style={{
          padding: "1rem",
          background: "linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.1))",
          border: "2px solid rgba(16, 185, 129, 0.3)",
          borderRadius: "12px",
          marginBottom: "1rem",
          color: "#059669",
          boxShadow: "0 4px 12px rgba(16, 185, 129, 0.2)"
        }}>
          Subscription approved successfully!
        </div>
      )}
      {actionData?.addonPurchased && actionData?.usageRecordId && (
        <div style={{
          padding: "1rem",
          background: "linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.1))",
          border: "2px solid rgba(16, 185, 129, 0.3)",
          borderRadius: "12px",
          marginBottom: "1rem",
          color: "#059669",
          boxShadow: "0 4px 12px rgba(16, 185, 129, 0.2)"
        }}>
          <s-text>
            Charge created: {actionData.usageRecordId} — will appear on Shopify bill.
          </s-text>
        </div>
      )}
      {addonDisabled && (
        <div style={{
          padding: "1rem",
          background: "linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(251, 191, 36, 0.1))",
          border: "2px solid rgba(245, 158, 11, 0.3)",
          borderRadius: "12px",
          marginBottom: "1rem",
          color: "#D97706",
          boxShadow: "0 4px 12px rgba(245, 158, 11, 0.2)"
        }}>
          <s-text>
            Experience add-on disabled. You won't be charged next month.
          </s-text>
        </div>
      )}
      {actionData?.cancelled && (
        <div style={{
          padding: "1rem",
          background: "linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.1))",
          border: "2px solid rgba(16, 185, 129, 0.3)",
          borderRadius: "12px",
          marginBottom: "1rem",
          color: "#059669",
          boxShadow: "0 4px 12px rgba(16, 185, 129, 0.2)"
        }}>
          <s-text>
            {actionData.message || "Subscription cancelled successfully. You've been reverted to the free plan."}
          </s-text>
        </div>
      )}
      {actionData?.error && (
        <div style={{
          padding: "1rem",
          background: "linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1))",
          border: "2px solid rgba(239, 68, 68, 0.3)",
          borderRadius: "12px",
          marginBottom: "1rem",
          color: "#DC2626",
          boxShadow: "0 4px 12px rgba(239, 68, 68, 0.2)"
        }}>
          {actionData.error}
        </div>
      )}

      <s-section>
        <h2 style={{ marginBottom: "1rem" }}>Current Plan</h2>
        
        {subscription?.status === "cancelled" && (
          <div style={{
            padding: "1.5rem",
            background: "linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1))",
            border: "2px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "12px",
            marginBottom: "2rem",
            color: "#DC2626",
            boxShadow: "0 4px 12px rgba(239, 68, 68, 0.2)"
          }}>
            <s-text>
              <strong>Subscription Cancelled</strong>
            </s-text>
            <div style={{ marginTop: "0.5rem", color: "#991b1b" }}>
              <s-paragraph>
                Your subscription has been cancelled. You no longer have access to EditMuse. Please subscribe to a plan below to continue using the service.
              </s-paragraph>
            </div>
          </div>
        )}
        
        <div style={{
          padding: "1.5rem",
          backgroundColor: "#FFFFFF",
          border: "2px solid rgba(124, 58, 237, 0.2)",
          borderRadius: "12px",
          marginBottom: "2rem",
          boxShadow: "0 4px 12px rgba(124, 58, 237, 0.15)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.5rem" }}>{currentPlan.name}</h3>
              {subscription?.status === "cancelled" && (
                <div style={{ 
                  marginTop: "0.5rem", 
                  color: "#DC2626",
                  fontSize: "0.875rem",
                  fontWeight: "500"
                }}>
                  Cancelled - No Access
                </div>
              )}
              {inTrial && (
                <div style={{ 
                  marginTop: "0.5rem", 
                  color: "#666",
                  fontSize: "0.875rem"
                }}>
                  Trial period active
                </div>
              )}
              <div style={{ marginTop: "0.5rem", color: "#666", fontSize: "0.875rem" }}>
                {currentPlan.includedCredits.toLocaleString()} credits included
              </div>
              <div style={{ marginTop: "0.25rem", color: "#666", fontSize: "0.875rem" }}>
                {entitlements.experiencesLimit === null ? "Unlimited" : `${entitlements.experiencesLimit} experience${entitlements.experiencesLimit === 1 ? "" : "s"}`}
                {subscription && subscription.experiencesAddon > 0 && (
                  <span style={{ marginLeft: "0.5rem", color: "#10B981" }}>
                    (+{subscription.experiencesAddon} from add-ons)
                  </span>
                )}
              </div>
              <div style={{ marginTop: "0.25rem", color: "#666", fontSize: "0.875rem" }}>
                Max products analyzed: {currentPlan.candidateCap}
              </div>
              {currentPlan.price && (
                <div style={{ marginTop: "0.5rem", fontSize: "1.25rem", fontWeight: "bold" }}>
                  ${currentPlan.price.toFixed(2)}/month
                </div>
              )}
            </div>
            {subscription?.status === "active" && !inTrial && (
              <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: "0.875rem", color: "#666" }}>Status</div>
                  <div style={{ 
                    marginTop: "0.25rem",
                    padding: "0.5rem 1rem",
                    background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                    color: "white",
                    borderRadius: "12px",
                    display: "inline-block",
                    fontWeight: "500",
                    boxShadow: "0 2px 8px rgba(124, 58, 237, 0.3)"
                  }}>
                    Active
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openConfirm({
                    actionType: "cancel_subscription",
                    label: "Cancel Subscription",
                    priceText: "Free",
                    note: "Your subscription will be cancelled and you'll lose access to the service. You'll need to subscribe again to continue using EditMuse."
                  })}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#EF4444",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    boxShadow: "0 2px 8px rgba(239, 68, 68, 0.3)",
                    transition: "all 0.2s ease"
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.backgroundColor = "#DC2626";
                    e.currentTarget.style.transform = "translateY(-1px)";
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.backgroundColor = "#EF4444";
                    e.currentTarget.style.transform = "translateY(0)";
                  }}
                >
                  Cancel Subscription
                </button>
              </div>
            )}
          </div>
        </div>

        <h2 style={{ marginBottom: "1rem" }}>Credits & Usage</h2>
        <div style={{
          padding: "1.5rem",
          backgroundColor: "#FFFFFF",
          border: "2px solid rgba(124, 58, 237, 0.2)",
          borderRadius: "12px",
          marginBottom: "2rem",
          boxShadow: "0 4px 12px rgba(124, 58, 237, 0.15)"
        }}>
          {/* Trial Countdown */}
          {inTrial && subscription && (
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFBEB",
              border: "2px solid #FCD34D",
              borderRadius: "12px",
              marginBottom: "1rem",
            }}>
              <div style={{ fontSize: "0.875rem", color: "#92400E", fontWeight: "500", marginBottom: "0.5rem" }}>
                Trial Period
              </div>
              <div style={{ fontSize: "1.25rem", fontWeight: "bold", color: "#92400E" }}>
                Trial active - Upgrade to continue after trial ends
              </div>
            </div>
          )}

          {/* Usage Alerts */}
          {(() => {
            const usagePercent = entitlements.totalCreditsX2 > 0 ? (entitlements.usedCreditsX2 / entitlements.totalCreditsX2) : 0;
            const remainingPercent = 1 - usagePercent;
            const remainingCredits = entitlements.remainingX2 / 2;
            
            if (remainingPercent <= 0.05 && remainingCredits > 0) {
              // Critical: Less than 5% remaining
              return (
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FEF2F2",
                  border: "2px solid #EF4444",
                  borderRadius: "12px",
                  marginBottom: "1rem",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "#DC2626", fontWeight: "600", marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    ⚠️ Critical: Credits Running Low
                  </div>
                  <div style={{ fontSize: "1rem", fontWeight: "500", color: "#991B1B", marginBottom: "0.5rem" }}>
                    Only {remainingCredits.toFixed(0)} credits remaining ({remainingPercent * 100}%)
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#991B1B" }}>
                    Upgrade your plan or purchase additional credits to avoid service interruption.
                  </div>
                </div>
              );
            } else if (remainingPercent <= 0.1 && remainingCredits > 0) {
              // Warning: Less than 10% remaining
              return (
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFBEB",
                  border: "2px solid #F59E0B",
                  borderRadius: "12px",
                  marginBottom: "1rem",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "#D97706", fontWeight: "600", marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    ⚠️ Warning: Low Credits
                  </div>
                  <div style={{ fontSize: "1rem", fontWeight: "500", color: "#92400E" }}>
                    {remainingCredits.toFixed(0)} credits remaining ({remainingPercent * 100}%)
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#92400E", marginTop: "0.25rem" }}>
                    Consider upgrading your plan to avoid running out.
                  </div>
                </div>
              );
            } else if (remainingPercent <= 0.2 && remainingCredits > 0) {
              // Info: Less than 20% remaining
              return (
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#EFF6FF",
                  border: "2px solid #3B82F6",
                  borderRadius: "12px",
                  marginBottom: "1rem",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "#1E40AF", fontWeight: "600", marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    ℹ️ Credits Notice
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#1E40AF" }}>
                    {remainingCredits.toFixed(0)} credits remaining ({remainingPercent * 100}%). Monitor your usage to avoid running out.
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Credits Progress Bar */}
          <div style={{ marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.875rem", color: "#666", fontWeight: "500" }}>Credits Usage</div>
              <div style={{ fontSize: "0.875rem", color: "#666" }}>
                {((entitlements.usedCreditsX2 / entitlements.totalCreditsX2) * 100).toFixed(1)}%
              </div>
            </div>
            <div style={{
              width: "100%",
              height: "24px",
              backgroundColor: "#F3F4F6",
              borderRadius: "12px",
              overflow: "hidden",
              position: "relative",
            }}>
              <div style={{
                width: `${Math.min((entitlements.usedCreditsX2 / entitlements.totalCreditsX2) * 100, 100)}%`,
                height: "100%",
                backgroundColor: (entitlements.usedCreditsX2 / entitlements.totalCreditsX2) > 0.8 ? "#EF4444" :
                                 (entitlements.usedCreditsX2 / entitlements.totalCreditsX2) > 0.6 ? "#F59E0B" : "#10B981",
                borderRadius: "12px",
                transition: "all 0.3s ease",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.5rem", fontSize: "0.75rem", color: "#999" }}>
              <span>0</span>
              <span>{(entitlements.totalCreditsX2 / 2).toFixed(0)} credits</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "1rem", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.875rem", color: "#666" }}>Credits Used</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", marginTop: "0.25rem" }}>
                {(entitlements.usedCreditsX2 / 2).toFixed(1)}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "0.25rem" }}>
                of {(entitlements.totalCreditsX2 / 2).toFixed(0)} total
                {entitlements.addonCreditsX2 > 0 && (
                  <span style={{ marginLeft: "0.5rem", color: "#10B981" }}>
                    (+{(entitlements.addonCreditsX2 / 2).toFixed(0)} from add-ons)
                  </span>
                )}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.875rem", color: "#666" }}>Credits Remaining</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", marginTop: "0.25rem", color: entitlements.remainingX2 > 0 ? "#10B981" : "#EF4444" }}>
                {(entitlements.remainingX2 / 2).toFixed(1)}
              </div>
              {/* Usage Projection */}
              {usage.aiRankingsExecuted > 0 && (
                <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "0.25rem" }}>
                  {(() => {
                    const dailyBurn = usage.aiRankingsExecuted / 30; // Approximate daily burn
                    const daysRemaining = dailyBurn > 0 ? Math.floor((entitlements.remainingX2 / 2) / dailyBurn) : null;
                    return daysRemaining !== null && daysRemaining < 60 ? (
                      <span style={{ color: daysRemaining < 30 ? "#EF4444" : "#F59E0B" }}>
                        ~{daysRemaining} days at current rate
                      </span>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
          </div>
          {entitlements.experiencesLimit !== null && (
            <div style={{ marginBottom: "1rem", padding: "1rem", background: "linear-gradient(135deg, rgba(124, 58, 237, 0.05), rgba(6, 182, 212, 0.05))", border: "1px solid rgba(124, 58, 237, 0.2)", borderRadius: "12px" }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>Experiences</div>
              <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginTop: "0.25rem", color: "#7C3AED" }}>
                {experienceCount} of {entitlements.experiencesLimit} used
              </div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.875rem", color: "#666" }}>Sessions Started</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", marginTop: "0.25rem" }}>
                {usage.sessionsStarted}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.875rem", color: "#666" }}>AI Rankings Executed</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", marginTop: "0.25rem" }}>
                {usage.aiRankingsExecuted}
              </div>
            </div>
          </div>
        </div>

        {/* Plan Comparison Table */}
        <h2 style={{ marginBottom: "1rem" }}>Plan Comparison</h2>
        <div style={{
          backgroundColor: "#FFFFFF",
          border: "1px solid rgba(11,11,15,0.12)",
          borderRadius: "12px",
          overflow: "hidden",
          marginBottom: "2rem",
          boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
        }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: "#F9FAFB" }}>
                <th style={{ padding: "0.75rem 1rem", textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>Feature</th>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <th
                    key={plan.tier}
                    style={{
                      padding: "0.75rem 1rem",
                      textAlign: "center",
                      borderBottom: "1px solid rgba(11,11,15,0.12)",
                      fontWeight: "500",
                      color: currentPlan.tier === plan.tier ? "#7C3AED" : "#0B0B0F",
                      backgroundColor: currentPlan.tier === plan.tier ? "rgba(124, 58, 237, 0.05)" : "transparent",
                    }}
                  >
                    {plan.name}
                    {currentPlan.tier === plan.tier && <div style={{ fontSize: "0.75rem", color: "#7C3AED", marginTop: "0.25rem" }}>(Current)</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ backgroundColor: "#FFFFFF" }}>
                <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>Monthly Price</td>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <td key={plan.tier} style={{ padding: "0.75rem 1rem", textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                    {plan.price ? `$${plan.price.toFixed(2)}` : "—"}
                  </td>
                ))}
              </tr>
              <tr style={{ backgroundColor: "#F9FAFB" }}>
                <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                  <div>Credits Included</div>
                  <div style={{ fontSize: "0.75rem", color: "#666", fontWeight: "normal", marginTop: "0.25rem" }}>
                    Monthly credits for AI-powered product recommendations
                  </div>
                </td>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <td key={plan.tier} style={{ padding: "0.75rem 1rem", textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                    {plan.includedCredits.toLocaleString()}
                  </td>
                ))}
              </tr>
              <tr style={{ backgroundColor: "#FFFFFF" }}>
                <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                  <div>Experiences</div>
                  <div style={{ fontSize: "0.75rem", color: "#666", fontWeight: "normal", marginTop: "0.25rem" }}>
                    Number of concierge experiences you can create
                  </div>
                </td>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <td key={plan.tier} style={{ padding: "0.75rem 1rem", textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                    {plan.experiences === null ? "Unlimited" : plan.experiences}
                  </td>
                ))}
              </tr>
              <tr style={{ backgroundColor: "#F9FAFB" }}>
                <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                  <div>Max Products Analyzed</div>
                  <div style={{ fontSize: "0.75rem", color: "#666", fontWeight: "normal", marginTop: "0.25rem" }}>
                    Maximum products analyzed per search
                  </div>
                </td>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <td key={plan.tier} style={{ padding: "0.75rem 1rem", textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                    {plan.candidateCap}
                  </td>
                ))}
              </tr>
              <tr style={{ backgroundColor: "#FFFFFF" }}>
                <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                  <div>Overage Rate</div>
                  <div style={{ fontSize: "0.75rem", color: "#666", fontWeight: "normal", marginTop: "0.25rem" }}>
                    Cost per credit when you exceed your monthly limit
                  </div>
                </td>
                {typedAllPlans.filter((p: PlanInfo) => p.tier !== "TRIAL").map((plan: PlanInfo) => (
                  <td key={plan.tier} style={{ padding: "0.75rem 1rem", textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                    ${plan.overageRate.toFixed(2)}/credit
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {availablePlans.length > 0 && (
          <>
            <h2 style={{ marginBottom: "1rem" }}>Upgrade Plan</h2>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: "1rem",
              marginBottom: "2rem"
            }}>
              {availablePlans.map((plan) => (
                <div
                  key={plan.tier}
                  style={{
                    padding: "1.5rem",
                    border: "2px solid rgba(124, 58, 237, 0.2)",
                    borderRadius: "12px",
                    backgroundColor: "#FFFFFF",
                    boxShadow: "0 4px 12px rgba(124, 58, 237, 0.1)",
                    transition: "all 0.2s ease"
                  }}
                >
                  <h3 style={{ margin: 0, marginBottom: "0.5rem" }}>{plan.name}</h3>
                  <div style={{ marginBottom: "0.5rem", color: "#666", fontSize: "0.875rem" }}>
                    {plan.includedCredits.toLocaleString()} credits included
                  </div>
                  <div style={{ marginBottom: "0.5rem", color: "#666", fontSize: "0.875rem" }}>
                    {plan.experiences === null ? "Unlimited" : plan.experiences} experience{plan.experiences === 1 ? "" : "s"}
                  </div>
                  <div style={{ marginBottom: "0.5rem", color: "#666", fontSize: "0.875rem" }}>
                    Max products analyzed: {plan.candidateCap}
                  </div>
                  <div style={{ marginBottom: "0.5rem", color: "#666", fontSize: "0.875rem" }}>
                    Overage: ${plan.overageRate.toFixed(2)}/credit
                  </div>
                  {plan.price && (
                    <div style={{ 
                      fontSize: "1.5rem", 
                      fontWeight: "bold",
                      marginBottom: "1rem"
                    }}>
                      ${plan.price.toFixed(2)}/month
                    </div>
                  )}
                  <Form method="post">
                    <input type="hidden" name="actionType" value="upgrade" />
                    <input type="hidden" name="planTier" value={plan.tier} />
                    <button
                      type="submit"
                      style={{
                        width: "100%",
                        padding: "0.75rem 1.5rem",
                        background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                        color: "white",
                        border: "none",
                        borderRadius: "12px",
                        cursor: "pointer",
                        fontSize: "1rem",
                        fontWeight: "500",
                        boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                        transition: "all 0.2s ease"
                      }}
                    >
                      Upgrade to {plan.name}
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          </>
        )}

        {availablePlans.length === 0 && (
          <div style={{
            padding: "1.5rem",
            background: "linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(6, 182, 212, 0.1))",
            border: "2px solid rgba(124, 58, 237, 0.3)",
            borderRadius: "12px",
            color: "#7C3AED",
            boxShadow: "0 4px 12px rgba(124, 58, 237, 0.2)"
          }}>
            You're already on the highest plan available.
          </div>
        )}

        <h2 style={{ marginBottom: "1rem", marginTop: "2rem" }}>Add-ons</h2>
        {(usageBalanceUsedUsd !== null || usageCapAmountUsd !== null) && (
          <div style={{
            padding: "1rem",
            backgroundColor: "#FFFFFF",
            border: "2px solid rgba(124, 58, 237, 0.2)",
            borderRadius: "12px",
            marginBottom: "1.5rem",
            boxShadow: "0 4px 12px rgba(124, 58, 237, 0.15)"
          }}>
            <s-paragraph>
              Shopify usage billing: ${usageBalanceUsedUsd?.toFixed(2) ?? "0.00"} of ${usageCapAmountUsd?.toFixed(2) ?? "N/A"}
              {currentPeriodEnd && (
                <span style={{ color: "#666", fontSize: "0.875rem", marginLeft: "0.5rem" }}>
                  (resets {new Date(currentPeriodEnd).toLocaleDateString()})
                </span>
              )}
              <span style={{ color: "#666", fontSize: "0.75rem", display: "block", marginTop: "0.25rem" }}>
                Note: Balance may take a few moments to update after purchases
              </span>
            </s-paragraph>
          </div>
        )}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem"
        }}>
          {/* ONE-TIME: Credits Packs */}
          <div style={{
            padding: "1.5rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            backgroundColor: "#fff"
          }}>
            <h4 style={{ margin: 0, marginBottom: "0.5rem" }}>2,000 Credits</h4>
            <div style={{ fontSize: "0.75rem", color: "#666", marginBottom: "0.25rem" }}>
              One-time top-up
            </div>
            <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "1rem" }}>
              $49
            </div>
            <button
              type="button"
              onClick={() => {
                if (subscription?.status === "cancelled") {
                  alert("Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons.");
                  return;
                }
                openConfirm({
                  actionType: "buy_addon_credits_2000",
                  label: "2,000 Credits top-up",
                  priceText: "$49 (one-time)",
                  note: "This is charged as a usage charge and will appear on your Shopify bill."
                });
              }}
              disabled={subscription?.status === "cancelled"}
              style={{
                width: "100%",
                padding: "0.75rem",
                background: subscription?.status === "cancelled"
                  ? "rgba(11,11,15,0.2)"
                  : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "white",
                border: "none",
                borderRadius: "12px",
                cursor: subscription?.status === "cancelled" ? "not-allowed" : "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
                boxShadow: subscription?.status === "cancelled" ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                transition: "all 0.2s ease",
                opacity: subscription?.status === "cancelled" ? 0.6 : 1
              }}
            >
              {subscription?.status === "cancelled" ? "Subscribe to Purchase" : "Purchase"}
            </button>
          </div>

          <div style={{
            padding: "1.5rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            backgroundColor: "#fff"
          }}>
            <h4 style={{ margin: 0, marginBottom: "0.5rem" }}>5,000 Credits</h4>
            <div style={{ fontSize: "0.75rem", color: "#666", marginBottom: "0.25rem" }}>
              One-time top-up
            </div>
            <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "1rem" }}>
              $99
            </div>
            <button
              type="button"
              onClick={() => {
                if (subscription?.status === "cancelled") {
                  alert("Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons.");
                  return;
                }
                openConfirm({
                  actionType: "buy_addon_credits_5000",
                  label: "5,000 Credits top-up",
                  priceText: "$99 (one-time)",
                  note: "This is charged as a usage charge and will appear on your Shopify bill."
                });
              }}
              disabled={subscription?.status === "cancelled"}
              style={{
                width: "100%",
                padding: "0.75rem",
                background: subscription?.status === "cancelled"
                  ? "rgba(11,11,15,0.2)"
                  : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "white",
                border: "none",
                borderRadius: "12px",
                cursor: subscription?.status === "cancelled" ? "not-allowed" : "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
                boxShadow: subscription?.status === "cancelled" ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                transition: "all 0.2s ease",
                opacity: subscription?.status === "cancelled" ? 0.6 : 1
              }}
            >
              {subscription?.status === "cancelled" ? "Subscribe to Purchase" : "Purchase"}
            </button>
          </div>

          {/* RECURRING: Experience Packs - Hidden for PRO plan (unlimited experiences) */}
          {(currentPlan.tier as string) !== "PRO" && (
          <div style={{
            padding: "1.5rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            backgroundColor: "#fff"
          }}>
            <h4 style={{ margin: 0, marginBottom: "0.5rem" }}>+3 Experiences</h4>
            <div style={{ fontSize: "0.75rem", color: "#666", marginBottom: "0.25rem" }}>
              Recurring monthly
            </div>
            <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "1rem" }}>
              $15<span style={{ fontSize: "0.875rem", fontWeight: "normal" }}>/mo</span>
            </div>
            {expPackActive === "EXP_3" ? (
              <Form method="post">
                <input type="hidden" name="actionType" value="disable_exp_pack" />
                <button
                  type="submit"
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    backgroundColor: "#EF4444",
                    color: "white",
                    border: "none",
                    borderRadius: "12px",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    boxShadow: "0 4px 12px rgba(239, 68, 68, 0.3)",
                    transition: "all 0.2s ease"
                  }}
                >
                  Disable
                </button>
              </Form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (subscription?.status === "cancelled") {
                    alert("Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons.");
                    return;
                  }
                  openConfirm({
                    actionType: "buy_addon_exp_3",
                    label: "+3 Experiences",
                    priceText: "$15/month",
                    note: "Renews monthly until disabled. Charged as usage billing."
                  });
                }}
                disabled={subscription?.status === "cancelled"}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  background: subscription?.status === "cancelled"
                    ? "rgba(11,11,15,0.2)"
                    : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: subscription?.status === "cancelled" ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: subscription?.status === "cancelled" ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease",
                  opacity: subscription?.status === "cancelled" ? 0.6 : 1
                }}
              >
                {subscription?.status === "cancelled" ? "Subscribe to Enable" : "Enable"}
              </button>
            )}
          </div>
          )}

          {(currentPlan.tier as string) !== "PRO" && (
          <div style={{
            padding: "1.5rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            backgroundColor: "#fff"
          }}>
            <h4 style={{ margin: 0, marginBottom: "0.5rem" }}>+10 Experiences</h4>
            <div style={{ fontSize: "0.75rem", color: "#666", marginBottom: "0.25rem" }}>
              Recurring monthly
            </div>
            <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "1rem" }}>
              $39<span style={{ fontSize: "0.875rem", fontWeight: "normal" }}>/mo</span>
            </div>
            {expPackActive === "EXP_10" ? (
              <Form method="post">
                <input type="hidden" name="actionType" value="disable_exp_pack" />
                <button
                  type="submit"
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    backgroundColor: "#EF4444",
                    color: "white",
                    border: "none",
                    borderRadius: "12px",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    boxShadow: "0 4px 12px rgba(239, 68, 68, 0.3)",
                    transition: "all 0.2s ease"
                  }}
                >
                  Disable
                </button>
              </Form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (subscription?.status === "cancelled") {
                    alert("Your subscription has been cancelled. Please subscribe to a paid plan first to purchase add-ons.");
                    return;
                  }
                  openConfirm({
                    actionType: "buy_addon_exp_10",
                    label: "+10 Experiences",
                    priceText: "$39/month",
                    note: "Renews monthly until disabled. Charged as usage billing."
                  });
                }}
                disabled={subscription?.status === "cancelled"}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  background: subscription?.status === "cancelled"
                    ? "rgba(11,11,15,0.2)"
                    : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: subscription?.status === "cancelled" ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: subscription?.status === "cancelled" ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease",
                  opacity: subscription?.status === "cancelled" ? 0.6 : 1
                }}
              >
                {subscription?.status === "cancelled" ? "Subscribe to Enable" : "Enable"}
              </button>
            )}
          </div>
          )}
        </div>
      </s-section>

      {/* Confirmation Modal */}
      {confirmOpen && pendingAction && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000
        }} onClick={closeConfirm}>
          <div style={{
            backgroundColor: "white",
            borderRadius: "12px",
            padding: "2rem",
            maxWidth: "500px",
            width: "90%",
            border: "2px solid rgba(124, 58, 237, 0.2)",
            boxShadow: "0 10px 40px rgba(124, 58, 237, 0.3)"
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0, marginBottom: "1rem" }}>
              {pendingAction.actionType === "cancel_subscription" ? "Cancel Subscription" : "Confirm Purchase"}
            </h3>
            <s-paragraph>
              <s-text>
                <strong>{pendingAction.label}</strong>
              </s-text>
            </s-paragraph>
            {pendingAction.actionType !== "cancel_subscription" && (
              <s-paragraph>
                <s-text>
                  Price: {pendingAction.priceText}
                </s-text>
              </s-paragraph>
            )}
            <div style={{ color: "#666", fontSize: "0.875rem", marginTop: "0.5rem" }}>
              {pendingAction.note}
            </div>
            {actionData?.error && (
              <div style={{
                padding: "0.75rem",
                backgroundColor: "#fee2e2",
                border: "1px solid #fecaca",
                borderRadius: "4px",
                marginTop: "1rem",
                color: "#991b1b",
                fontSize: "0.875rem"
              }}>
                {actionData.error}
              </div>
            )}
            <div style={{
              display: "flex",
              gap: "1rem",
              marginTop: "1.5rem",
              justifyContent: "flex-end"
            }}>
              <button
                type="button"
                onClick={closeConfirm}
                style={{
                  padding: "0.75rem 1.5rem",
                  backgroundColor: "#F9FAFB",
                  color: "#0B0B0F",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  transition: "all 0.2s ease"
                }}
              >
                {pendingAction.actionType === "cancel_subscription" ? "Keep Subscription" : "Cancel"}
              </button>
              <Form method="post">
                <input type="hidden" name="actionType" value={pendingAction.actionType} />
                {pendingAction.planTier && (
                  <input type="hidden" name="planTier" value={pendingAction.planTier} />
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: "0.75rem 1.5rem",
                    background: isSubmitting 
                      ? "rgba(11,11,15,0.2)" 
                      : (pendingAction.actionType === "cancel_subscription"
                          ? "linear-gradient(135deg, #EF4444, #DC2626)"
                          : "linear-gradient(135deg, #7C3AED, #06B6D4)"),
                    color: "white",
                    border: "none",
                    borderRadius: "12px",
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    boxShadow: isSubmitting ? "none" : (pendingAction.actionType === "cancel_subscription"
                        ? "0 4px 12px rgba(239, 68, 68, 0.3)"
                        : "0 4px 12px rgba(124, 58, 237, 0.3)"),
                    transition: "all 0.2s ease",
                    opacity: isSubmitting ? 0.7 : 1
                  }}
                >
                  {isSubmitting 
                    ? "Processing..." 
                    : (pendingAction.actionType === "cancel_subscription" 
                        ? "Yes, Cancel Subscription" 
                        : "Confirm Purchase")}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}

      {/* Plan Recommendation */}
      {recommendedPlan && (
        <div style={{
          padding: "1.5rem",
          backgroundColor: "#FFFBEB",
          border: "2px solid #F59E0B",
          borderRadius: "12px",
          marginBottom: "2rem",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "1.5rem" }}>💡</span>
            <h3 style={{ margin: 0, color: "#D97706" }}>Plan Recommendation</h3>
          </div>
          <p style={{ margin: 0, color: "#92400E", fontSize: "0.875rem", lineHeight: "1.5" }}>
            You're using {((usage.totalCreditsBurned || 0) / currentPlan.includedCredits * 100).toFixed(0)}% of your monthly credits. 
            Consider upgrading to <strong>{recommendedPlan.name}</strong> for {recommendedPlan.includedCredits.toLocaleString()} credits/month.
          </p>
        </div>
      )}

      {/* Usage Breakdown by Experience */}
      {usageByExperience.length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={{ marginBottom: "1rem" }}>Usage Breakdown (Last 30 Days)</h2>
          <div style={{
            backgroundColor: "#FFFFFF",
            border: "1px solid rgba(11,11,15,0.12)",
            borderRadius: "12px",
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ backgroundColor: "#F9FAFB" }}>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Experience
                  </th>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Sessions
                  </th>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Credits Used
                  </th>
                </tr>
              </thead>
              <tbody>
                {usageByExperience.map((item: { name: string; sessions: number; credits: number }, idx: number) => (
                  <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB" }}>
                    <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                      {item.name}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                      {item.sessions.toLocaleString()}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F" }}>
                      {item.credits.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payment History */}
      {paymentHistory.length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={{ marginBottom: "1rem" }}>Payment History</h2>
          <div style={{
            backgroundColor: "#FFFFFF",
            border: "1px solid rgba(11,11,15,0.12)",
            borderRadius: "12px",
            overflow: "hidden",
            boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ backgroundColor: "#F9FAFB" }}>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Date
                  </th>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Description
                  </th>
                  <th style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.12)", fontWeight: "500", color: "#0B0B0F" }}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {paymentHistory.map((payment: { id: string; createdAt: string; description: string; amount: number; currencyCode: string }, idx: number) => (
                  <tr key={payment.id} style={{ backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB" }}>
                    <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F", fontSize: "0.875rem" }}>
                      {new Date(payment.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F", fontSize: "0.875rem" }}>
                      {payment.description}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.08)", color: "#0B0B0F", fontSize: "0.875rem", fontWeight: "500" }}>
                      {payment.currencyCode} ${payment.amount.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

