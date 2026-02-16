/**
 * Billing and subscription management
 */

import prisma from "~/db.server";
import { UsageEventType, PlanTier } from "@prisma/client";

export const PLAN_TIER = {
  TRIAL: "TRIAL",
  LITE: "LITE",
  GROWTH: "GROWTH",
  SCALE: "SCALE",
  PRO: "PRO",
} as const;

export type PlanTierType = typeof PLAN_TIER[keyof typeof PLAN_TIER];

export const TRIAL_DAYS = 7;

export interface PlanInfo {
  tier: PlanTierType;
  name: string;
  price: number;
  trialDays?: number;
  includedCredits: number;
  experiences: number | null; // null = unlimited (Infinity)
  candidateCap: number;
  badge?: boolean; // Show trial badge
  overageRate: number; // per credit
}

export const PLANS: Record<PlanTierType, PlanInfo> = {
  [PLAN_TIER.TRIAL]: {
    tier: PLAN_TIER.TRIAL,
    name: "Trial",
    price: 0,
    trialDays: 7,
    includedCredits: 50,
    experiences: 1,
    candidateCap: 100,
    badge: true,
    overageRate: 0.12,
  },
  [PLAN_TIER.LITE]: {
    tier: PLAN_TIER.LITE,
    name: "Lite",
    price: 19,
    includedCredits: 300,
    experiences: 1,
    candidateCap: 120,
    overageRate: 0.12,
  },
  [PLAN_TIER.GROWTH]: {
    tier: PLAN_TIER.GROWTH,
    name: "Growth",
    price: 39,
    includedCredits: 1000,
    experiences: 3,
    candidateCap: 200,
    overageRate: 0.08,
  },
  [PLAN_TIER.SCALE]: {
    tier: PLAN_TIER.SCALE,
    name: "Scale",
    price: 79,
    includedCredits: 2500,
    experiences: 8,
    candidateCap: 300,
    overageRate: 0.06,
  },
  [PLAN_TIER.PRO]: {
    tier: PLAN_TIER.PRO,
    name: "Pro",
    price: 129,
    includedCredits: 5000,
    experiences: null, // unlimited
    candidateCap: 400,
    overageRate: 0.05,
  },
};

function isPlanTier(value: unknown): value is PlanTierType {
  return typeof value === "string" && value in PLANS;
}

/**
 * Convert credits to x2 units (0.5 credit = 1 unit)
 */
export function creditsToX2(credits: number): number {
  return Math.round(credits * 2);
}

/**
 * Convert x2 units back to credits
 */
export function x2ToCredits(x2: number): number {
  return x2 / 2;
}

/**
 * Get billing cycle key for idempotency
 * Returns stable string per cycle: "YYYY-MM"
 */
