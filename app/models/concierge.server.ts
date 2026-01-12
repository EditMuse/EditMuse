import prisma from "~/db.server";
import { ConciergeSessionStatus, ConciergeRole } from "@prisma/client";
import { randomBytes } from "crypto";

/**
 * Creates a new concierge session and returns the public token
 */
export async function createConciergeSession({
  shopId,
  experienceId,
  resultCount = 8,
  answersJson,
  clientRequestId,
}: {
  shopId: string;
  experienceId?: string | null;
  resultCount?: number;
  answersJson?: string;
  clientRequestId?: string | null;
}): Promise<string> {
  // Generate a unique public token
  const publicToken = randomBytes(32).toString("base64url");

  await prisma.conciergeSession.create({
    data: {
      publicToken,
      shopId,
      experienceId: experienceId || null,
      status: ConciergeSessionStatus.COLLECTING,
      resultCount,
      answersJson: answersJson || "[]",
      clientRequestId: clientRequestId || null,
    },
  });

  return publicToken;
}

/**
 * Adds a message to a concierge session
 */
export async function addConciergeMessage({
  sessionToken,
  role,
  text,
  imageUrl,
}: {
  sessionToken: string;
  role: ConciergeRole;
  text?: string | null;
  imageUrl?: string | null;
}): Promise<void> {
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionToken}`);
  }

  await prisma.conciergeMessage.create({
    data: {
      sessionId: session.id,
      role,
      text: text || null,
      imageUrl: imageUrl || null,
    },
  });
}

/**
 * Saves the result for a concierge session
 */
export async function saveConciergeResult({
  sessionToken,
  productHandles,
  productIds,
  reasoning,
}: {
  sessionToken: string;
  productHandles: string[];
  productIds?: string[] | null;
  reasoning?: string | null;
}): Promise<void> {
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionToken}`);
  }

  // Upsert result (create or update if exists)
  await prisma.conciergeResult.upsert({
    where: { sessionId: session.id },
    create: {
      sessionId: session.id,
      productHandles,
      productIds: productIds || null,
      reasoning: reasoning || null,
    },
    update: {
      productHandles,
      productIds: productIds || null,
      reasoning: reasoning || null,
    },
  });

  // Update session status to COMPLETE
  await prisma.conciergeSession.update({
    where: { id: session.id },
    data: { status: ConciergeSessionStatus.COMPLETE },
  });
}

/**
 * Gets a concierge session by public token
 */
export async function getConciergeSessionByToken(sessionToken: string) {
  return await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
      result: true,
      shop: true,
      experience: true,
    },
  });
}

/**
 * Gets the result for a concierge session by public token
 */
export async function getConciergeResultByToken(sessionToken: string) {
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    include: { result: true },
  });

  return session?.result || null;
}

