/**
 * Structured logging utility
 * All logs include: requestId, shop, route, sessionId (if available), status, durationMs
 */

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogMeta {
  requestId?: string;
  shop?: string;
  route?: string;
  sessionId?: string;
  status?: number;
  durationMs?: number;
  [key: string]: any;
}

function formatLogMessage(level: LogLevel, message: string, meta: LogMeta = {}): string {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta)
    .filter((key) => meta[key] !== undefined && meta[key] !== null)
    .map((key) => `${key}=${JSON.stringify(meta[key])}`)
    .join(" ");

  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr ? " " + metaStr : ""}`;
}

export function log(level: LogLevel, message: string, meta: LogMeta = {}): void {
  const logMessage = formatLogMessage(level, message, meta);

  switch (level) {
    case "error":
      console.error(logMessage);
      break;
    case "warn":
      console.warn(logMessage);
      break;
    case "debug":
      if (process.env.NODE_ENV === "development") {
        console.debug(logMessage);
      }
      break;
    case "info":
    default:
      console.log(logMessage);
      break;
  }
}

// Convenience functions
export function logInfo(message: string, meta: LogMeta = {}): void {
  log("info", message, meta);
}

export function logWarn(message: string, meta: LogMeta = {}): void {
  log("warn", message, meta);
}

export function logError(message: string, meta: LogMeta = {}): void {
  log("error", message, meta);
}

export function logDebug(message: string, meta: LogMeta = {}): void {
  log("debug", message, meta);
}

