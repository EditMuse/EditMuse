import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";

/**
 * App Proxy endpoint to return active experiments as JSON
 * Accessible at /apps/editmuse/experiments
 * Used by storefront extension to fetch active experiments for assignment
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams;
  const secret = process.env.SHOPIFY_API_SECRET || "";

  // Validate HMAC signature if present (for App Proxy requests)
  const hasSignature = query.has("signature");

  let shopDomain: string | null = null;

  if (hasSignature) {
    const isValid = validateAppProxySignature(query, secret);
    if (!isValid) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    shopDomain = getShopFromAppProxy(query);
  } else {
    // For storefront requests, try to get shop from query params
    shopDomain = query.get("shop");
  }

  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Fetch shop
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // Fetch active experiments
  const experiments = await prisma.experiment.findMany({
    where: {
      shopId: shop.id,
      isActive: true,
    },
    select: {
      key: true,
      variants: true,
    },
  });

  // Return experiments as JSON
  return Response.json({ experiments });
};

