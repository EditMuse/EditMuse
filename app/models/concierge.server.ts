import prisma from "~/db.server";
import { ConciergeSessionStatus, ConciergeRole } from "@prisma/client";
import { randomBytes } from "crypto";

/**
 * Extract query text from answers or messages
 */
export function extractQueryFromAnswers(answersJson: string | null): { raw: string; normalized: string } | null {
  if (!answersJson) return null;
  
  try {
    const answers = JSON.parse(answersJson);
    if (!Array.isArray(answers) || answers.length === 0) return null;

    // Extract query text from answers (same logic as dashboard)
    const queryText = answers
      .map((a: any) => {
        if (typeof a === "string") return a;
        if (a.question && a.answer) return `${a.question}: ${a.answer}`;
        if (a.text) return a.text;
        return JSON.stringify(a);
      })
      .join(" ")
      .trim();

    if (!queryText) return null;

    // Normalize: lowercase and trim
    const normalized = queryText.toLowerCase().trim();
    
    return { raw: queryText, normalized };
  } catch (e) {
    return null;
  }
}

/**
 * Extract query from earliest USER message
 */
export async function extractQueryFromMessages(sessionId: string): Promise<{ raw: string; normalized: string } | null> {
  const firstMessage = await prisma.conciergeMessage.findFirst({
    where: {
      sessionId,
      role: ConciergeRole.USER,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      text: true,
    },
  });

  if (!firstMessage || !firstMessage.text) return null;

  const raw = firstMessage.text.trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase().trim();
  return { raw, normalized };
}

/**
 * Gets a concierge session by public token
 */
export async function getConciergeSessionByToken(sessionToken: string) {
  return await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    include: { shop: true },
  });
}

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

  // Extract query from answers if provided
  const queryData = extractQueryFromAnswers(answersJson || null);

  await prisma.conciergeSession.create({
    data: {
      publicToken,
      shopId,
      experienceId: experienceId || null,
      status: ConciergeSessionStatus.COLLECTING,
      resultCount,
      answersJson: answersJson || "[]",
      queryRaw: queryData?.raw || null,
      queryNormalized: queryData?.normalized || null,
      clientRequestId: clientRequestId || null,
    },
  });

  return publicToken;
}

/**
 * Saves concierge result and marks session as COMPLETE
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
  // Find session by token
  const session = await prisma.conciergeSession.findUnique({
    where: { publicToken: sessionToken },
    select: { id: true },
  });

  if (!session) {
    throw new Error(`ConciergeSession not found for token: ${sessionToken}`);
  }

  // Upsert result and update session status
  await prisma.$transaction([
    prisma.conciergeResult.upsert({
      where: { sessionId: session.id },
      create: {
        sessionId: session.id,
        productHandles: productHandles,
        productIds: productIds || null,
        reasoning: reasoning || null,
      },
      update: {
        productHandles: productHandles,
        productIds: productIds || null,
        reasoning: reasoning || null,
      },
    }),
    prisma.conciergeSession.update({
      where: { id: session.id },
      data: { status: ConciergeSessionStatus.COMPLETE },
    }),
  ]);
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
    select: { id: true },
  });

  if (!session) {
    throw new Error(`ConciergeSession not found for token: ${sessionToken}`);
  }

  await prisma.conciergeMessage.create({
    data: {
      sessionId: session.id,
      role,
      text: text || null,
      imageUrl: imageUrl || null,
    },
  });

  // If this is the first USER message and queryRaw is not set, update it
  if (role === ConciergeRole.USER && text) {
    const sessionRecord = await prisma.conciergeSession.findUnique({
      where: { id: session.id },
      select: { queryRaw: true },
    });

    if (!sessionRecord?.queryRaw) {
      const raw = text.trim();
      const normalized = raw.toLowerCase().trim();
      await prisma.conciergeSession.update({
        where: { id: session.id },
        data: {
          queryRaw: raw,
          queryNormalized: normalized,
        },
      });
    }
  }
}

/**
 * Backfill queryRaw and queryNormalized for existing sessions
 */
export async function backfillSessionQueries(limit: number = 1000) {
  const sessions = await prisma.conciergeSession.findMany({
    where: {
      OR: [
        { queryRaw: null },
        { queryNormalized: null },
      ],
    },
    select: {
      id: true,
      answersJson: true,
    },
    take: limit,
  });

  let updated = 0;

  for (const session of sessions) {
    let queryData: { raw: string; normalized: string } | null = null;

    // Try to extract from answersJson first
    queryData = extractQueryFromAnswers(session.answersJson);

    // Fall back to earliest USER message if answersJson doesn't yield a query
    if (!queryData) {
      queryData = await extractQueryFromMessages(session.id);
    }

    if (queryData) {
      await prisma.conciergeSession.update({
        where: { id: session.id },
        data: {
          queryRaw: queryData.raw,
          queryNormalized: queryData.normalized,
        },
      });
      updated++;
    }
  }

  return { processed: sessions.length, updated };
}