export function getBillingCycleKey(input: {
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  now?: Date;
}): string {
  const now = input.now || new Date();
  
  // If currentPeriodStart exists, use its month
  if (input.currentPeriodStart) {
    const start = input.currentPeriodStart;
    const year = start.getUTCFullYear();
    const month = String(start.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }
  
  // Otherwise use current month (UTC)
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Burn x2 units based on result count
 * 8 => 2 (1.0 credit)
 * 12 => 3 (1.5 credits)
 * 16 => 4 (2.0 credits)
 */
export function burnX2FromResultCount(resultCount: number): number {
  if (resultCount <= 8) {
    return 2; // 1.0 credit
  } else if (resultCount <= 12) {
    return 3; // 1.5 credits
  } else if (resultCount <= 16) {
    return 4; // 2.0 credits
  } else {
    // For values > 16, round up to nearest 0.5 credit
    const credits = Math.ceil(resultCount * 2) / 2;
    return creditsToX2(credits);
  }
}

/**
 * Compute credits burned based on result count (for reporting)
 * - 1-8 => 1.0
 * - 9-12 => 1.5
 * - 13-16 => 2.0
 * Rounds up to nearest 0.5 (always up)
 */
export function computeCreditsBurned(resultCount: number): number {
  if (resultCount <= 8) {
    return 1.0;
  } else if (resultCount <= 12) {
    return 1.5;
  } else if (resultCount <= 16) {
    return 2.0;
  } else {
    // For values > 16, round up to nearest 0.5
    return Math.ceil(resultCount * 2) / 2;
  }
}

/**
 * Get or create subscription for a shop
 * Handles billing cycle rollover and backfills credits if needed
 */
export async function getOrCreateSubscription(shopId: string) {
  let subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  const now = new Date();

  if (!subscription) {
    // Check if shop has trial info
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { trialStartedAt: true, trialEndsAt: true },
    });

    const trialStartedAt = shop?.trialStartedAt || now;
    const trialEndsAt = shop?.trialEndsAt || new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    // Initialize shop trial if not set
    if (!shop?.trialStartedAt) {
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          trialStartedAt,
          trialEndsAt,
        },
      });
    }

    // Create subscription with TRIAL plan defaults
    const plan = PLANS[PLAN_TIER.TRIAL];
    subscription = await prisma.subscription.create({
      data: {
        shopId,
        planTier: PLAN_TIER.TRIAL,
        status: "active",
        creditsIncludedX2: creditsToX2(plan.includedCredits),
        experiencesIncluded: plan.experiences || 0,
        billingIntervalAnchor: now,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
      },
    });
  } else {
    // Backfill credits if missing
    if (subscription.creditsIncludedX2 === 0) {
      const plan = PLANS[subscription.planTier as PlanTierType] || PLANS[PLAN_TIER.TRIAL];
      await prisma.subscription.update({
        where: { shopId },
        data: {
          creditsIncludedX2: creditsToX2(plan.includedCredits),
          experiencesIncluded: plan.experiences || 0,
        },
      });
      subscription.creditsIncludedX2 = creditsToX2(plan.includedCredits);
      subscription.experiencesIncluded = plan.experiences || 0;
    }

    // Check if billing cycle has rolled over
    let needsRollover = false;
    
    // Method 1: Check Shopify period end
    if (subscription.currentPeriodEnd && now > subscription.currentPeriodEnd) {
      needsRollover = true;
    }
    // Method 2: Calendar month rollover (if no Shopify dates)
    else if (!subscription.currentPeriodEnd && subscription.billingIntervalAnchor) {
      const anchorMonth = subscription.billingIntervalAnchor.getUTCMonth();
      const anchorYear = subscription.billingIntervalAnchor.getUTCFullYear();
      const nowMonth = now.getUTCMonth();
      const nowYear = now.getUTCFullYear();
      
      if (nowYear > anchorYear || (nowYear === anchorYear && nowMonth > anchorMonth)) {
        needsRollover = true;
      }
    }

    if (needsRollover) {
      // Reset credits and per-cycle add-ons for new cycle
      const plan = PLANS[subscription.planTier as PlanTierType] || PLANS[PLAN_TIER.TRIAL];
      
      // Calculate new period
      let newPeriodStart: Date;
      let newPeriodEnd: Date;
      
      if (subscription.currentPeriodEnd) {
        // Use Shopify period end as new start
        newPeriodStart = subscription.currentPeriodEnd;
        newPeriodEnd = new Date(newPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
      } else {
        // Calendar month rollover
        newPeriodStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
        newPeriodEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999);
      }

      // Calculate remaining add-on credits after rollover
      // Credits are consumed in order: first from plan (creditsIncludedX2), then from add-on (creditsAddonX2)
      // On rollover: plan credits reset to plan amount, add-on credits persist (only unused portion)
      const prevIncludedX2 = subscription.creditsIncludedX2 || 0;
      const prevAddonX2 = subscription.creditsAddonX2 || 0;
      const prevUsedX2 = subscription.creditsUsedX2 || 0;
      
      // Calculate how many credits were used from plan vs add-on
      // Plan credits are consumed first, then add-on credits
      const usedFromPlanX2 = Math.min(prevUsedX2, prevIncludedX2);
      const usedFromAddonX2 = Math.max(0, prevUsedX2 - prevIncludedX2);
      
      // Remaining add-on credits = original add-on - used from add-on
      const remainingAddonX2 = Math.max(0, prevAddonX2 - usedFromAddonX2);
      
      // New plan credits for this cycle
      const newCreditsIncludedX2 = creditsToX2(plan.includedCredits);
      
      // Preserve only the remaining add-on credits (not all remaining credits)
      const newCreditsAddonX2 = remainingAddonX2;

      await prisma.subscription.update({
        where: { shopId },
        data: {
          creditsUsedX2: 0, // Reset usage counter
          creditsIncludedX2: newCreditsIncludedX2, // Reset to plan amount
          creditsAddonX2: newCreditsAddonX2, // Adjust to remaining add-on credits
          // experiencesAddon is NOT reset (recurring add-on persists across cycles)
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          billingIntervalAnchor: newPeriodStart, // Update anchor
        },
      });

      subscription.creditsUsedX2 = 0;
      subscription.creditsIncludedX2 = newCreditsIncludedX2;
      subscription.creditsAddonX2 = newCreditsAddonX2;
      // experiencesAddon persists (recurring)
      subscription.currentPeriodStart = newPeriodStart;
      subscription.currentPeriodEnd = newPeriodEnd;
      subscription.billingIntervalAnchor = newPeriodStart;

      // Note: Recurring add-ons should be charged for the new cycle
      // This is handled by chargeRecurringAddonsOnRollover() which should be called
      // after getOrCreateSubscription() detects a rollover (to avoid circular dependency)
    }

    // Ensure billing interval fields exist
    if (!subscription.billingIntervalAnchor) {
      // Anchor to calendar month start
      const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const monthEnd = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999);

      await prisma.subscription.update({
        where: { shopId },
        data: {
          billingIntervalAnchor: monthStart,
          ...(!subscription.currentPeriodStart && {
            currentPeriodStart: monthStart,
            currentPeriodEnd: monthEnd,
          }),
        },
      });

      subscription.billingIntervalAnchor = monthStart;
      if (!subscription.currentPeriodStart) {
        subscription.currentPeriodStart = monthStart;
        subscription.currentPeriodEnd = monthEnd;
      }
    }
    
    // Ensure planTier is set (default to TRIAL)
    if (!subscription.planTier) {
      await prisma.subscription.update({
        where: { shopId },
        data: { planTier: PLAN_TIER.TRIAL },
      });
      subscription.planTier = PLAN_TIER.TRIAL;
    }
    
    // Ensure credits and experiences are backfilled from plan if 0
    if (subscription.creditsIncludedX2 === 0 || subscription.experiencesIncluded === 0) {
      const plan = PLANS[subscription.planTier as PlanTierType] || PLANS[PLAN_TIER.TRIAL];
      await prisma.subscription.update({
        where: { shopId },
        data: {
          creditsIncludedX2: creditsToX2(plan.includedCredits),
          experiencesIncluded: plan.experiences || 0,
        },
      });
      subscription.creditsIncludedX2 = creditsToX2(plan.includedCredits);
      subscription.experiencesIncluded = plan.experiences || 0;
    }
  }

  return subscription;
}

