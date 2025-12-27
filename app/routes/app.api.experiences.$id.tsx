import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Not found", { status: 404 });
  }

  const experience = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!experience) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    experience: {
      ...experience,
      includedCollections: JSON.parse(experience.includedCollections),
      excludedTags: JSON.parse(experience.excludedTags),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Not found", { status: 404 });
  }

  const existing = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!existing) {
    throw new Response("Not found", { status: 404 });
  }

  const formData = await request.formData();
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as string;
  const resultCount = parseInt(formData.get("resultCount") as string, 10);
  const tone = formData.get("tone") as string | null;
  const includedCollections = formData.get("includedCollections") as string || "[]";
  const excludedTags = formData.get("excludedTags") as string || "[]";
  const inStockOnly = formData.get("inStockOnly") === "true";

  const experience = await prisma.experience.update({
    where: { id: id! },
    data: {
      name,
      mode,
      resultCount,
      tone: tone || null,
      includedCollections,
      excludedTags,
      inStockOnly,
    },
  });

  return {
    experience: {
      ...experience,
      includedCollections: JSON.parse(experience.includedCollections),
      excludedTags: JSON.parse(experience.excludedTags),
    },
  };
};

