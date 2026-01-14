/**
 * Error logging utility - persists errors to database
 */

import prisma from "~/db.server";
import { getRequestContext } from "./request-context.server";

interface ErrorContext {
  route?: string;
  shop?: string;
  sessionId?: string;
  requestId?: string;
  [key: string]: any;
}

/**
 * Log an error to the database
 */
export async function logErrorToDatabase(
  error: Error | string,
  context: ErrorContext = {}
): Promise<void> {
  try {
    const requestContext = getRequestContext();
    const requestId = context.requestId || requestContext?.requestId || "unknown";
    const route = context.route || requestContext?.route;
    const shopDomain = context.shop || requestContext?.shop;

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    // Build context JSON (exclude fields that are already columns)
    const contextJson: Record<string, any> = {};
    Object.entries(context).forEach(([key, value]) => {
      if (!["route", "shop", "sessionId", "requestId"].includes(key)) {
        contextJson[key] = value;
      }
    });

    // Find shop if shopDomain is provided
    let shopId: string | null = null;
    if (shopDomain) {
      try {
        const shop = await prisma.shop.findUnique({
          where: { domain: shopDomain },
          select: { id: true },
        });
        if (shop) {
          shopId = shop.id;
        }
      } catch (e) {
        // Ignore shop lookup errors
      }
    }

    await prisma.appError.create({
      data: {
        shopId: shopId,
        requestId: requestId,
        route: route || null,
        message: message,
        stack: stack || null,
        contextJson: Object.keys(contextJson).length > 0 ? JSON.stringify(contextJson) : null,
      },
    });
  } catch (loggingError) {
    // Don't let error logging break the app
    console.error("[Error Logging] Failed to log error to database:", loggingError);
  }
}

/**
 * Log an app proxy request to the database
 */
export async function logProxyRequest(
  requestId: string,
  route: string,
  status: number,
  durationMs: number,
  shopDomain?: string
): Promise<void> {
  try {
    let shopId: string | null = null;
    if (shopDomain) {
      try {
        const shop = await prisma.shop.findUnique({
          where: { domain: shopDomain },
          select: { id: true },
        });
        if (shop) {
          shopId = shop.id;
        }
      } catch (e) {
        // Ignore shop lookup errors
      }
    }

    await prisma.appProxyLog.create({
      data: {
        shopId: shopId,
        requestId: requestId,
        route: route,
        status: status,
        durationMs: durationMs,
      },
    });
  } catch (loggingError) {
    // Don't let proxy logging break the app
    console.error("[Proxy Logging] Failed to log proxy request to database:", loggingError);
  }
}