/**
 * Get entitlements for a shop
 * Returns zero access if subscription is cancelled
 */
export async function getEntitlements(shopId: string) {
  const subscription = await getOrCreateSubscription(shopId);
  
  // If subscription is cancelled, block all access
  if (subscription.status === "cancelled") {
    return {
      planTier: subscription.planTier,
      includedCreditsX2: 0,
      addonCreditsX2: 0,
      usedCreditsX2: 0,
      totalCreditsX2: 0,
      remainingX2: 0,
      experiencesLimit: 0,
      candidateCap: 0,
      canBasicReporting: false,
      canMidReporting: false,
      overageRatePerCredit: 0,
      showTrialBadge: false,
    };
  }

  // Check if trial has expired (block access if TRIAL plan but trial ended)
  if (subscription.planTier === PLAN_TIER.TRIAL) {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { trialEndsAt: true },
    });
    
    if (shop?.trialEndsAt && new Date() >= shop.trialEndsAt) {
      // Trial expired - block access
      return {
        planTier: subscription.planTier,
        includedCreditsX2: 0,
        addonCreditsX2: 0,
        usedCreditsX2: 0,
        totalCreditsX2: 0,
        remainingX2: 0,
        experiencesLimit: 0,
        candidateCap: 0,
      canBasicReporting: false,
      canMidReporting: false,
      overageRatePerCredit: 0,
        showTrialBadge: false,
      };
    }
  }

  const plan = PLANS[subscription.planTier as PlanTierType] || PLANS[PLAN_TIER.TRIAL];

  const includedCreditsX2 = subscription.creditsIncludedX2 || 0;
  const addonCreditsX2 = subscription.creditsAddonX2 || 0;
  const usedCreditsX2 = subscription.creditsUsedX2 || 0;
  const totalCreditsX2 = includedCreditsX2 + addonCreditsX2;
  const remainingX2 = Math.max(0, totalCreditsX2 - usedCreditsX2);

  const experiencesLimit = plan.experiences === null ? null : (plan.experiences + (subscription.experiencesAddon || 0));
  const candidateCap = plan.candidateCap;

  // Reporting flags
  const canBasicReporting = true; // All plans have basic reporting
  const canMidReporting = subscription.planTier === PLAN_TIER.SCALE || subscription.planTier === PLAN_TIER.PRO;

  const overageRatePerCredit = plan.overageRate;
  const showTrialBadge = plan.badge || false;

  return {
    planTier: subscription.planTier,
    includedCreditsX2,
    addonCreditsX2,
    usedCreditsX2,
    totalCreditsX2,
    remainingX2,
    experiencesLimit,
    candidateCap,
    canBasicReporting,
    canMidReporting,
    overageRatePerCredit,
    showTrialBadge,
  };
}

