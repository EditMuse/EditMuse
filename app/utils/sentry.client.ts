/**
 * Sentry client-side initialization
 * This file should be imported in entry.client.tsx or root.tsx
 */

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
    // Skip initialization if DSN not configured
    return;
  }

  // Dynamic import to avoid build errors if package not installed
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/react");
    
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
  } catch (error) {
    // Sentry package not installed, skip initialization
    console.warn("[Sentry] @sentry/react not installed, skipping client initialization");
  }
}
