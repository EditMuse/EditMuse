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
  setRecurringAdvancedReporting,
  disableRecurringExperiencePack,
  disableRecurringAdvancedReporting,
  getOrCreateSubscription,
  chargeRecurringAddonsOnRollover,
  PLANS
} from "~/models/billing.server";
import { createRecurringCharge, purchaseAddon, updateSubscriptionFromCharge, purchaseAddonUsageCharge, chargeRecurringAddonForCycle, getActiveCharge } from "~/models/shopify-billing.server";

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
  
  // Charge recurring add-ons if rollover just occurred
  await chargeRecurringAddonsOnRollover(shop.id);

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
  const availablePlans = Object.values(PLANS).filter(
    (plan) => plan.tier !== "TRIAL" && plan.tier !== currentPlan.tier
  );

  // Check for success/error params from redirect
  const approved = url.searchParams.get("approved") === "true";
  const errorParam = url.searchParams.get("error");

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
  // RECURRING: exp_3, exp_10, advanced_reporting (persist across cycles, charge monthly)
  const addonActions: Record<string, { price: number; key: string; type: "one-time" | "recurring" }> = {
    buy_addon_credits_2000: { price: 49, key: "credits_2000", type: "one-time" },
    buy_addon_credits_5000: { price: 99, key: "credits_5000", type: "one-time" },
    buy_addon_exp_3: { price: 15, key: "exp_3", type: "recurring" },
    buy_addon_exp_10: { price: 39, key: "exp_10", type: "recurring" },
    buy_addon_advanced_reporting: { price: 29, key: "advanced_reporting", type: "recurring" },
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

    // Check if shop has an active Shopify subscription (not TRIAL)
    if (subscription.planTier === "TRIAL") {
      return json({ 
        error: "Add-ons are only available for paid plans. Please upgrade to a paid plan first." 
      }, { status: 400 });
    }

    // Check if subscription has an active Shopify subscription GID
    if (!subscription.shopifySubscriptionGid) {
      return json({ 
        error: "No active subscription found. Please upgrade to a paid plan first." 
      }, { status: 400 });
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

    // Generate cycle key using billing cycle
    const cycleKey = getBillingCycleKey({
      currentPeriodStart: subscription?.currentPeriodStart || null,
      now: new Date(),
    });

    try {
      let usageRecordId: string;
      
      if (addon.type === "one-time") {
        // ONE-TIME credit top-ups: charge immediately, add to creditsAddonX2 (resets each cycle)
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
        // RECURRING add-ons: charge for current cycle, persist state for future cycles
        const result = await chargeRecurringAddonForCycle({
          shopDomain: session.shop,
          addonKey: addon.key as "exp_3" | "exp_10" | "advanced_reporting",
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
              } else if (addon.key === "advanced_reporting") {
                await setRecurringAdvancedReporting({ shopId: shop.id, enabled: true });
              }
            }
          } else {
            // Fallback: if we can't determine, apply it (safe but might cause duplicates)
            if (addon.key === "exp_3") {
              await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_3" });
            } else if (addon.key === "exp_10") {
              await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_10" });
            } else if (addon.key === "advanced_reporting") {
              await setRecurringAdvancedReporting({ shopId: shop.id, enabled: true });
            }
          }
        } catch (queryError) {
          console.error("[Billing] Error checking usage record creation time:", queryError);
          // On error, apply it anyway (safer than missing a purchase)
          if (addon.key === "exp_3") {
            await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_3" });
          } else if (addon.key === "exp_10") {
            await setRecurringExperiencePack({ shopId: shop.id, pack: "EXP_10" });
          } else if (addon.key === "advanced_reporting") {
            await setRecurringAdvancedReporting({ shopId: shop.id, enabled: true });
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
        addonKey: addonKey as "credits_2000" | "credits_5000" | "exp_3" | "exp_10" | "advanced_reporting",
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

  if (actionType === "disable_advanced_reporting") {
    try {
      await disableRecurringAdvancedReporting(shop.id);
      return json({ ok: true, disabled: "advanced_reporting" });
    } catch (error) {
      console.error("[Billing] Error disabling advanced reporting:", error);
      return json({ 
        error: error instanceof Error ? error.message : "Failed to disable advanced reporting" 
      });
    }
  }

  return json({ error: "Invalid action" });
};

export default function Billing() {
  const { currentPlan, inTrial, usage, entitlements, subscription, experienceCount, shopDomain, availablePlans, approved: loaderApproved, errorParam, usageBalanceUsedUsd, usageCapAmountUsd, currentPeriodEnd } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { approved?: boolean; addonPurchased?: boolean; usageRecordId?: string; disabled?: string; error?: string; ok?: boolean; confirmationUrl?: string } | undefined;
  const navigation = useNavigation();
  const app = useAppBridge();
  
  // Derive recurring add-on state
  const expPackActive = subscription?.experiencesAddon === 3 ? "EXP_3" : subscription?.experiencesAddon === 10 ? "EXP_10" : "NONE";
  const advancedReportingActive = subscription?.advancedReportingAddon === true;
  
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
  
  // Refresh page after disable action
  useEffect(() => {
    if (addonDisabled) {
      // Reload to show updated state
      window.location.reload();
    }
  }, [addonDisabled]);

  // Close modal and reload page after successful add-on purchase to show updated data
  useEffect(() => {
    if (addonPurchased) {
      closeConfirm();
      // Reload to show updated subscription, entitlements, and add-on state
      window.location.reload();
    }
  }, [addonPurchased]);

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
            {addonDisabled === "exp_pack" 
              ? "Experience add-on disabled. You won't be charged next month." 
              : "Advanced Reporting disabled. You won't be charged next month."}
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
                Candidate cap: {currentPlan.candidateCap}
              </div>
              {currentPlan.price && (
                <div style={{ marginTop: "0.5rem", fontSize: "1.25rem", fontWeight: "bold" }}>
                  ${currentPlan.price.toFixed(2)}/month
                </div>
              )}
            </div>
            {subscription?.status === "active" && !inTrial && (
              <div style={{ textAlign: "right" }}>
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
                    Candidate cap: {plan.candidateCap}
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
              onClick={() => openConfirm({
                actionType: "buy_addon_credits_2000",
                label: "2,000 Credits top-up",
                priceText: "$49 (one-time)",
                note: "This is charged as a usage charge and will appear on your Shopify bill."
              })}
              style={{
                width: "100%",
                padding: "0.75rem",
                background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "white",
                border: "none",
                borderRadius: "12px",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
                boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                transition: "all 0.2s ease"
              }}
            >
              Purchase
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
              onClick={() => openConfirm({
                actionType: "buy_addon_credits_5000",
                label: "5,000 Credits top-up",
                priceText: "$99 (one-time)",
                note: "This is charged as a usage charge and will appear on your Shopify bill."
              })}
              style={{
                width: "100%",
                padding: "0.75rem",
                background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "white",
                border: "none",
                borderRadius: "12px",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
                boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                transition: "all 0.2s ease"
              }}
            >
              Purchase
            </button>
          </div>

          {/* RECURRING: Experience Packs */}
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
                onClick={() => openConfirm({
                  actionType: "buy_addon_exp_3",
                  label: "+3 Experiences",
                  priceText: "$15/month",
                  note: "Renews monthly until disabled. Charged as usage billing."
                })}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease"
                }}
              >
                Enable
              </button>
            )}
          </div>

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
                onClick={() => openConfirm({
                  actionType: "buy_addon_exp_10",
                  label: "+10 Experiences",
                  priceText: "$39/month",
                  note: "Renews monthly until disabled. Charged as usage billing."
                })}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease"
                }}
              >
                Enable
              </button>
            )}
          </div>

          {/* RECURRING: Advanced Reporting */}
          <div style={{
            padding: "1.5rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            backgroundColor: "#fff"
          }}>
            <h4 style={{ margin: 0, marginBottom: "0.5rem" }}>Advanced Reporting</h4>
            <div style={{ fontSize: "0.75rem", color: "#666", marginBottom: "0.25rem" }}>
              Recurring monthly
            </div>
            <div style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "1rem" }}>
              $29<span style={{ fontSize: "0.875rem", fontWeight: "normal" }}>/mo</span>
            </div>
            {currentPlan.tier === "PRO" ? (
              // PRO plan: Advanced Reporting is included, show "Included" (not Disable)
              <button
                type="button"
                disabled
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    backgroundColor: "#F3F4F6",
                    color: "rgba(11,11,15,0.62)",
                    border: "2px solid rgba(11,11,15,0.12)",
                    borderRadius: "12px",
                    cursor: "not-allowed",
                    fontSize: "0.875rem",
                    fontWeight: "500"
                  }}
                >
                  Included
                </button>
            ) : advancedReportingActive ? (
              // Not PRO, but add-on is active: allow Disable (only for Lite/Growth/Scale with add-on)
              <Form method="post">
                <input type="hidden" name="actionType" value="disable_advanced_reporting" />
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
              // Not PRO, add-on not active: show Enable
              <button
                type="button"
                onClick={() => openConfirm({
                  actionType: "buy_addon_advanced_reporting",
                  label: "Advanced Reporting",
                  priceText: "$29/month",
                  note: "Renews monthly until disabled. Charged as usage billing."
                })}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease"
                }}
              >
                Enable
              </button>
            )}
          </div>
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
            <h3 style={{ margin: 0, marginBottom: "1rem" }}>Confirm Purchase</h3>
            <s-paragraph>
              <s-text>
                <strong>{pendingAction.label}</strong>
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                Price: {pendingAction.priceText}
              </s-text>
            </s-paragraph>
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
                Cancel
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
                      : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                    color: "white",
                    border: "none",
                    borderRadius: "12px",
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    boxShadow: isSubmitting ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                    transition: "all 0.2s ease",
                    opacity: isSubmitting ? 0.7 : 1
                  }}
                >
                  {isSubmitting ? "Processing..." : "Confirm Purchase"}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