/**
 * Get current plan for a shop (preserved for backward compatibility)
 */
export async function getCurrentPlan(shopId: string): Promise<PlanInfo> {
  const subscription = await getOrCreateSubscription(shopId);
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { trialEndsAt: true },
  });

  // Check if trial expired
  if (subscription.planTier === PLAN_TIER.TRIAL && shop?.trialEndsAt) {
    const now = new Date();
    if (now > shop.trialEndsAt) {
      // Trial expired - should prompt upgrade
      return PLANS[PLAN_TIER.LITE]; // Default to LITE after trial
    }
  }

  const rawTier = subscription?.planTier;
  if (isPlanTier(rawTier)) return PLANS[rawTier];
  return PLANS[PLAN_TIER.LITE];
}

/**
 * Check if shop is in trial period
 */
export async function isInTrial(shopId: string): Promise<boolean> {
  const subscription = await getOrCreateSubscription(shopId);
  if (subscription.planTier !== PLAN_TIER.TRIAL) {
    return false;
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { trialEndsAt: true },
  });

  if (!shop?.trialEndsAt) {
    return true; // Trial started but no end date set
  }

  return new Date() < shop.trialEndsAt;
}

/**
 * Check if resultCount is allowed for current plan (preserved for backward compatibility)
 * Now uses candidateCap instead of resultCount limit
 */
export async function isResultCountAllowed(shopId: string, resultCount: number): Promise<boolean> {
  const entitlements = await getEntitlements(shopId);
  // For backward compatibility, allow up to 16 results (old max)
  // In new model, candidateCap is the limit
  return resultCount <= Math.max(16, entitlements.candidateCap);
}

