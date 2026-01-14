/**
 * Request ID utilities
 * Generates and manages request IDs per request
 */

import { generateRequestId } from "./request-context.server";

/**
 * Generate or extract request ID from headers
 */
export function getOrCreateRequestId(request: Request): string {
  // Try to get from header first (for request tracing)
  const headerRequestId = request.headers.get("x-request-id");
  if (headerRequestId) {
    return headerRequestId;
  }

  // Generate new request ID
  return generateRequestId();
}

/**
 * Add request ID to response headers
 */
export function addRequestIdHeader(headers: Headers, requestId: string): void {
  headers.set("x-request-id", requestId);
}

