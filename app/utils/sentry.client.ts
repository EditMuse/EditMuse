/**
 * Sentry client-side initialization
 * This file should be imported in entry.client.tsx or root.tsx
 */

import * as Sentry from "@sentry/react";

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE;

let initialized = false;

/**
 * Initialize Sentry for client-side error tracking
 */
export function initSentry(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }

  if (!SENTRY_DSN) {
    console.warn("[Sentry] SENTRY_DSN not configured, skipping client initialization");
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    integrations: [
      Sentry.browserTracingIntegration(),
    ],
    tracesSampleRate: SENTRY_ENVIRONMENT === "production" ? 0.1 : 1.0,
  });

  initialized = true;
  console.log("[Sentry] Initialized client-side error tracking", {
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
  });
}