/**
 * Get max allowed resultCount for shop (preserved for backward compatibility)
 */
export async function getMaxResultCount(shopId: string): Promise<number> {
  const entitlements = await getEntitlements(shopId);
  // Return candidateCap, but ensure backward compatibility with old max of 16
  return Math.max(16, entitlements.candidateCap);
}

/**
 * Track usage event
 */
export async function trackUsageEvent(
  shopId: string,
  eventType: UsageEventType,
  metadata?: Record<string, any>,
  creditsBurned: number = 0
) {
  await prisma.usageEvent.create({
    data: {
      shopId,
      eventType,
      metadata: metadata ? JSON.stringify(metadata) : null,
      creditsBurned,
    },
  });
}

/**
 * Get monthly usage for a shop
 */
export async function getMonthlyUsage(shopId: string, year?: number, month?: number) {
  const now = new Date();
  const targetYear = year || now.getFullYear();
  const targetMonth = month || now.getMonth() + 1; // 1-indexed

  const startDate = new Date(targetYear, targetMonth - 1, 1);
  const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

  const events = await prisma.usageEvent.findMany({
    where: {
      shopId,
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const sessionsStarted = events.filter(
    (e) => e.eventType === "SESSION_STARTED"
  ).length;

  const aiRankingsExecuted = events.filter(
    (e) => e.eventType === "AI_RANKING_EXECUTED"
  ).length;

  const totalCreditsBurned = events.reduce(
    (sum, e) => sum + (e.creditsBurned || 0),
    0
  );

  return {
    year: targetYear,
    month: targetMonth,
    sessionsStarted,
    aiRankingsExecuted,
    totalCreditsBurned,
    totalEvents: events.length,
    events,
  };
}

/**
 * Get usage summary for current month
 */
export async function getCurrentMonthUsage(shopId: string) {
  return getMonthlyUsage(shopId);
}

/**
 * Charge a concierge session once for the final result count
 * Prevents duplicate charges using 5-minute cooldown on chargedAt
 * Returns overageCreditsX2Delta for usage billing
 */
export async function chargeConciergeSessionOnce(params: {
  sessionToken: string; // publicToken from ConciergeSession
  shopId: string;
  resultCount: number; // final bundle size used: 8/12/16
  experienceId?: string;
}): Promise<{ charged: boolean; creditsBurned: number; overageCreditsX2Delta: number }> {
  const { sessionToken, shopId, resultCount, experienceId } = params;

  // Compute credits from FINAL resultCount (for reporting)
  const creditsBurned = computeCreditsBurned(resultCount);
  const burnX2 = burnX2FromResultCount(resultCount);

  // Load session by publicToken
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    select: { id: true, chargedAt: true },
  });

  if (!session) {
    throw new Error(`ConciergeSession not found for token: ${sessionToken}`);
  }

  // Prevent double charge (5-minute window) or already charged
  const now = new Date();
  const alreadyChargedRecently =
    session.chargedAt && (now.getTime() - session.chargedAt.getTime()) < 5 * 60 * 1000;

  if (alreadyChargedRecently) {
    console.log("[Billing] Session already charged recently, skipping duplicate charge");
    return { charged: false, creditsBurned, overageCreditsX2Delta: 0 };
  }

  // Write charge marker
  await prisma.conciergeSession.update({
    where: { id: session.id },
    data: { chargedAt: now },
  });

  // Update subscription credits in a transaction
  const subscription = await prisma.$transaction(async (tx) => {
    // Load subscription with lock
    const sub = await tx.subscription.findUnique({
      where: { shopId },
    });

    if (!sub) {
      throw new Error(`Subscription not found for shop: ${shopId}`);
    }

    // Block access if subscription is cancelled
    if (sub.status === "cancelled") {
      throw new Error("Subscription has been cancelled. Please subscribe to continue using EditMuse.");
    }

    const totalCreditsX2 = (sub.creditsIncludedX2 || 0) + (sub.creditsAddonX2 || 0);
    const prevUsed = sub.creditsUsedX2 || 0;
    const newUsed = prevUsed + burnX2;

    // Calculate overage delta
    const prevOver = Math.max(0, prevUsed - totalCreditsX2);
    const newOver = Math.max(0, newUsed - totalCreditsX2);
    const deltaOverX2 = newOver - prevOver;

    // Update subscription
    await tx.subscription.update({
      where: { shopId },
      data: {
        creditsUsedX2: newUsed,
      },
    });

    return {
      ...sub,
      creditsUsedX2: newUsed,
      deltaOverX2,
    };
  });

  // Create ONE billable UsageEvent
  await trackUsageEvent(
    shopId,
    "AI_RANKING_EXECUTED" as UsageEventType,
    {
      sessionToken,
      experienceId,
      resultCount,
    },
    creditsBurned
  );

  console.log("[Billing] Charged session", sessionToken, "for", resultCount, "results =", creditsBurned, "credits, overage delta =", subscription.deltaOverX2);

  return {
    charged: true,
    creditsBurned,
    overageCreditsX2Delta: subscription.deltaOverX2,
  };
}

/**
 * Apply add-on to subscription
 * Updates subscription fields based on add-on type
 * 
 * ONE-TIME add-ons (credits): Add to creditsAddonX2 (persists until used up, does NOT reset on cycle rollover)
 * RECURRING add-ons (experiences, reporting): Set persistent state
 */
export async function applyAddonToSubscription(params: {
  shopId: string;
  addonKey: "credits_2000" | "credits_5000" | "exp_3" | "exp_10";
}): Promise<{ ok: true }> {
  const { shopId, addonKey } = params;

  // Load subscription (ensures it exists and handles rollover)
  const subscription = await getOrCreateSubscription(shopId);

  // Update subscription in transaction
  await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.findUnique({
      where: { shopId },
    });

    if (!sub) {
      throw new Error(`Subscription not found for shop: ${shopId}`);
    }

    const updateData: any = {};

    switch (addonKey) {
      // ONE-TIME credit top-ups (persist until used up, do NOT reset on cycle rollover)
      case "credits_2000":
        updateData.creditsAddonX2 = (sub.creditsAddonX2 || 0) + creditsToX2(2000);
        break;
      case "credits_5000":
        updateData.creditsAddonX2 = (sub.creditsAddonX2 || 0) + creditsToX2(5000);
        break;
      // RECURRING experience packs (persist across cycles)
      case "exp_3":
        updateData.experiencesAddon = 3; // Set to pack size (not additive)
        break;
      case "exp_10":
        updateData.experiencesAddon = 10; // Set to pack size (not additive)
        break;
      default:
        throw new Error(`Unknown add-on key: ${addonKey}`);
    }

    await tx.subscription.update({
      where: { shopId },
      data: updateData,
    });
  });

  return { ok: true };
}

