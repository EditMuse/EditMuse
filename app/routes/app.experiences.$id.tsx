import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useActionData, useNavigation, notFound } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "~/db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw notFound();
  }

  const experience = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!experience) {
    throw notFound();
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
    throw notFound();
  }

  const existing = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!existing) {
    throw notFound();
  }

  const formData = await request.formData();
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as string;
  const resultCount = parseInt(formData.get("resultCount") as string, 10);
  const tone = formData.get("tone") as string | null;
  const includedCollections = formData.get("includedCollections") as string || "[]";
  const excludedTags = formData.get("excludedTags") as string || "[]";
  const inStockOnly = formData.get("inStockOnly") === "true";

  try {
    await prisma.experience.update({
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

    return redirect("/app/experiences");
  } catch (error) {
    return { error: "Failed to update experience" };
  }
};

export default function EditExperience() {
  const { experience } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Edit Experience">
      <Form method="post">
        <s-section>
          {actionData?.error && (
            <s-banner status="critical">
              {actionData.error}
            </s-banner>
          )}

          <s-stack direction="block" gap="base">
            <s-text-field
              label="Name"
              name="name"
              required
              defaultValue={experience.name}
            />

            <s-select
              label="Mode"
              name="mode"
              required
              defaultValue={experience.mode}
            >
              <option value="modal">Modal</option>
              <option value="embedded">Embedded</option>
              <option value="drawer">Drawer</option>
            </s-select>

            <s-select
              label="Result Count"
              name="resultCount"
              required
              defaultValue={experience.resultCount}
            >
              <option value="8">8</option>
              <option value="12">12</option>
              <option value="16">16</option>
            </s-select>

            <s-text-field
              label="Tone"
              name="tone"
              defaultValue={experience.tone || ""}
              placeholder="Professional, Friendly, etc."
              helpText="Optional: Describe the tone for recommendations"
            />

            <s-text-field
              label="Included Collections"
              name="includedCollections"
              defaultValue={JSON.stringify(experience.includedCollections)}
              placeholder='["collection-id-1", "collection-id-2"]'
              helpText="JSON array of collection IDs (leave empty for all collections)"
            />

            <s-text-field
              label="Excluded Tags"
              name="excludedTags"
              defaultValue={JSON.stringify(experience.excludedTags)}
              placeholder='["tag1", "tag2"]'
              helpText="JSON array of tags to exclude"
            />

            <s-checkbox
              name="inStockOnly"
              value="true"
              defaultChecked={experience.inStockOnly}
            >
              Only show in-stock items
            </s-checkbox>
          </s-stack>
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              loading={isSubmitting}
            >
              Save Experience
            </s-button>
            <s-button
              type="button"
              variant="tertiary"
              onClick={() => window.history.back()}
            >
              Cancel
            </s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

