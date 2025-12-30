import type { ActionFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { addConciergeMessage } from "~/models/concierge.server";
import { ConciergeRole } from "@prisma/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[App Proxy] POST /apps/editmuse/session/message");

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

  // Get shop domain (for validation, but not used in message creation)
  const shopDomain = getShopFromAppProxy(query);
  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Parse JSON body
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, text, imageUrl } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // Add message using helper (role is always USER for App Proxy)
  try {
    await addConciergeMessage({
      sessionToken: sessionId,
      role: ConciergeRole.USER,
      text: text || null,
      imageUrl: imageUrl || null,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Session not found")) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    throw error;
  }

  return Response.json({ ok: true });
};