/**
 * Set recurring experience pack (recurring monthly add-on)
 * NONE = disable, EXP_3 = +3 experiences/month, EXP_10 = +10 experiences/month
 */
export async function setRecurringExperiencePack(params: {
  shopId: string;
  pack: "NONE" | "EXP_3" | "EXP_10";
}): Promise<{ ok: true }> {
  const { shopId, pack } = params;

  const now = new Date();
  await prisma.subscription.update({
    where: { shopId },
    data: {
      experiencesAddon: pack === "NONE" ? 0 : pack === "EXP_3" ? 3 : 10,
      // Store enable date for monthly billing from enable date (not cycle rollover)
      experiencesAddonEnabledAt: pack === "NONE" ? null : now,
    },
  });

  return { ok: true };
}

/**
 * Disable recurring experience pack (sets experiencesAddon to 0)
 */
export async function disableRecurringExperiencePack(shopId: string): Promise<{ ok: true }> {
  await prisma.subscription.update({
    where: { shopId },
    data: { 
      experiencesAddon: 0,
      experiencesAddonEnabledAt: null, // Clear enable date when disabled
    },
  });

  return { ok: true };
}


/**
 * Mark subscription as cancelled - blocks access until they subscribe again
 * Does NOT revert to TRIAL - they lose access completely
 */
