import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, redirect, useNavigation } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { withQuery } from "~/utils/redirect.server";

type LoaderData = {
  shopDomain: string;
  settings: {
    buttonLabel: string | null;
    placementMode: string | null;
    defaultResultsCount: number | null;
    widgetMode: string | null;
    widgetTheme: string | null;
    storefrontTestUrl: string | null;
  };
};

type StatusData = {
  connectivity: "ok" | "fail";
  extension: "ok" | "fail";
  extensionError?: string;
  lastChecked?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Backward compatibility: use widgetMode/widgetTheme, fall back to onboardingMode/onboardingTheme if new fields are null
  const widgetMode = (shop as any).widgetMode ?? (shop as any).onboardingMode ?? null;
  const widgetTheme = (shop as any).widgetTheme ?? (shop as any).onboardingTheme ?? null;

  return {
    shopDomain: shop.domain,
    settings: {
      buttonLabel: shop.buttonLabel,
      placementMode: shop.placementMode,
      defaultResultsCount: shop.defaultResultsCount,
      widgetMode: widgetMode,
      widgetTheme: widgetTheme,
      storefrontTestUrl: shop.storefrontTestUrl,
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
  const widgetTheme = formData.get("widgetTheme")?.toString() || null;
  const storefrontTestUrl = formData.get("storefrontTestUrl")?.toString() || null;
  const blockIdentifiers = formData.get("blockIdentifiers")?.toString() || "[]";

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

  // Validate widgetTheme
  if (widgetTheme && !["light", "dark"].includes(widgetTheme)) {
    return Response.json({ error: "Invalid widgetTheme" }, { status: 400 });
  }

  // Update shop settings
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      buttonLabel,
      placementMode,
      defaultResultsCount: resultsCount,
      widgetMode,
      widgetTheme,
      storefrontTestUrl,
      installedBlockIdentifiers: blockIdentifiers,
    },
  });

  return redirect(withQuery(request, "/app/dashboard"));
};

