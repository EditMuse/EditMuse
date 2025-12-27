import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
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

  try {
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

    return redirect(`/app/experiences/${experience.id}`);
  } catch (error) {
    return { error: "Failed to create experience" };
  }
};

export default function NewExperience() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Create Experience">
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
              placeholder="My Experience"
            />

            <s-select
              label="Mode"
              name="mode"
              required
            >
              <option value="modal">Modal</option>
              <option value="embedded">Embedded</option>
              <option value="drawer">Drawer</option>
            </s-select>

            <s-select
              label="Result Count"
              name="resultCount"
              required
            >
              <option value="8">8</option>
              <option value="12">12</option>
              <option value="16">16</option>
            </s-select>

            <s-text-field
              label="Tone"
              name="tone"
              placeholder="Professional, Friendly, etc."
              helpText="Optional: Describe the tone for recommendations"
            />

            <s-text-field
              label="Included Collections"
              name="includedCollections"
              placeholder='["collection-id-1", "collection-id-2"]'
              helpText="JSON array of collection IDs (leave empty for all collections)"
            />

            <s-text-field
              label="Excluded Tags"
              name="excludedTags"
              placeholder='["tag1", "tag2"]'
              helpText="JSON array of tags to exclude"
            />

            <s-checkbox
              name="inStockOnly"
              value="true"
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
              Create Experience
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

