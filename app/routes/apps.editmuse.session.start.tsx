import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { createConciergeSession } from "~/models/concierge.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[App Proxy] POST /apps/editmuse/session/start");

  if (request.method !== "POST") {
    console.log("[App Proxy] Method not allowed:", request.method);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Authenticate App Proxy request using Shopify SDK
  let shopDomain: string;
  try {
    const authResult = await authenticate.public.appProxy(request);
    if (!authResult?.session?.shop) {
      throw new Error("Session or shop missing from authentication");
    }
    shopDomain = authResult.session.shop;
    console.log("[App Proxy] Authentication PASSED, shop domain:", shopDomain);
  } catch (error) {
    const url = new URL(request.url);
    const queryParams = Array.from(url.searchParams.entries());
    console.error("[App Proxy] Authentication FAILED:", error);
    console.log("[App Proxy] Query params:", queryParams.map(([k]) => k).join(", "));
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!shopDomain) {
    console.log("[App Proxy] Shop domain missing from session");
    return Response.json({ error: "Missing shop domain" }, { status: 400 });
  }

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { experienceId, resultCount } = body;

  // Upsert shop (create if doesn't exist)
  // Note: For App Proxy, we may not have access token yet
  // This is a simplified version - in production you'd get token from OAuth flow
  let shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    // For MVP, create shop without access token (will need to be updated via OAuth)
    // In production, App Proxy requests should come after OAuth installation
    shop = await prisma.shop.create({
      data: {
        domain: shopDomain,
        accessToken: "", // Placeholder - should be set via OAuth
      },
    });
  }

  // Validate experienceId if provided
  let experienceIdToUse: string | null = null;
  if (experienceId) {
    const experience = await prisma.experience.findFirst({
      where: {
        id: experienceId,
        shopId: shop.id,
      },
    });

    if (!experience) {
      return Response.json({ error: "Experience not found" }, { status: 404 });
    }

    experienceIdToUse = experience.id;
  }

  // Validate resultCount
  const validResultCounts = [8, 12, 16];
  const finalResultCount = resultCount && validResultCounts.includes(resultCount)
    ? resultCount
    : 8;

  // Create session using helper
  const sessionToken = await createConciergeSession({
    shopId: shop.id,
    experienceId: experienceIdToUse,
    resultCount: finalResultCount,
  });

  console.log("[App Proxy] Session created:", sessionToken);

  return Response.json({
    ok: true,
    sessionId: sessionToken,
    firstQuestion: "What are you looking for?",
  });
};

