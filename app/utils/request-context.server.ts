/**
 * Request context for tracking requestId, shop, route, etc. across async operations
 * Uses AsyncLocalStorage to maintain context throughout request lifecycle
 */

import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  requestId: string;
  shop?: string;
  route?: string;
  sessionId?: string;
  startTime: number;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Get request ID from context
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Run a function with request context
 */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Generate a request ID (UUID v4 format)
 */
export function generateRequestId(): string {
  // Simple UUID v4-like generator (good enough for request IDs)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