export async function markSubscriptionAsCancelled(shopId: string): Promise<{ ok: true }> {
  // Get current subscription to calculate unused add-on credits
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  // Calculate unused add-on credits (only positive values)
  // Credits are consumed in order: plan first, then add-on
  // So we need to calculate how much was used from add-on credits specifically
  const creditsIncludedX2 = subscription.creditsIncludedX2 || 0;
  const creditsAddonX2 = subscription.creditsAddonX2 || 0;
  const creditsUsedX2 = subscription.creditsUsedX2 || 0;
  
  // If total used is less than or equal to plan credits, no add-on credits were used
  // Otherwise, calculate how much was used from add-on credits
  const usedFromAddonX2 = creditsUsedX2 > creditsIncludedX2 
    ? creditsUsedX2 - creditsIncludedX2 
    : 0;
  
  // Unused add-on credits = original add-on - used from add-on
  const unusedAddonCreditsX2 = Math.max(0, creditsAddonX2 - usedFromAddonX2);

  // Preserve recurring add-on state and enable dates for grace period restoration
  const preservedExperiencesAddon = subscription.experiencesAddon || 0;
  const preservedExperiencesAddonEnabledAt = subscription.experiencesAddonEnabledAt;

  // Mark subscription as cancelled - keep planTier but set status to cancelled
  // This blocks all access until they subscribe again
  await prisma.subscription.update({
    where: { shopId },
    data: {
      status: "cancelled", // Mark as cancelled - blocks access
      creditsAddonX2: 0, // Reset add-on credits (will be restored if resubscribe within grace period)
      creditsUsedX2: 0, // Reset usage
      experiencesAddon: 0, // Disable recurring experience packs (will be restored if resubscribe within grace period)
      // Preserve unused add-on credits and recurring add-on state for grace period restoration
      preservedCreditsAddonX2: unusedAddonCreditsX2,
      preservedExperiencesAddon: preservedExperiencesAddon,
      // Preserve enable dates so we can restore monthly billing from enable date
      preservedExperiencesAddonEnabledAt: preservedExperiencesAddonEnabledAt,
      experiencesAddonEnabledAt: null, // Clear on cancellation (will be restored from preserved state)
      cancelledAt: new Date(), // Store cancellation timestamp
      // Clear Shopify subscription IDs (subscription is cancelled)
      shopifySubscriptionGid: null,
      shopifyRecurringLineItemGid: null,
      shopifyUsageLineItemGid: null,
      // Clear billing period dates (no active subscription)
      currentPeriodStart: null,
      currentPeriodEnd: null,
    },
  });

  console.log("[Billing] Subscription marked as cancelled", {
    shopId,
    preservedCredits: unusedAddonCreditsX2 / 2, // Convert X2 to actual credits for logging
    preservedExperiencesAddon: preservedExperiencesAddon,
    note: "Access blocked - must subscribe to continue. Unused add-on credits and recurring add-ons preserved for 30-day grace period.",
  });

  return { ok: true };
}

/**
 * Charge recurring add-ons monthly from their enable date (not cycle rollover)
 * This should be called periodically (e.g., daily cron job or on app access)
 * Returns true if any charges were attempted
 */
