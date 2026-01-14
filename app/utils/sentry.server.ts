import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE;

let initialized = false;

/**
 * Initialize Sentry for server-side error tracking
 */
export function initSentry(): void {
  if (initialized) {
    return;
  }

  if (!SENTRY_DSN) {
    console.warn("[Sentry] SENTRY_DSN not configured, skipping initialization");
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    tracesSampleRate: SENTRY_ENVIRONMENT === "production" ? 0.1 : 1.0,
  });

  initialized = true;
  console.log("[Sentry] Initialized server-side error tracking", {
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
  });
}

/**
 * Capture an exception
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (!initialized) {
    return;
  }

  if (context) {
    Sentry.withScope((scope: Sentry.Scope) => {
      Object.entries(context).forEach(([key, value]) => {
        scope.setContext(key, value);
      });
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

/**
 * Capture a message
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = "info", context?: Record<string, any>): void {
  if (!initialized) {
    return;
  }

  if (context) {
    Sentry.withScope((scope: Sentry.Scope) => {
      Object.entries(context).forEach(([key, value]) => {
        scope.setContext(key, value);
      });
      Sentry.captureMessage(message, level);
    });
  } else {
    Sentry.captureMessage(message, level);
  }
}

/**
 * Set user context
 */
export function setUser(user: { id?: string; username?: string; email?: string; ip_address?: string }): void {
  if (!initialized) {
    return;
  }
  Sentry.setUser(user);
}

/**
 * Add breadcrumb
 */
export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  if (!initialized) {
    return;
  }
  Sentry.addBreadcrumb(breadcrumb);
}

/**
 * Set context
 */
export function setContext(name: string, context: Record<string, any>): void {
  if (!initialized) {
    return;
  }
  Sentry.setContext(name, context);
}

