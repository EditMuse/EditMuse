import crypto from "crypto";

/**
 * Validates App Proxy HMAC signature from Shopify
 * Shopify App Proxy uses HMAC-SHA256 of sorted query parameters (excluding signature)
 */
export function validateAppProxySignature(
  query: URLSearchParams,
  secret: string
): boolean {
  const signature = query.get("signature");
  if (!signature) return false;

  // Remove signature from query params for validation
  const params = new URLSearchParams(query);
  params.delete("signature");

  // Sort parameters by key and create query string
  const sortedEntries = Array.from(params.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const queryString = sortedEntries
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  // Create HMAC-SHA256
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(queryString)
    .digest("hex");

  // Compare hex strings (both should be same length for valid signatures)
  return hmac === signature;
}

/**
 * Gets shop domain from App Proxy request
 */
export function getShopFromAppProxy(query: URLSearchParams): string | null {
  return query.get("shop") || null;
}

