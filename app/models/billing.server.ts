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

      await prisma.subscription.update({
        where: { shopId },
        data: {
          creditsUsedX2: 0,
          creditsAddonX2: 0, // Reset one-time credit top-ups (do NOT carry over)
          // experiencesAddon is NOT reset (recurring add-on persists across cycles)
          // advancedReportingAddon is NOT reset (recurring add-on persists across cycles)
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          billingIntervalAnchor: newPeriodStart, // Update anchor
        },
      });

      subscription.creditsUsedX2 = 0;
      subscription.creditsAddonX2 = 0;
      // experiencesAddon and advancedReportingAddon persist (recurring)
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
 */
export async function getEntitlements(shopId: string) {
  const subscription = await getOrCreateSubscription(shopId);
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
  const canAdvancedReporting = subscription.planTier === PLAN_TIER.PRO || subscription.advancedReportingAddon === true;

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
    canAdvancedReporting,
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
 * ONE-TIME add-ons (credits): Add to creditsAddonX2 (resets each cycle)
 * RECURRING add-ons (experiences, reporting): Set persistent state
 */
export async function applyAddonToSubscription(params: {
  shopId: string;
  addonKey: "credits_2000" | "credits_5000" | "exp_3" | "exp_10" | "advanced_reporting";
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
      // ONE-TIME credit top-ups (reset each cycle)
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
      // RECURRING advanced reporting (persist across cycles)
      case "advanced_reporting":
        updateData.advancedReportingAddon = true;
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

  await prisma.subscription.update({
    where: { shopId },
    data: {
      experiencesAddon: pack === "NONE" ? 0 : pack === "EXP_3" ? 3 : 10,
    },
  });

  return { ok: true };
}

/**
 * Set recurring advanced reporting add-on (recurring monthly)
 */
export async function setRecurringAdvancedReporting(params: {
  shopId: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const { shopId, enabled } = params;

  await prisma.subscription.update({
    where: { shopId },
    data: {
      advancedReportingAddon: enabled,
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
    data: { experiencesAddon: 0 },
  });

  return { ok: true };
}

/**
 * Disable recurring advanced reporting add-on
 */
export async function disableRecurringAdvancedReporting(shopId: string): Promise<{ ok: true }> {
  await prisma.subscription.update({
    where: { shopId },
    data: { advancedReportingAddon: false },
  });

  return { ok: true };
}

/**
 * Check if a rollover just occurred and charge recurring add-ons if needed
 * This should be called after getOrCreateSubscription() to charge recurring add-ons on rollover
 * Returns true if rollover was detected and charges were attempted
 */
export async function chargeRecurringAddonsOnRollover(shopId: string): Promise<boolean> {
  // Dynamic import to avoid circular dependency
  const { chargeRecurringAddonForCycle } = await import("./shopify-billing.server");
  
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
  });

  if (!subscription) {
    return false;
  }

  // Get shop domain
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true },
  });

  if (!shop?.domain || !subscription.currentPeriodStart) {
    return false;
  }

  // Check if we're in a new cycle (within first day of period)
  const now = new Date();
  const periodStart = subscription.currentPeriodStart;
  const daysSincePeriodStart = (now.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24);

  // Only charge if we're within the first day of the new period (to avoid duplicate charges)
  if (daysSincePeriodStart > 1) {
    return false;
  }

  const cycleKey = getBillingCycleKey({
    currentPeriodStart: subscription.currentPeriodStart,
    now,
  });

  let charged = false;

  // Charge recurring experience pack if enabled
  if (subscription.experiencesAddon === 3) {
    try {
      await chargeRecurringAddonForCycle({
        shopDomain: shop.domain,
        addonKey: "exp_3",
        priceUsd: 15,
        cycleKey,
      });
      charged = true;
    } catch (error) {
      console.error("[Billing] Error charging recurring exp_3 on rollover:", error);
    }
  } else if (subscription.experiencesAddon === 10) {
    try {
      await chargeRecurringAddonForCycle({
        shopDomain: shop.domain,
        addonKey: "exp_10",
        priceUsd: 39,
        cycleKey,
      });
      charged = true;
    } catch (error) {
      console.error("[Billing] Error charging recurring exp_10 on rollover:", error);
    }
  }

  // Charge recurring advanced reporting if enabled
  if (subscription.advancedReportingAddon === true) {
    try {
      await chargeRecurringAddonForCycle({
        shopDomain: shop.domain,
        addonKey: "advanced_reporting",
        priceUsd: 29,
        cycleKey,
      });
      charged = true;
    } catch (error) {
      console.error("[Billing] Error charging recurring advanced_reporting on rollover:", error);
    }
  }

  return charged;
}
