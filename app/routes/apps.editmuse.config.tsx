import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";
import { createHash } from "crypto";

/**
 * App Proxy endpoint to return shop settings as JSON
 * Accessible at /apps/editmuse/config
 * Used by storefront extension to fetch settings
 * 
 * Public fields (always returned): buttonLabel, placementMode, defaultResultsCount, mode, enabled
 * Internal fields (only returned with valid signature): none currently
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams;
  const secret = process.env.SHOPIFY_API_SECRET || "";

  // Validate HMAC signature if present (for App Proxy requests)
  const hasSignature = query.has("signature");
  let isValidSignature = false;

  let shopDomain: string | null = null;

  if (hasSignature) {
    isValidSignature = validateAppProxySignature(query, secret);
    if (isValidSignature) {
      shopDomain = getShopFromAppProxy(query);
    }
  }
  
  // If no valid signature, try to get shop from query params (public access)
  if (!shopDomain) {
    shopDomain = query.get("shop");
  }

  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Fetch shop settings (include updatedAt for ETag)
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: {
      buttonLabel: true,
      placementMode: true,
      defaultResultsCount: true,
      widgetMode: true,
      updatedAt: true,
    },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // Build public config (always returned, even without signature)
  const publicConfig = {
    buttonLabel: shop.buttonLabel || "Ask EditMuse",
    placementMode: shop.placementMode || "inline",
    defaultResultsCount: shop.defaultResultsCount || 8,
    mode: shop.widgetMode || "guided",
    enabled: shop.placementMode !== null, // Widget is enabled if placementMode is configured
  };

  // Generate ETag from updatedAt timestamp
  const etagValue = `"${createHash("md5").update(String(shop.updatedAt.getTime())).digest("hex")}"`;
  
  // Check If-None-Match header for conditional request
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === etagValue) {
    return new Response(null, {
      status: 304,
      headers: {
        "Cache-Control": "private, max-age=60",
        "ETag": etagValue,
      },
    });
  }

  // Return settings as JSON with caching headers
  return Response.json(publicConfig, {
    headers: {
      "Cache-Control": "private, max-age=60",
      "ETag": etagValue,
    },
  });
};
