import prisma from "~/db.server";

/**
 * Resolves a ConciergeSession for attribution purposes
 * Tries sessionToken field first, else by id (sessionId), else returns null
 */
export async function resolveSessionForAttribution(params: {
  shopId: string;
  sessionToken?: string | null;
  sessionId?: string | null;
}): Promise<{ id: string; publicToken: string; shopId: string } | null> {
  const { shopId, sessionToken, sessionId } = params;

  // First try lookup by sessionToken if provided
  if (sessionToken) {
    const bySessionToken = await prisma.conciergeSession.findFirst({
      where: {
        shopId,
        sessionToken,
      },
      select: { id: true, publicToken: true, shopId: true },
    });

    if (bySessionToken) {
      return bySessionToken;
    }
  }

  // Fallback: try by id (sessionId)
  if (sessionId) {
    const byId = await prisma.conciergeSession.findFirst({
      where: {
        shopId,
        id: sessionId,
      },
      select: { id: true, publicToken: true, shopId: true },
    });

    if (byId) {
      return byId;
    }
  }

  return null;
}

/**
 * Upserts an AttributionAttempt with idempotent deduplication
 * If checkoutToken present: dedupe by (shopId, checkoutToken)
 * Else if cartToken present: dedupe by (shopId, cartToken)
 * Else return null (no token to dedupe by)
 */
export async function upsertAttributionAttempt(params: {
  shopId: string;
  sessionId: string;
  sessionToken: string | null;
  cartToken?: string | null;
  checkoutToken?: string | null;
}): Promise<void> {
  const { shopId, sessionId, sessionToken, cartToken, checkoutToken } = params;

  // Determine deduplication key: prefer checkoutToken, fallback to cartToken
  let existing: any = null;
  if (checkoutToken) {
    existing = await prisma.attributionAttempt.findFirst({
      where: {
        shopId,
        checkoutToken,
      },
    });
  } else if (cartToken) {
    existing = await prisma.attributionAttempt.findFirst({
      where: {
        shopId,
        cartToken,
      },
    });
  } else {
    // No token to dedupe by, skip
    return;
  }

  if (existing) {
    // Update existing (idempotent)
    await prisma.attributionAttempt.update({
      where: { id: existing.id },
      data: {
        sessionId,
        sessionToken: sessionToken || existing.sessionToken,
        cartToken: cartToken || existing.cartToken,
        checkoutToken: checkoutToken || existing.checkoutToken,
      },
    });
  } else {
    // Create new attempt
    await prisma.attributionAttempt.create({
      data: {
        shopId,
        sessionId,
        sessionToken: sessionToken || null,
        cartToken: cartToken || null,
        checkoutToken: checkoutToken || null,
      },
    });
  }
}

/**
 * Upserts OrderAttribution idempotently using (shopId, orderId) unique constraint
 */
export async function upsertOrderAttribution(params: {
  shopId: string;
  orderId: string;
  sessionId: string | null;
  sessionToken: string | null;
  attributionType: "direct" | "assisted" | "unattributed";
  totalPrice: string;
  currencyCode: string | null;
  orderNumber?: string | null;
}): Promise<void> {
  const {
    shopId,
    orderId,
    sessionId,
    sessionToken,
    attributionType,
    totalPrice,
    currencyCode,
    orderNumber,
  } = params;

  // Check if already exists (using unique constraint would handle this, but we check explicitly)
  const existing = await prisma.orderAttribution.findFirst({
    where: {
      shopId,
      orderId,
    },
  });

  if (existing) {
    // Already exists, skip (idempotent - unique constraint ensures no duplicates)
    return;
  }

  // Create new attribution
  await prisma.orderAttribution.create({
    data: {
      shopId,
      orderId,
      orderNumber: orderNumber || null,
      sessionId: sessionId || null,
      sessionToken: sessionToken || null,
      attributionType,
      totalPrice,
      currencyCode: currencyCode || null,
    },
  });
}

