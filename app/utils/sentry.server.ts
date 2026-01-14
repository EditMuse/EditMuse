const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE;

let initialized = false;
let Sentry: any = null;

/**
 * Initialize Sentry for server-side error tracking
 */
export function initSentry(): void {
  if (initialized) {
    return;
  }

  if (!SENTRY_DSN) {
    // Skip initialization if DSN not configured
    return;
  }

  // Dynamic require to avoid build errors if package not installed
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Sentry = require("@sentry/node");
    
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
  } catch (error) {
    // Sentry package not installed, skip initialization
    console.warn("[Sentry] @sentry/node not installed, skipping server initialization");
  }
}

/**
 * Capture an exception
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (!initialized || !Sentry) {
    return;
  }

  if (context) {
    Sentry.withScope((scope: any) => {
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
export function captureMessage(message: string, level: string = "info", context?: Record<string, any>): void {
  if (!initialized || !Sentry) {
    return;
  }

  if (context) {
    Sentry.withScope((scope: any) => {
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
  if (!initialized || !Sentry) {
    return;
  }
  Sentry.setUser(user);
}

/**
 * Add breadcrumb
 */
export function addBreadcrumb(breadcrumb: any): void {
  if (!initialized || !Sentry) {
    return;
  }
  Sentry.addBreadcrumb(breadcrumb);
}

/**
 * Set context
 */
export function setContext(name: string, context: Record<string, any>): void {
  if (!initialized || !Sentry) {
    return;
  }
  Sentry.setContext(name, context);
}
