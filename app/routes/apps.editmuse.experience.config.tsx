import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /apps/editmuse/experience/config");

  const url = new URL(request.url);
  const query = url.searchParams;

  // Get experienceId first (needed to determine shop)
  const experienceId = query.get("experienceId");
  if (!experienceId) {
    console.log("[App Proxy] Missing experienceId parameter");
    return Response.json({ error: "Missing experienceId parameter" }, { status: 400 });
  }

  // Get experience to determine shop (before validation)
  const experience = await prisma.experience.findUnique({
    where: { id: experienceId },
    include: { shop: true },
  });

  if (!experience) {
    console.log("[App Proxy] Experience not found:", experienceId);
    return Response.json({ error: "Experience not found" }, { status: 404 });
  }

  const shopDomain = experience.shop.domain;
  console.log("[App Proxy] Shop domain from experience:", shopDomain);

  // Validate HMAC signature if present (for App Proxy requests)
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const hasSignature = query.has("signature");
  
  if (hasSignature) {
    const isValid = validateAppProxySignature(query, secret);
    console.log("[App Proxy] Signature validation:", isValid ? "PASSED" : "FAILED");

    if (!isValid) {
      console.log("[App Proxy] Invalid signature - returning 401");
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Verify shop matches if provided in query
    const queryShop = getShopFromAppProxy(query);
    if (queryShop && queryShop !== shopDomain) {
      console.log("[App Proxy] Shop mismatch");
      return Response.json({ error: "Experience shop mismatch" }, { status: 403 });
    }
  } else {
    console.log("[App Proxy] No signature in query - allowing request (storefront direct call)");
  }

  // Parse questionsJson
  let questions: any[] = [];
  try {
    const questionsJson = (experience as any).questionsJson || "[]";
    console.log("[App Proxy] Raw questionsJson (first 200 chars):", questionsJson.substring(0, 200));
    questions = JSON.parse(questionsJson);
    if (!Array.isArray(questions)) {
      console.warn("[App Proxy] questionsJson is not an array, got:", typeof questions);
      questions = [];
    }
    console.log("[App Proxy] Parsed", questions.length, "questions");
    questions.forEach((q, i) => {
      console.log("[App Proxy] Question", i + 1, ":", { id: q.id, type: q.type, prompt: q.prompt || q.question });
    });
  } catch (error) {
    console.error("[App Proxy] Error parsing questionsJson:", error);
    questions = [];
  }

  console.log("[App Proxy] Returning", questions.length, "questions for experience:", experienceId);

  return Response.json({
    ok: true,
    questions,
  });
};

