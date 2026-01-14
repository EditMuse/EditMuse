/**
 * App proxy logging utilities
 */

import { getOrCreateRequestId } from "./request-id.server";
import { logProxyRequest } from "./error-logging.server";
import { logInfo, logError } from "./logger.server";

/**
 * Wrap an app proxy handler with logging
 */
export async function withProxyLogging<T>(
  handler: () => Promise<Response>,
  request: Request,
  routePath: string,
  shopDomain?: string
): Promise<Response> {
  const requestId = getOrCreateRequestId(request);
  const startTime = Date.now();

  try {
    const response = await handler();
    const durationMs = Date.now() - startTime;
    const status = response.status;

    // Log to database (fire and forget)
    logProxyRequest(requestId, routePath, status, durationMs, shopDomain).catch((e) => {
      console.error("[Proxy Logging] Failed to log proxy request:", e);
    });

    // Add request ID to response headers
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);

    logInfo("App proxy request", {
      requestId,
      route: routePath,
      shop: shopDomain,
      status,
      durationMs,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logError("App proxy error", {
      requestId,
      route: routePath,
      shop: shopDomain,
      message: errorMessage,
      durationMs,
    });

    // Log error to database
    await logProxyRequest(requestId, routePath, 500, durationMs, shopDomain).catch((e) => {
      console.error("[Proxy Logging] Failed to log proxy error:", e);
    });

    throw error;
  }
}

