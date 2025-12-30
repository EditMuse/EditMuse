/**
 * Validates environment variables on server startup
 * Logs safe information (no secrets) and throws clear errors if invalid
 */

export function validateEnv() {
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Log environment info (safe - no secrets)
  console.log("[ENV] SHOPIFY_APP_URL:", appUrl || "(not set)");

  if (!appUrl) {
    throw new Error(
      "SHOPIFY_APP_URL is required. Set it in your .env file:\n" +
      "SHOPIFY_APP_URL=https://your-app-url.com"
    );
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(appUrl);
  } catch (error) {
    throw new Error(
      `SHOPIFY_APP_URL is invalid: "${appUrl}"\n` +
      "Expected format: https://your-app-url.com (must include protocol)\n" +
      "Do NOT include quotes around the value in .env"
    );
  }

  const parsedOrigin = parsedUrl.origin;
  const parsedHostname = parsedUrl.hostname;

  console.log("[ENV] Parsed origin:", parsedOrigin);
  console.log("[ENV] Parsed hostname:", parsedHostname);

  // Warn if HOST or HOSTNAME contains protocol
  const host = process.env.HOST;
  const hostname = process.env.HOSTNAME;

  if (host && (host.startsWith("http://") || host.startsWith("https://"))) {
    console.warn(
      "[ENV] WARNING: HOST contains protocol. HOST should be a hostname only (e.g., 0.0.0.0 or 127.0.0.1), not a URL."
    );
  }

  if (hostname && (hostname.startsWith("http://") || hostname.startsWith("https://"))) {
    console.warn(
      "[ENV] WARNING: HOSTNAME contains protocol. HOSTNAME should be a hostname only, not a URL."
    );
  }

  return {
    appUrl,
    parsedOrigin,
    parsedHostname,
  };
}

