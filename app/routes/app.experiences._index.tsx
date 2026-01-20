import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigate, useActionData, useNavigation, redirect } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "~/db.server";
import { useState, useEffect } from "react";
import { getEntitlements } from "~/models/billing.server";
import { withQuery } from "~/utils/redirect.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shopDomain = session.shop;

    // Ensure Shop row exists (upsert)
    const shop = await prisma.shop.upsert({
      where: { domain: shopDomain },
      create: {
        domain: shopDomain,
        accessToken: session.accessToken || "",
      },
      update: {},
      include: { experiences: true },
    });

    // Fetch experiences by shopId
    const experiences = await prisma.experience.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
    });

    // Get entitlements for experience limits
    const entitlements = await getEntitlements(shop.id);
    const experienceCount = experiences.length;

    // Normalize invalid modes to "hybrid"
    const validModes = ["quiz", "chat", "hybrid"];
    
    // Check for duplicate "Default Concierge" experiences
    const defaultConciergeExperiences = experiences.filter(
      (exp: any) => exp.name === "Default Concierge"
    );
    const hasDuplicateDefaultConcierge = defaultConciergeExperiences.length > 1;
    
    return {
      shopDomain,
      experiences: experiences.map((exp: any) => {
        const mode = validModes.includes(exp.mode) ? exp.mode : "hybrid";
        return {
          ...exp,
          mode, // Normalized mode
          includedCollections: JSON.parse(exp.includedCollections || "[]"),
          excludedTags: JSON.parse(exp.excludedTags || "[]"),
          isDefault: (exp as any).isDefault || false,
        };
      }),
      hasDuplicateDefaultConcierge,
      experienceUsed: experienceCount,
      experienceLimit: entitlements.experiencesLimit,
    };
  } catch (error) {
    // If error is a redirect Response (300-399 status or has Location header), rethrow it
    // This allows authentication redirects (e.g., to /auth/session-token) to work normally
    if (error instanceof Response) {
      const status = error.status;
      const hasLocation = error.headers.has("Location");
      if ((status >= 300 && status < 400) || hasLocation) {
        throw error; // Rethrow redirects immediately - don't log as error
      }
    }
    
    console.error("[ExperiencesIndex] Loader error:", error);
    try {
      const { session } = await authenticate.admin(request);
      return {
        shopDomain: session.shop,
        experiences: [],
        error: error instanceof Error ? error.message : "Failed to load experiences",
        experienceUsed: 0,
        experienceLimit: null,
      };
    } catch (authError) {
      // If authenticate.admin throws a redirect, rethrow it
      if (authError instanceof Response) {
        const status = authError.status;
        const hasLocation = authError.headers.has("Location");
        if ((status >= 300 && status < 400) || hasLocation) {
          throw authError;
        }
      }
      throw authError;
    }
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    console.log("[ExperiencesIndex] Action started", { shop: session.shop });
    
    const shop = await prisma.shop.findUnique({
      where: { domain: session.shop },
    });

    if (!shop) {
      console.error("[ExperiencesIndex] Shop not found", { shop: session.shop });
      return { error: "Shop not found" };
    }

    const formData = await request.formData();
    const intent = formData.get("intent") as string;
    const experienceId = formData.get("experienceId") as string;

    console.log("[ExperiencesIndex] Form data received", { intent, experienceId });

    if (intent === "delete") {
      if (!experienceId) {
        console.error("[ExperiencesIndex] Delete: Experience ID required");
        return { error: "Experience ID required" };
      }
      // Verify shop ownership before deleting
      const experience = await prisma.experience.findFirst({
        where: {
          id: experienceId,
          shopId: shop.id,
        },
      });
      
      if (!experience) {
        console.error("[ExperiencesIndex] Delete: Experience not found or access denied", { experienceId, shopId: shop.id });
        return { error: "Experience not found or access denied" };
      }
      
      await prisma.experience.delete({
        where: { id: experienceId },
      });
      console.log("[ExperiencesIndex] Delete: Successfully deleted experience", { experienceId });
      // Redirect to revalidate the list
      return redirect(withQuery(request, "/app/experiences"));
    } else if (intent === "setDefault") {
      if (!experienceId) {
        console.error("[ExperiencesIndex] SetDefault: Experience ID required");
        return { error: "Experience ID required" };
      }
      // Verify shop ownership
      const experience = await prisma.experience.findFirst({
        where: {
          id: experienceId,
          shopId: shop.id,
        },
      });
      
      if (!experience) {
        console.error("[ExperiencesIndex] SetDefault: Experience not found or access denied", { experienceId, shopId: shop.id });
        return { error: "Experience not found or access denied" };
      }
      
      // Use transaction to ensure atomicity
      await prisma.$transaction(async (tx) => {
        // Unset all other defaults for this shop
        await tx.experience.updateMany({
          where: {
            shopId: shop.id,
            isDefault: true,
          },
          data: {
            isDefault: false,
          },
        });
        
        // Set this experience as default
        await tx.experience.update({
          where: { id: experienceId },
          data: { isDefault: true },
        });
      });
      
      console.log("[ExperiencesIndex] SetDefault: Successfully set default experience", { experienceId });
      // Redirect to revalidate the list
      return redirect(withQuery(request, "/app/experiences"));
    } else if (intent === "deleteDefaultConciergeDuplicates") {
      // Fetch all "Default Concierge" experiences for this shop, ordered by createdAt desc
      const defaultConciergeExperiences = await prisma.experience.findMany({
        where: {
          shopId: shop.id,
          name: "Default Concierge",
        },
        orderBy: { createdAt: "desc" },
      });

      if (defaultConciergeExperiences.length <= 1) {
        console.log("[ExperiencesIndex] DeleteDefaultConciergeDuplicates: No duplicates found");
        return { success: "No duplicates found" };
      }

      // Keep the most recent one (first in desc order), delete the rest
      const toKeep = defaultConciergeExperiences[0];
      const toDelete = defaultConciergeExperiences.slice(1).map(exp => exp.id);

      if (toDelete.length > 0) {
        await prisma.experience.deleteMany({
          where: {
            id: { in: toDelete },
            shopId: shop.id,
          },
        });
        console.log("[ExperiencesIndex] DeleteDefaultConciergeDuplicates: Deleted duplicates", { deleted: toDelete.length, kept: toKeep.id });
        // Redirect to revalidate the list
        return redirect(withQuery(request, "/app/experiences"));
      }
      return { success: "No duplicates found" };
    } else {
      console.error("[ExperiencesIndex] Action: Invalid intent", { intent });
      return { error: "Invalid action" };
    }
  } catch (error) {
    // If error is a redirect Response (300-399 status or has Location header), rethrow it
    // This allows authentication redirects (e.g., to /auth/session-token) to work normally
    if (error instanceof Response) {
      const status = error.status;
      const hasLocation = error.headers.has("Location");
      if ((status >= 300 && status < 400) || hasLocation) {
        throw error; // Rethrow redirects immediately - don't log as error
      }
    }
    
    console.error("[ExperiencesIndex] Action error:", error);
    return { error: error instanceof Error ? error.message : "Action failed" };
  }
};