export async function chargeRecurringAddonsMonthly(shopId: string): Promise<boolean> {
  // Dynamic import to avoid circular dependency
  const { chargeRecurringAddonForCycle } = await import("./shopify-billing.server");
  
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!subscription) {
    return false;
  }

  // Don't charge recurring add-ons if subscription is cancelled
  if (subscription.status === "cancelled") {
    return false;
  }

  // Get shop domain
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true },
  });

  if (!shop?.domain) {
    return false;
  }

  const now = new Date();
  let charged = false;

  // Helper function to check if monthly anniversary has passed (same day of month)
  // NOTE: First charge happens when enabled (in action handler), so we only charge on subsequent months
  const isMonthlyAnniversary = (enabledAt: Date | null): boolean => {
    if (!enabledAt) return false;
    
    const enabledDate = new Date(enabledAt);
    const enabledDay = enabledDate.getDate();
    const enabledMonth = enabledDate.getMonth();
    const enabledYear = enabledDate.getFullYear();
    
    const nowDay = now.getDate();
    const nowMonth = now.getMonth();
    const nowYear = now.getFullYear();
    
    // Only charge on subsequent months (not the same day when enabled - that's handled in action handler)
    // Check if we're in a later month and on or past the anniversary day
    if (nowYear > enabledYear || (nowYear === enabledYear && nowMonth > enabledMonth)) {
      // We're in a later month, check if we're on or past the anniversary day
      if (nowDay >= enabledDay) {
        return true;
      }
    }
    // If same month/year, don't charge (first charge already happened when enabled)
    
    return false;
  };

  // Helper function to get cycle key for monthly billing (current month + enable day)
  // Uses current month/year + enable day to ensure unique idempotency per month
  const getMonthlyCycleKey = (enabledAt: Date): string => {
    const enabledDay = enabledAt.getDate();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    // Format: YYYY-MM-DD where DD is the enable day, MM/YYYY is current month
    return `${nowYear}-${nowMonth.toString().padStart(2, '0')}-${enabledDay.toString().padStart(2, '0')}`;
  };

  // Charge recurring experience pack if enabled and monthly anniversary has passed
  if (subscription.experiencesAddon === 3 && subscription.experiencesAddonEnabledAt) {
    if (isMonthlyAnniversary(subscription.experiencesAddonEnabledAt)) {
      try {
        const cycleKey = getMonthlyCycleKey(subscription.experiencesAddonEnabledAt);
        await chargeRecurringAddonForCycle({
          shopDomain: shop.domain,
          addonKey: "exp_3",
          priceUsd: 15,
          cycleKey,
        });
        charged = true;
        console.log("[Billing] Charged recurring exp_3 on monthly anniversary", {
          shop: shop.domain,
          enabledAt: subscription.experiencesAddonEnabledAt,
        });
      } catch (error) {
        console.error("[Billing] Error charging recurring exp_3 on monthly anniversary:", error);
      }
    }
  } else if (subscription.experiencesAddon === 10 && subscription.experiencesAddonEnabledAt) {
    if (isMonthlyAnniversary(subscription.experiencesAddonEnabledAt)) {
      try {
        const cycleKey = getMonthlyCycleKey(subscription.experiencesAddonEnabledAt);
        await chargeRecurringAddonForCycle({
          shopDomain: shop.domain,
          addonKey: "exp_10",
          priceUsd: 39,
          cycleKey,
        });
        charged = true;
        console.log("[Billing] Charged recurring exp_10 on monthly anniversary", {
          shop: shop.domain,
          enabledAt: subscription.experiencesAddonEnabledAt,
        });
      } catch (error) {
        console.error("[Billing] Error charging recurring exp_10 on monthly anniversary:", error);
      }
    }
  }

  return charged;
}

/**
 * @deprecated Use chargeRecurringAddonsMonthly instead - charges monthly from enable date, not cycle rollover
 * Kept for backward compatibility but should not be used
 */
export async function chargeRecurringAddonsOnRollover(shopId: string): Promise<boolean> {
  // No longer charge on rollover - recurring add-ons are charged monthly from enable date
  return false;
}
