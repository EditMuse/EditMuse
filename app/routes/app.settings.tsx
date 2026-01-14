import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

type LoaderData = {
  shopDomain: string;
  settings: {
    buttonLabel: string | null;
    placementMode: string | null;
    defaultResultsCount: number | null;
    widgetMode: string | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Backward compatibility: use widgetMode, fall back to onboardingMode if widgetMode is null
  const widgetMode = (shop as any).widgetMode ?? (shop as any).onboardingMode ?? null;

  return {
    shopDomain: shop.domain,
    settings: {
      buttonLabel: shop.buttonLabel,
      placementMode: shop.placementMode,
      defaultResultsCount: shop.defaultResultsCount,
      widgetMode: widgetMode,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const buttonLabel = formData.get("buttonLabel")?.toString() || null;
  const placementMode = formData.get("placementMode")?.toString() || null;
  const defaultResultsCount = formData.get("defaultResultsCount")?.toString();
  const widgetMode = formData.get("widgetMode")?.toString() || null;

  // Validate placementMode
  if (placementMode && !["inline", "sticky", "both"].includes(placementMode)) {
    return Response.json({ error: "Invalid placementMode" }, { status: 400 });
  }

  // Validate defaultResultsCount
  const resultsCount = defaultResultsCount ? parseInt(defaultResultsCount, 10) : null;
  if (resultsCount && ![8, 12, 16].includes(resultsCount)) {
    return Response.json({ error: "Invalid defaultResultsCount" }, { status: 400 });
  }

  // Validate widgetMode
  if (widgetMode && !["quick", "guided"].includes(widgetMode)) {
    return Response.json({ error: "Invalid widgetMode" }, { status: 400 });
  }

  // Update shop settings
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      buttonLabel,
      placementMode,
      defaultResultsCount: resultsCount,
      widgetMode,
    },
  });

  return Response.json({ success: true });
};

export default function SettingsPage() {
  const { shopDomain, settings } = useLoaderData<LoaderData>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      <s-section>
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          {actionData?.error && (
            <div
              style={{
                padding: "1rem",
                marginBottom: "1.5rem",
                backgroundColor: "#FEF2F2",
                border: "1px solid #FCA5A5",
                borderRadius: "8px",
                color: "#991B1B",
              }}
            >
              {actionData.error}
            </div>
          )}

          {actionData?.success && (
            <div
              style={{
                padding: "1rem",
                marginBottom: "1.5rem",
                backgroundColor: "#F0FDF4",
                border: "1px solid #86EFAC",
                borderRadius: "8px",
                color: "#166534",
              }}
            >
              Settings saved successfully!
            </div>
          )}

          <Form method="post">
            <div style={{ marginBottom: "2rem" }}>
              <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Storefront Widget Settings</h2>
              <p style={{ color: "rgba(11,11,15,0.62)", marginBottom: "2rem" }}>
                Configure how the EditMuse concierge widget appears and behaves on your storefront.
              </p>

              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontWeight: "500",
                    color: "#0B0B0F",
                  }}
                >
                  Button Label
                </label>
                <input
                  type="text"
                  name="buttonLabel"
                  defaultValue={settings.buttonLabel || "Ask EditMuse"}
                  placeholder="Ask EditMuse"
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "8px",
                    fontSize: "1rem",
                  }}
                />
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  The text displayed on the concierge button.
                </p>
              </div>

              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontWeight: "500",
                    color: "#0B0B0F",
                  }}
                >
                  Placement Mode
                </label>
                <select
                  name="placementMode"
                  defaultValue={settings.placementMode || "inline"}
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "8px",
                    fontSize: "1rem",
                  }}
                >
                  <option value="inline">Inline</option>
                  <option value="sticky">Sticky</option>
                  <option value="both">Both</option>
                </select>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  How the widget is positioned on the page. Inline: embedded in content. Sticky: fixed position. Both: both options available.
                </p>
              </div>

              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontWeight: "500",
                    color: "#0B0B0F",
                  }}
                >
                  Default Results Count
                </label>
                <select
                  name="defaultResultsCount"
                  defaultValue={settings.defaultResultsCount?.toString() || "8"}
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "8px",
                    fontSize: "1rem",
                  }}
                >
                  <option value="8">8 products</option>
                  <option value="12">12 products</option>
                  <option value="16">16 products</option>
                </select>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  Default number of product recommendations to display.
                </p>
              </div>

              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontWeight: "500",
                    color: "#0B0B0F",
                  }}
                >
                  Mode
                </label>
                <select
                  name="widgetMode"
                  defaultValue={settings.widgetMode || "guided"}
                  style={{
                    width: "100%",
                    padding: "0.75rem",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "8px",
                    fontSize: "1rem",
                  }}
                >
                  <option value="quick">Quick</option>
                  <option value="guided">Guided</option>
                </select>
                <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  Interaction mode: Quick for faster interactions, Guided for step-by-step experience.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: "1rem", justifyContent: "flex-end" }}>
              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  padding: "0.75rem 1.5rem",
                  background: isSubmitting
                    ? "rgba(11,11,15,0.2)"
                    : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                  color: "white",
                  border: "none",
                  borderRadius: "12px",
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  boxShadow: isSubmitting ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
                  transition: "all 0.2s ease",
                  opacity: isSubmitting ? 0.7 : 1,
                }}
              >
                {isSubmitting ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}