export default function ExperiencesIndex() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const experiences = loaderData?.experiences || [];
  const shopDomain = loaderData?.shopDomain || "unknown";
  const error = loaderData?.error;
  const hasDuplicateDefaultConcierge = loaderData?.hasDuplicateDefaultConcierge || false;
  const experienceUsed = loaderData?.experienceUsed || 0;
  const experienceLimit = loaderData?.experienceLimit;
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Check if creation is blocked
  const isLimitReached = experienceLimit !== null && experienceUsed >= experienceLimit;

  // Auto-dismiss success messages after 3 seconds
  useEffect(() => {
    if (actionData?.success) {
      const timer = setTimeout(() => {
        // Success messages will be cleared on next navigation
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [actionData?.success]);

  return (
    <s-page heading="Experiences">
      <s-button
        slot="primary-action"
        onClick={() => {
          if (!isLimitReached) {
            navigate("new");
          }
        }}
      >
        Create experience
      </s-button>

      <s-section>
        {/* Experience limit status */}
        {experienceLimit !== null && (
          <div style={{
            padding: "1rem",
            backgroundColor: isLimitReached ? "#FEF2F2" : "#F0FDF4",
            border: `1px solid ${isLimitReached ? "#FCA5A5" : "#86EFAC"}`,
            borderRadius: "12px",
            marginBottom: "1rem",
            color: isLimitReached ? "#DC2626" : "#16A34A"
          }}>
            <div style={{ fontWeight: "500", marginBottom: "0.25rem" }}>
              {isLimitReached ? "⚠️ Experience limit reached" : "Experience usage"}
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              {experienceUsed} of {experienceLimit} experiences used
              {isLimitReached && (
                <div style={{ marginTop: "0.5rem" }}>
                  Upgrade plan or add +3 / +10 Experience pack to create more. <a href="/app/billing" style={{ color: "#DC2626", textDecoration: "underline" }}>View plans</a>
                </div>
              )}
            </div>
          </div>
        )}
        {error && (
          <div style={{
            padding: "1rem",
            backgroundColor: "#FEF2F2",
            border: "1px solid #FCA5A5",
            borderRadius: "12px",
            marginBottom: "1rem",
            color: "#DC2626"
          }}>
            {error}
          </div>
        )}

        {actionData?.error && (
          <div style={{
            padding: "1rem",
            backgroundColor: "#FEF2F2",
            border: "1px solid #FCA5A5",
            borderRadius: "12px",
            marginBottom: "1rem",
            color: "#DC2626"
          }}>
            {actionData.error}
          </div>
        )}

        {actionData?.success && (
          <div style={{
            padding: "1rem",
            backgroundColor: "#F0FDF4",
            border: "1px solid #86EFAC",
            borderRadius: "12px",
            marginBottom: "1rem",
            color: "#16A34A"
          }}>
            {actionData.success}
          </div>
        )}

        {/* Banner for duplicate "Default Concierge" experiences */}
        {hasDuplicateDefaultConcierge && (
          <div style={{
            padding: "1rem",
            backgroundColor: "#FFFBEB",
            border: "1px solid #FCD34D",
            borderRadius: "12px",
            marginBottom: "1rem",
            color: "#D97706"
          }}>
            <div style={{ marginBottom: "0.5rem", fontWeight: "bold" }}>
              ⚠️ Multiple "Default Concierge" experiences detected
            </div>
            <div style={{ marginBottom: "0.75rem", fontSize: "0.875rem" }}>
              You have multiple experiences named "Default Concierge". We recommend keeping only the most recent one.
            </div>
            <Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="deleteDefaultConciergeDuplicates" />
              <button
                type="submit"
                disabled={navigation.state === "submitting"}
                style={{
                  padding: "0.5rem 1rem",
                  backgroundColor: "#F59E0B",
                  color: "#FFFFFF",
                  border: "none",
                  borderRadius: "12px",
                  cursor: navigation.state === "submitting" ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                }}
              >
                {navigation.state === "submitting" ? "Cleaning up..." : "Keep newest only"}
              </button>
            </Form>
          </div>
        )}

        {experiences.length === 0 ? (
          <div style={{ 
            textAlign: "center", 
            padding: "3rem 1rem",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem"
          }}>
            <p style={{ fontSize: "1.125rem", color: "rgba(11,11,15,0.62)" }}>
              No experiences yet
            </p>
            <p style={{ color: "rgba(11,11,15,0.62)", marginBottom: "1rem" }}>
              Create your first experience to get started.
            </p>
            <button
              type="button"
              onClick={() => navigate("new")}
              disabled={isLimitReached}
              style={{
                padding: "0.75rem 1.5rem",
                background: isLimitReached 
                  ? "rgba(11,11,15,0.2)" 
                  : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "#FFFFFF",
                border: "none",
                borderRadius: "12px",
                cursor: isLimitReached ? "not-allowed" : "pointer",
                fontSize: "1rem",
                fontWeight: "500",
                boxShadow: isLimitReached ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
              }}
            >
              {isLimitReached ? "Limit Reached" : "Create experience"}
            </button>
          </div>
        ) : (
          <>
            {experiences.length > 1 && (
              <Form method="post" style={{ marginBottom: "1rem" }}>
                <input type="hidden" name="intent" value="deleteDuplicates" />
                <button 
                  type="submit"
                  disabled={navigation.state === "submitting"}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#F9FAFB",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "12px",
                    color: "#0B0B0F",
                    cursor: navigation.state === "submitting" ? "not-allowed" : "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  {navigation.state === "submitting" ? "Deleting..." : "Delete duplicates"}
                </button>
              </Form>
            )}
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid rgba(11,11,15,0.12)", textAlign: "left", backgroundColor: "#F9FAFB" }}>
                  <th style={{ padding: "0.75rem" }}>Name</th>
                  <th style={{ padding: "0.75rem" }}>Mode</th>
                  <th style={{ padding: "0.75rem" }}>Results</th>
                  <th style={{ padding: "0.75rem" }}>Default</th>
                  <th style={{ padding: "0.75rem" }}>ID</th>
                  <th style={{ padding: "0.75rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {experiences.map((exp: any) => {
                  const shortId = exp.id.substring(0, 8);
                  return (
                    <tr key={exp.id} style={{ borderBottom: "1px solid rgba(11,11,15,0.12)" }}>
                      <td style={{ padding: "0.75rem" }}>{exp.name}</td>
                      <td style={{ padding: "0.75rem" }}>
                        {exp.mode === "quiz" ? "Guided Quiz" :
                         exp.mode === "chat" ? "Chat" :
                         exp.mode === "hybrid" ? "Hybrid" :
                         exp.mode}
                      </td>
                      <td style={{ padding: "0.75rem" }}>{exp.resultCount}</td>
                      <td style={{ padding: "0.75rem" }}>
                        {exp.isDefault ? (
                          <span style={{ color: "#10B981", fontWeight: "bold" }}>✓ Default</span>
                        ) : (
                          <span style={{ color: "rgba(11,11,15,0.4)" }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: "0.75rem" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <code 
                            style={{ fontSize: "0.875rem", fontFamily: "monospace" }}
                            title={exp.id}
                          >
                            {shortId}...
                          </code>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(exp.id);
                                setCopiedId(exp.id);
                                setTimeout(() => setCopiedId(null), 2000);
                              } catch (err) {
                                console.error("[ExperiencesIndex] Failed to copy ID:", err);
                              }
                            }}
                            style={{
                              padding: "0.25rem 0.5rem",
                              fontSize: "0.875rem",
                              backgroundColor: copiedId === exp.id ? "#06B6D4" : "#F9FAFB",
                              color: copiedId === exp.id ? "#FFFFFF" : "#0B0B0F",
                              border: copiedId === exp.id ? "none" : "1px solid rgba(11,11,15,0.12)",
                              borderRadius: "12px",
                              cursor: "pointer",
                              transition: "all 0.2s",
                            }}
                          >
                            {copiedId === exp.id ? "✓ Copied!" : "Copy ID"}
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: "0.75rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                          <Link 
                            to={exp.id}
                            style={{
                              padding: "0.25rem 0.75rem",
                              backgroundColor: "#F9FAFB",
                              border: "1px solid rgba(11,11,15,0.12)",
                              borderRadius: "12px",
                              textDecoration: "none",
                              color: "#0B0B0F",
                              fontSize: "0.875rem",
                            }}
                          >
                            Edit
                          </Link>
                          {!exp.isDefault && (
                            <Form method="post" style={{ display: "inline" }}>
                              <input type="hidden" name="intent" value="setDefault" />
                              <input type="hidden" name="experienceId" value={exp.id} />
                              <button 
                                type="submit"
                                disabled={navigation.state === "submitting"}
                                style={{
                                  padding: "0.25rem 0.75rem",
                                  backgroundColor: "#FFFFFF",
                                  border: "1px solid #7C3AED",
                                  borderRadius: "12px",
                                  color: "#7C3AED",
                                  cursor: navigation.state === "submitting" ? "not-allowed" : "pointer",
                                  fontSize: "0.875rem",
                                }}
                              >
                                {navigation.state === "submitting" ? "Setting..." : "Set Default"}
                              </button>
                            </Form>
                          )}
                          <Form method="post" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="experienceId" value={exp.id} />
                            <button 
                              type="submit"
                              disabled={navigation.state === "submitting"}
                              onClick={(e) => {
                                if (!confirm(`Are you sure you want to delete "${exp.name}"? This action cannot be undone.`)) {
                                  e.preventDefault();
                                }
                              }}
                              style={{
                                padding: "0.25rem 0.75rem",
                                backgroundColor: "#FFFFFF",
                                border: "1px solid #EF4444",
                                borderRadius: "12px",
                                color: "#EF4444",
                                cursor: navigation.state === "submitting" ? "not-allowed" : "pointer",
                                fontSize: "0.875rem",
                              }}
                            >
                              {navigation.state === "submitting" ? "Deleting..." : "Delete"}
                            </button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/*
 * TESTING CHECKLIST for Experiences List Page:
 * 
 * 1. Experience ID Column:
 *    - Verify ID column shows first 8 characters + "..."
 *    - Hover over ID to see full ID in tooltip
 *    - Click "Copy ID" button and verify:
 *      a) Button text changes to "✓ Copied!" for 2 seconds
 *      b) Full ID is copied to clipboard
 *      c) Can paste and verify correct ID
 * 
 * 2. Set Default Button:
 *    - Click "Set Default" on a non-default experience
 *    - Verify that experience becomes default (shows "✓ Default")
 *    - Verify previous default experience is no longer default
 *    - Verify only one experience can be default at a time
 *    - Verify button is hidden for the current default experience
 * 
 * 3. Delete Button:
 *    - Click "Delete" on an experience
 *    - Verify confirmation dialog appears
 *    - Cancel deletion and verify experience still exists
 *    - Confirm deletion and verify:
 *      a) Experience is removed from list
 *      b) Page refreshes/revalidates automatically
 *      c) Other experiences remain intact
 * 
 * 4. Duplicate "Default Concierge" Banner:
 *    - Create multiple experiences named "Default Concierge"
 *    - Verify yellow warning banner appears
 *    - Click "Keep newest only" button
 *    - Verify:
 *      a) Most recent "Default Concierge" is kept
 *      b) Older duplicates are deleted
 *      c) Banner disappears after cleanup
 * 
 * 5. General:
 *    - Verify all experiences for the shop are displayed
 *    - Verify experiences are sorted by creation date (newest first)
 *    - Verify shop scoping: only experiences for current shop are shown
 *    - Check browser console for any error logs
 */

