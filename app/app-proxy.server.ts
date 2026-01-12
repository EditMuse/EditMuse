import crypto from "crypto";

/**
 * Validates App Proxy HMAC signature from Shopify
 * 
 * Shopify App Proxy signature verification (exact spec):
 * 1. Read signature from query
 * 2. Remove it from params
 * 3. For each key, join ALL values with comma: key=value1,value2
 * 4. Sort these strings lexicographically
 * 5. Join with no separators (empty string)
 * 6. Compute HMAC SHA256 hex digest
 * 7. Compare using timing-safe equality
 */
export function validateAppProxySignature(
  query: URLSearchParams,
  secret: string
): boolean {
  const signature = query.get("signature");
  
  // Safe debug logs (no secrets)
  const hasSignature = !!signature;
  const secretLength = secret ? secret.length : 0;
  const paramKeys = Array.from(query.keys()).filter(k => k !== "signature");
  
  console.log("[App Proxy] Signature validation:", {
    hasSignature,
    secretLength,
    paramKeys: paramKeys.join(", ")
  });

  if (!signature) {
    console.log("[App Proxy] No signature found in query");
    return false;
  }

  if (!secret || secretLength === 0) {
    console.error("[App Proxy] Secret is missing or empty");
    return false;
  }

  // Remove signature from query params for validation
  const params = new URLSearchParams(query);
  params.delete("signature");

  // Build sorted_params: for each key, map to "key=value1,value2,..."
  // Then sort lexicographically and join with no separators
  const paramStrings: string[] = [];
  const seenKeys = new Set<string>();
  
  for (const [key, value] of params.entries()) {
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      // Get all values for this key
      const allValues = params.getAll(key);
      const valueString = allValues.join(",");
      paramStrings.push(`${key}=${valueString}`);
    }
  }

  // Sort lexicographically
  paramStrings.sort();

  // Join with no separators (empty string)
  const queryString = paramStrings.join("");

  // Create HMAC-SHA256 hex digest
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(queryString)
    .digest("hex");

  // Timing-safe comparison
  const isValid = crypto.timingSafeEqual(
    Buffer.from(hmac, "hex"),
    Buffer.from(signature, "hex")
  );

  console.log("[App Proxy] Signature validation result:", isValid ? "PASSED" : "FAILED");
  
  return isValid;
}

/**
 * Gets shop domain from App Proxy request
 */
export function getShopFromAppProxy(query: URLSearchParams): string | null {
  return query.get("shop") || null;
}

