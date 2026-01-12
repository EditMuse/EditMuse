import type { ActionFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import { addConciergeMessage, getConciergeSessionByToken } from "~/models/concierge.server";
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

  const { sessionId, message, step } = body;

  if (!sessionId || !message) {
    return Response.json({ error: "Missing sessionId or message" }, { status: 400 });
  }

  // Get session to check experience and mode
  const session = await getConciergeSessionByToken(sessionId);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // Verify shop matches
  if (session.shop.domain !== shopDomain) {
    return Response.json({ error: "Session shop mismatch" }, { status: 403 });
  }

  // Add message using helper
  try {
    await addConciergeMessage({
      sessionToken: sessionId,
      role: ConciergeRole.USER,
      text: message,
      imageUrl: null,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Session not found")) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    throw error;
  }

  // Determine next question or completion based on experience flow mode
  // For MVP: Use block's start_mode (passed as flowMode in start) or default to hybrid
  // Quiz mode: 3 steps (step 0, 1, 2), then done
  // Chat mode: After 1-2 messages, done
  // Hybrid: Quiz then chat

  const currentStep = step !== undefined ? Number(step) : 0;
  const totalQuizSteps = 3;

  // For quiz mode: return next question until complete
  if (session.experience?.mode === "modal" || currentStep < totalQuizSteps - 1) {
    // Quiz flow - return next question
    const questions = [
      "What are you looking for?",
      "What's your budget range?",
      "Any specific preferences?",
    ];
    
    if (currentStep < questions.length - 1) {
      return Response.json({
        ok: true,
        nextQuestion: questions[currentStep + 1],
        step: currentStep + 1,
        done: false,
      });
    }
  }

  // For chat/hybrid: after minimum info, return done
  // Count user messages
  const userMessages = session.messages.filter(m => m.role === ConciergeRole.USER);
  const minMessagesForChat = 2;

  if (userMessages.length >= minMessagesForChat || currentStep >= totalQuizSteps - 1) {
    return Response.json({
      ok: true,
      done: true,
    });
  }

  // Default: ask for more info
  return Response.json({
    ok: true,
    nextQuestion: "Tell me more about what you're looking for.",
    done: false,
  });
};

