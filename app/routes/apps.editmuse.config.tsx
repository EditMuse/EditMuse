import type { LoaderFunctionArgs } from "react-router";
import { validateAppProxySignature, getShopFromAppProxy } from "~/app-proxy.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams;

  // Validate HMAC signature
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!validateAppProxySignature(query, secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Get shop domain
  const shopDomain = getShopFromAppProxy(query);
  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Get experience ID
  const experienceId = query.get("experienceId");
  if (!experienceId) {
    return Response.json({ error: "Missing experienceId parameter" }, { status: 400 });
  }

  // Find shop
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // Find experience
  const experience = await prisma.experience.findFirst({
    where: {
      id: experienceId,
      shopId: shop.id,
    },
  });

  if (!experience) {
    return Response.json({ error: "Experience not found" }, { status: 404 });
  }

  return Response.json({
    experience: {
      id: experience.id,
      name: experience.name,
      mode: experience.mode,
      resultCount: experience.resultCount,
      tone: experience.tone,
      includedCollections: JSON.parse(experience.includedCollections),
      excludedTags: JSON.parse(experience.excludedTags),
      inStockOnly: experience.inStockOnly,
    },
  });
};

