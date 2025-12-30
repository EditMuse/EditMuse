import type { ActionFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { addConciergeMessage, getConciergeSessionByToken } from "~/models/concierge.server";
import { ConciergeRole } from "@prisma/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[App Proxy] POST /apps/editmuse/session/answer");

  if (request.method !== "POST") {
    console.log("[App Proxy] Method not allowed:", request.method);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const query = url.searchParams;

  // Validate HMAC signature
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const isValid = validateAppProxySignature(query, secret);
  console.log("[App Proxy] Signature validation:", isValid ? "PASSED" : "FAILED");

  if (!isValid) {
    console.log("[App Proxy] Invalid signature - returning 401");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Get shop domain
  const shopDomain = getShopFromAppProxy(query);
  if (!shopDomain) {
    console.log("[App Proxy] Missing shop parameter");
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  console.log("[App Proxy] Shop domain:", shopDomain);

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    console.log("[App Proxy] Invalid JSON body");
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, answer } = body;

  if (!sessionId || !answer) {
    console.log("[App Proxy] Missing sessionId or answer");
    return Response.json({ error: "Missing sessionId or answer" }, { status: 400 });
  }

  // Get session and verify shop
  const session = await getConciergeSessionByToken(sessionId);
  if (!session) {
    console.log("[App Proxy] Session not found:", sessionId);
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.shop.domain !== shopDomain) {
    console.log("[App Proxy] Shop mismatch");
    return Response.json({ error: "Session shop mismatch" }, { status: 403 });
  }

  // Add message
  try {
    await addConciergeMessage({
      sessionToken: sessionId,
      role: ConciergeRole.USER,
      text: answer,
      imageUrl: null,
    });
    console.log("[App Proxy] Message added to session:", sessionId);
  } catch (error) {
    console.error("[App Proxy] Error adding message:", error);
    return Response.json({ error: "Failed to save answer" }, { status: 500 });
  }

  // For MVP: After first answer, redirect to results
  // In future, this could return nextQuestion for multi-step flow
  return Response.json({
    ok: true,
    done: true,
    redirectUrl: `/pages/editmuse-results?editmuse_session=${encodeURIComponent(sessionId)}`,
  });
};

