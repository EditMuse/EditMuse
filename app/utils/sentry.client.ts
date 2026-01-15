/**
 * Sentry client-side initialization
 * This file should be imported in entry.client.tsx or root.tsx
 */

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE;
const SENTRY_TRACES_SAMPLE_RATE = process.env.SENTRY_TRACES_SAMPLE_RATE
  ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
  : SENTRY_ENVIRONMENT === "production" ? 0.1 : 1.0;

let initialized = false;

/**
 * Redact PII keys from event payload
 */
function redactPII(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPII(item));
  }

  if (typeof value === "object") {
    const redacted: any = {};
    for (const [key, val] of Object.entries(value)) {
      const keyLower = key.toLowerCase();
      
      // PII keys to redact (case-insensitive)
      const piiKeys = ["email", "phone", "address", "customer", "first_name", "last_name", "name"];
      if (piiKeys.includes(keyLower)) {
        redacted[key] = "[REDACTED]";
      } else if (keyLower === "note_attributes" || keyLower === "properties") {
        // Special handling: keep structure but redact all values
        if (Array.isArray(val)) {
          redacted[key] = val.map((item: any) => {
            if (typeof item === "object" && item !== null) {
              const redactedItem: any = {};
              for (const [itemKey, itemVal] of Object.entries(item)) {
                redactedItem[itemKey] = "[REDACTED]";
              }
              return redactedItem;
            }
            return "[REDACTED]";
          });
        } else if (typeof val === "object" && val !== null) {
          const redactedObj: any = {};
          for (const [itemKey] of Object.entries(val)) {
            redactedObj[itemKey] = "[REDACTED]";
          }
          redacted[key] = redactedObj;
        } else {
          redacted[key] = "[REDACTED]";
        }
      } else if (keyLower === "line_items" && Array.isArray(val)) {
        // Handle line_items array: redact properties within each item
        redacted[key] = val.map((item: any) => {
          if (typeof item === "object" && item !== null) {
            const redactedItem: any = {};
            for (const [itemKey, itemVal] of Object.entries(item)) {
              if (itemKey.toLowerCase() === "properties") {
                // Redact properties structure
                if (Array.isArray(itemVal)) {
                  redactedItem[itemKey] = itemVal.map((prop: any) => {
                    if (typeof prop === "object" && prop !== null) {
                      const redactedProp: any = {};
                      for (const [propKey] of Object.entries(prop)) {
                        redactedProp[propKey] = "[REDACTED]";
                      }
                      return redactedProp;
                    }
                    return "[REDACTED]";
                  });
                } else {
                  redactedItem[itemKey] = "[REDACTED]";
                }
              } else {
                redactedItem[itemKey] = redactPII(itemVal);
              }
            }
            return redactedItem;
          }
          return redactPII(item);
        });
      } else {
        redacted[key] = redactPII(val);
      }
    }
    return redacted;
  }

  return value;
}

/**
 * Initialize Sentry for client-side error tracking
 */
export function initSentry(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }

  if (!SENTRY_DSN || SENTRY_DSN.trim() === "") {
    // Disable Sentry if DSN is empty/undefined
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
      tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
      beforeSend(event: any, hint: any) {
        // Redact PII from event
        if (event) {
          if (event.request) {
            event.request = redactPII(event.request) as any;
          }
          if (event.contexts) {
            event.contexts = redactPII(event.contexts) as any;
          }
          if (event.extra) {
            event.extra = redactPII(event.extra) as any;
          }
          if (event.tags) {
            event.tags = redactPII(event.tags) as any;
          }
          if (event.user) {
            event.user = redactPII(event.user) as any;
          }
          if (event.exception) {
            event.exception = redactPII(event.exception) as any;
          }
          if (event.logentry) {
            event.logentry = redactPII(event.logentry) as any;
          }
          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((crumb: any) => {
              if (crumb.data) {
                crumb.data = redactPII(crumb.data);
              }
              return crumb;
            });
          }
        }
        return event;
      },
    });

    initialized = true;
    console.log("[Sentry] Initialized client-side error tracking", {
      environment: SENTRY_ENVIRONMENT,
      release: SENTRY_RELEASE,
      tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    });
  } catch (error) {
    // Sentry package not installed, skip initialization
    console.warn("[Sentry] @sentry/react not installed, skipping client initialization");
  }
}