export default function OnboardingPage() {
  const { shopDomain, settings } = useLoaderData<LoaderData>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [currentStep, setCurrentStep] = useState(1);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  const isSubmitting = navigation.state === "submitting";

  // Check status function
  const checkStatus = async () => {
    setIsCheckingStatus(true);
    try {
      const response = await fetch("/app/api/onboarding/status");
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch (error) {
      console.error("[Onboarding] Status check failed:", error);
    } finally {
      setIsCheckingStatus(false);
    }
  };

  // Poll status endpoint periodically (only when on Step 2 and not both OK)
  useEffect(() => {
    if (currentStep !== 2) {
      return;
    }

    // Stop polling if both connectivity and extension are OK
    if (status?.connectivity === "ok" && status?.extension === "ok") {
      return;
    }

    // Check immediately
    checkStatus();

    // Poll every 3 seconds
    const interval = setInterval(checkStatus, 3000);

    return () => clearInterval(interval);
  }, [currentStep, status?.connectivity, status?.extension]);

  const themeEditorUrl = `https://${shopDomain}/admin/themes/current/editor`;

  return (
    <s-page heading="Get Started">
      <s-section>
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          {/* Stepper */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "2rem",
              position: "relative",
            }}
          >
            {[1, 2, 3].map((step) => (
              <div key={step} style={{ flex: 1, position: "relative", zIndex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      backgroundColor:
                        step === currentStep
                          ? "#7C3AED"
                          : step < currentStep
                          ? "#10B981"
                          : "#E5E7EB",
                      color: step <= currentStep ? "#FFFFFF" : "#9CA3AF",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: "bold",
                      fontSize: "1rem",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {step < currentStep ? "✓" : step}
                  </div>
                  <div
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: step === currentStep ? "600" : "400",
                      color: step === currentStep ? "#7C3AED" : "#6B7280",
                      textAlign: "center",
                    }}
                  >
                    {step === 1
                      ? "Placement"
                      : step === 2
                      ? "Connectivity"
                      : "Branding"}
                  </div>
                </div>
                {step < 3 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "20px",
                      left: "50%",
                      width: "100%",
                      height: "2px",
                      backgroundColor: step < currentStep ? "#10B981" : "#E5E7EB",
                      zIndex: 0,
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Step Content */}
          <Form method="post">
            {/* Step 1: Placement */}
            {currentStep === 1 && (
              <div>
                <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Placement</h2>
                <p style={{ color: "rgba(11,11,15,0.62)", marginBottom: "1.5rem" }}>
                  Configure where and how the concierge widget appears on your storefront.
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
                    Button Label
                  </label>
                  <input
                    type="text"
                    name="buttonLabel"
                    defaultValue={settings.buttonLabel || "Get Started"}
                    placeholder="Get Started"
                    style={{
                      width: "100%",
                      padding: "0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontSize: "1rem",
                    }}
                  />
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
                    defaultValue={String(settings.defaultResultsCount || 8)}
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
                </div>

                <div style={{ display: "flex", gap: "1rem", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setCurrentStep(2)}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: "#7C3AED",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: "pointer",
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Connectivity */}
            {currentStep === 2 && (
              <div>
                <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Connectivity</h2>
                <p style={{ color: "rgba(11,11,15,0.62)", marginBottom: "1.5rem" }}>
                  Verify that your storefront can communicate with the EditMuse service.
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
                    Storefront page URL to test
                  </label>
                  <input
                    type="text"
                    name="storefrontTestUrl"
                    defaultValue={settings.storefrontTestUrl || ""}
                    placeholder={`https://${shopDomain}/products/example-product`}
                    style={{
                      width: "100%",
                      padding: "0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontSize: "1rem",
                    }}
                  />
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginTop: "0.5rem" }}>
                    Paste a live storefront URL where the EditMuse block should appear (e.g. a product page).
                  </div>
                </div>

                <div
                  style={{
                    padding: "1.5rem",
                    backgroundColor: "#F9FAFB",
                    borderRadius: "12px",
                    marginBottom: "1.5rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "1rem",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: "500", color: "#0B0B0F", marginBottom: "0.25rem" }}>
                        Connectivity
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                        Connection to /apps/editmuse/ping
                      </div>
                    </div>
                    <div>
                      {isCheckingStatus ? (
                        <span style={{ color: "#6B7280" }}>Checking...</span>
                      ) : status?.connectivity === "ok" ? (
                        <span
                          style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "12px",
                            backgroundColor: "#D1FAE5",
                            color: "#065F46",
                            fontWeight: "600",
                            fontSize: "0.875rem",
                          }}
                        >
                          OK
                        </span>
                      ) : (
                        <span
                          style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "12px",
                            backgroundColor: "#FEE2E2",
                            color: "#991B1B",
                            fontWeight: "600",
                            fontSize: "0.875rem",
                          }}
                        >
                          FAIL
                        </span>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: status?.lastChecked || status?.extensionError ? "1rem" : "0",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: "500", color: "#0B0B0F", marginBottom: "0.25rem" }}>
                        Extension installed
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                        Theme extension blocks installed
                      </div>
                    </div>
                    <div>
                      {isCheckingStatus ? (
                        <span style={{ color: "#6B7280" }}>Checking...</span>
                      ) : status?.extension === "ok" ? (
                        <span
                          style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "12px",
                            backgroundColor: "#D1FAE5",
                            color: "#065F46",
                            fontWeight: "600",
                            fontSize: "0.875rem",
                          }}
                        >
                          OK
                        </span>
                      ) : (
                        <span
                          style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "12px",
                            backgroundColor: "#FEE2E2",
                            color: "#991B1B",
                            fontWeight: "600",
                            fontSize: "0.875rem",
                          }}
                        >
                          FAIL
                        </span>
                      )}
                    </div>
                  </div>

                  {status?.lastChecked && (
                    <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginTop: "1rem" }}>
                      Last checked: {new Date(status.lastChecked).toLocaleString()}
                    </div>
                  )}

                  {status?.extensionError && (
                    <div
                      style={{
                        marginTop: "1rem",
                        padding: "0.75rem",
                        backgroundColor: "#FEF2F2",
                        border: "1px solid #FECACA",
                        borderRadius: "8px",
                      }}
                    >
                      <div style={{ fontSize: "0.75rem", fontFamily: "monospace", color: "#991B1B" }}>
                        {status.extensionError}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
                  <button
                    type="button"
                    onClick={checkStatus}
                    disabled={isCheckingStatus}
                    style={{
                      padding: "0.625rem 1.25rem",
                      background: isCheckingStatus ? "#9CA3AF" : "#FFFFFF",
                      color: isCheckingStatus ? "#FFFFFF" : "#0B0B0F",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: isCheckingStatus ? "not-allowed" : "pointer",
                      fontSize: "0.875rem",
                    }}
                  >
                    {isCheckingStatus ? "Checking..." : "Check again"}
                  </button>
                </div>

                {status?.extension === "fail" && (
                  <div
                    style={{
                      padding: "1rem",
                      backgroundColor: "#FEF3C7",
                      border: "1px solid #FCD34D",
                      borderRadius: "8px",
                      marginBottom: "1.5rem",
                    }}
                  >
                    <div style={{ fontWeight: "500", color: "#92400E", marginBottom: "0.5rem" }}>
                      Extension not installed
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#78350F", marginBottom: "1rem" }}>
                      Add the EditMuse blocks to your theme in the Theme Editor.
                    </div>
                    <a
                      href={themeEditorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "inline-block",
                        padding: "0.625rem 1.25rem",
                        background: "#7C3AED",
                        color: "#FFFFFF",
                        textDecoration: "none",
                        borderRadius: "8px",
                        fontWeight: "500",
                      }}
                    >
                      Open Theme Editor
                    </a>
                  </div>
                )}

                <div style={{ display: "flex", gap: "1rem", justifyContent: "space-between" }}>
                  <button
                    type="button"
                    onClick={() => setCurrentStep(1)}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: "transparent",
                      color: "#0B0B0F",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: "pointer",
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentStep(3)}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: "#7C3AED",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: "pointer",
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Branding */}
            {currentStep === 3 && (
              <div>
                <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Branding</h2>
                <p style={{ color: "rgba(11,11,15,0.62)", marginBottom: "1.5rem" }}>
                  Customize the appearance and behavior of the concierge widget.
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
                    Mode
                  </label>
                  <select
                    name="widgetMode"
                    defaultValue={settings.widgetMode || "quick"}
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
                    Theme
                  </label>
                  <select
                    name="widgetTheme"
                    defaultValue={settings.widgetTheme || "light"}
                    style={{
                      width: "100%",
                      padding: "0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontSize: "1rem",
                    }}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>

                {/* Hidden field for block identifiers - will be set when merchant saves in theme editor */}
                <input
                  type="hidden"
                  name="blockIdentifiers"
                  value={JSON.stringify(["editmuse_concierge", "editmuse_results"])}
                />

                <div style={{ display: "flex", gap: "1rem", justifyContent: "space-between" }}>
                  <button
                    type="button"
                    onClick={() => setCurrentStep(2)}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: "transparent",
                      color: "#0B0B0F",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: "pointer",
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: isSubmitting ? "#9CA3AF" : "#7C3AED",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: "500",
                      cursor: isSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {isSubmitting ? "Saving..." : "Complete Setup"}
                  </button>
                </div>
              </div>
            )}
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}
