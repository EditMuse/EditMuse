/**
 * Route wrapper utilities for error handling and logging
 */

import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getOrCreateRequestId, addRequestIdHeader } from "./request-id.server";
import { withRequestContext, generateRequestId, type RequestContext } from "./request-context.server";
import { logErrorToDatabase } from "./error-logging.server";
import { captureException } from "./sentry.server";
import { logError } from "./logger.server";

/**
 * Wrap a loader function with error handling and logging
 */
export function wrapLoader<T>(
  loader: (args: LoaderFunctionArgs) => Promise<T>,
  routePath?: string
): (args: LoaderFunctionArgs) => Promise<T> {
  return async (args: LoaderFunctionArgs) => {
    const { request } = args;
    const requestId = getOrCreateRequestId(request);
    const startTime = Date.now();
    const url = new URL(request.url);
    const route = routePath || url.pathname;

    const context: RequestContext = {
      requestId,
      route,
      startTime,
    };

    try {
      return await withRequestContext(context, async () => {
        const result = await loader(args);
        return result;
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Extract shop from request if available (e.g., from query params or headers)
      let shop: string | undefined;
      try {
        const shopParam = url.searchParams.get("shop");
        if (shopParam) {
          shop = shopParam;
        }
      } catch (e) {
        // Ignore
      }

      logError("Route error", {
        requestId,
        route,
        shop,
        message: errorMessage,
        durationMs,
      });

      // Log to database
      await logErrorToDatabase(error instanceof Error ? error : new Error(errorMessage), {
        route,
        shop,
        requestId,
      });

      // Send to Sentry
      if (error instanceof Error) {
        captureException(error, {
          route,
          shop,
          requestId,
          durationMs,
        });
      }

      // Re-throw to let React Router handle it
      throw error;
    }
  };
}

/**
 * Wrap an action function with error handling and logging
 */
export function wrapAction<T>(
  action: (args: ActionFunctionArgs) => Promise<T>,
  routePath?: string
): (args: ActionFunctionArgs) => Promise<T> {
  return async (args: ActionFunctionArgs) => {
    const { request } = args;
    const requestId = getOrCreateRequestId(request);
    const startTime = Date.now();
    const url = new URL(request.url);
    const route = routePath || url.pathname;

    const context: RequestContext = {
      requestId,
      route,
      startTime,
    };

    try {
      return await withRequestContext(context, async () => {
        const result = await action(args);
        return result;
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Extract shop from request if available
      let shop: string | undefined;
      try {
        const shopParam = url.searchParams.get("shop");
        if (shopParam) {
          shop = shopParam;
        }
      } catch (e) {
        // Ignore
      }

      logError("Route action error", {
        requestId,
        route,
        shop,
        message: errorMessage,
        durationMs,
      });

      // Log to database
      await logErrorToDatabase(error instanceof Error ? error : new Error(errorMessage), {
        route,
        shop,
        requestId,
      });

      // Send to Sentry
      if (error instanceof Error) {
        captureException(error, {
          route,
          shop,
          requestId,
          durationMs,
        });
      }

      // Re-throw to let React Router handle it
      throw error;
    }
  };
}

