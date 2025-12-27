import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { experiences: true },
  });

  if (!shop) {
    return { experiences: [] };
  }

  return {
    experiences: shop.experiences.map((exp: any) => ({
      ...exp,
      includedCollections: JSON.parse(exp.includedCollections),
      excludedTags: JSON.parse(exp.excludedTags),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  let shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        domain: session.shop,
        accessToken: session.accessToken,
      },
    });
  }

  const formData = await request.formData();
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as string;
  const resultCount = parseInt(formData.get("resultCount") as string, 10);
  const tone = formData.get("tone") as string | null;
  const includedCollections = formData.get("includedCollections") as string || "[]";
  const excludedTags = formData.get("excludedTags") as string || "[]";
  const inStockOnly = formData.get("inStockOnly") === "true";

  const experience = await prisma.experience.create({
    data: {
      shopId: shop.id,
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

