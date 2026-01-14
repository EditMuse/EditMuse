import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, redirect, useActionData, useNavigation } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType } from "@prisma/client";
import { useState, useEffect } from "react";

type LoaderData = {
  experiments: Array<{
    id: string;
    key: string;
    isActive: boolean;
    variants: any;
    startedAt: string;
    createdAt: string;
    results: Array<{
      variantName: string;
      exposures: number;
      atcRate: number;
      orderRate: number;
      revenuePerExposure: number;
    }>;
  }>;
};

function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const experiments = await prisma.experiment.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  // Calculate results for each experiment
  const experimentsWithResults = await Promise.all(
    experiments.map(async (exp) => {
      const variants = Array.isArray(exp.variants) ? exp.variants : [];
      
      // Fetch EXPERIMENT_EXPOSED events for this experiment
      const exposureEvents = await prisma.usageEvent.findMany({
        where: {
          shopId: shop.id,
          eventType: UsageEventType.EXPERIMENT_EXPOSED,
        },
        orderBy: { createdAt: "desc" },
      });

      // Filter exposure events for this experiment key
      const experimentExposures = exposureEvents.filter((e) => {
        const meta = safeJson(e.metadata);
        return meta?.experimentKey === exp.key;
      });

      // For each variant, calculate metrics
      const results = await Promise.all(
        variants.map(async (variant: any) => {
          const variantName = variant.name || "unknown";
          
          // Count exposures for this variant
          const variantExposures = experimentExposures.filter((e) => {
            const meta = safeJson(e.metadata);
            return meta?.variantName === variantName;
          });
          const exposures = variantExposures.length;

          // Get session IDs from exposures
          const exposedSessionIds = new Set<string>();
          variantExposures.forEach((e) => {
            const meta = safeJson(e.metadata);
            if (meta?.sessionId) {
              exposedSessionIds.add(meta.sessionId);
            }
          });

          // Count ATC events for sessions exposed to this variant
          const atcEvents = await prisma.usageEvent.findMany({
            where: {
              shopId: shop.id,
              eventType: UsageEventType.ADD_TO_CART_CLICKED,
            },
          });
          const atcForVariant = atcEvents.filter((e) => {
            const meta = safeJson(e.metadata);
            return meta?.sessionId && exposedSessionIds.has(meta.sessionId);
          }).length;

          // Count order attributions for sessions from these exposures
          const orderAttributions = await prisma.orderAttribution.findMany({
            where: { shopId: shop.id },
          });

          const ordersForVariant = orderAttributions.filter((oa) => {
            return oa.sessionId && exposedSessionIds.has(oa.sessionId);
          });

          const ordersCount = ordersForVariant.length;
          const revenue = ordersForVariant.reduce((sum, oa) => {
            return sum + parseFloat(oa.totalPrice || "0");
          }, 0);

          const atcRate = exposures > 0 ? (atcForVariant / exposures) * 100 : 0;
          const orderRate = exposures > 0 ? (ordersCount / exposures) * 100 : 0;
          const revenuePerExposure = exposures > 0 ? revenue / exposures : 0;

          return {
            variantName,
            exposures,
            atcRate: parseFloat(atcRate.toFixed(2)),
            orderRate: parseFloat(orderRate.toFixed(2)),
            revenuePerExposure: parseFloat(revenuePerExposure.toFixed(2)),
          };
        })
      );

      return {
        id: exp.id,
        key: exp.key,
        isActive: exp.isActive,
        variants: exp.variants,
        startedAt: exp.startedAt.toISOString(),
        createdAt: exp.createdAt.toISOString(),
        results,
      };
    })
  );

  return Response.json({ experiments: experimentsWithResults });
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
  const actionType = formData.get("actionType")?.toString();

  if (actionType === "create" || actionType === "update") {
    const id = formData.get("id")?.toString();
    const key = formData.get("key")?.toString();
    const variantsJson = formData.get("variants")?.toString();

    if (!key || !variantsJson) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    let variants: any;
    try {
      variants = JSON.parse(variantsJson);
      if (!Array.isArray(variants) || variants.length < 2) {
        return Response.json({ error: "Variants must be a JSON array with at least 2 variants" }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: "Invalid variants JSON" }, { status: 400 });
    }

    if (actionType === "update" && id) {
      await prisma.experiment.update({
        where: { id },
        data: {
          key,
          variants,
        },
      });
    } else {
      await prisma.experiment.upsert({
        where: {
          shopId_key: {
            shopId: shop.id,
            key,
          },
        },
        create: {
          shopId: shop.id,
          key,
          variants,
          isActive: false,
        },
        update: {
          variants,
        },
      });
    }

    return Response.json({ success: true });
  }

  if (actionType === "toggle") {
    const id = formData.get("id")?.toString();
    const isActive = formData.get("isActive")?.toString() === "true";

    if (!id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    await prisma.experiment.update({
      where: { id },
      data: { isActive, startedAt: isActive ? new Date() : undefined },
    });

    return Response.json({ success: true });
  }

  if (actionType === "delete") {
    const id = formData.get("id")?.toString();

    if (!id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    await prisma.experiment.delete({
      where: { id },
    });

    return redirect("/app/experiments");
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
};

export default function ExperimentsPage() {
  const { experiments } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [showForm, setShowForm] = useState(false);
  const [editingExperiment, setEditingExperiment] = useState<any>(null);
  const [formKey, setFormKey] = useState("");
  const [formVariants, setFormVariants] = useState("");

  useEffect(() => {
    if (actionData?.success) {
      setShowForm(false);
      setEditingExperiment(null);
      setFormKey("");
      setFormVariants("");
    }
  }, [actionData]);

  const handleCreate = () => {
    setEditingExperiment(null);
    setFormKey("");
    setFormVariants('[\n  { "name": "control", "config": {} },\n  { "name": "variant_a", "config": {} }\n]');
    setShowForm(true);
  };

  const handleEdit = (exp: any) => {
    setEditingExperiment(exp);
    setFormKey(exp.key);
    setFormVariants(JSON.stringify(exp.variants, null, 2));
    setShowForm(true);
  };

  return (
    <s-page heading="A/B Experiments">
      <s-section>
        <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
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
              Operation successful!
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
            <h2 style={{ margin: 0, color: "#0B0B0F" }}>A/B Experiments</h2>
            <button
              type="button"
              onClick={handleCreate}
              style={{
                padding: "0.75rem 1.5rem",
                background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                color: "white",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
              }}
            >
              Create Experiment
            </button>
          </div>

          {showForm && (
            <div
              style={{
                padding: "1.5rem",
                marginBottom: "2rem",
                backgroundColor: "#F9FAFB",
                border: "1px solid #E5E7EB",
                borderRadius: "8px",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>
                {editingExperiment ? "Edit Experiment" : "Create Experiment"}
              </h3>
              <Form method="post">
                <input
                  type="hidden"
                  name="actionType"
                  value={editingExperiment ? "update" : "create"}
                />
                {editingExperiment && <input type="hidden" name="id" value={editingExperiment.id} />}
                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                    Experiment Key
                  </label>
                  <input
                    type="text"
                    name="key"
                    value={formKey}
                    onChange={(e) => setFormKey(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                    }}
                  />
                </div>
                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                    Variants (JSON)
                  </label>
                  <textarea
                    name="variants"
                    value={formVariants}
                    onChange={(e) => setFormVariants(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: "200px",
                      fontFamily: "monospace",
                      padding: "0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: "1rem" }}>
                  <button
                    type="submit"
                    disabled={navigation.state === "submitting"}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: navigation.state === "submitting" ? "#9CA3AF" : "linear-gradient(135deg, #7C3AED, #06B6D4)",
                      color: "white",
                      border: "none",
                      borderRadius: "8px",
                      cursor: navigation.state === "submitting" ? "not-allowed" : "pointer",
                    }}
                  >
                    {navigation.state === "submitting" ? "Saving..." : editingExperiment ? "Update" : "Create"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setEditingExperiment(null);
                    }}
                    style={{
                      padding: "0.75rem 1.5rem",
                      background: "white",
                      color: "#0B0B0F",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </Form>
            </div>
          )}

          {experiments.length === 0 ? (
            <p>No experiments yet. Create your first experiment to start testing.</p>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                backgroundColor: "white",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <thead>
                <tr style={{ backgroundColor: "#F9FAFB", borderBottom: "2px solid #E5E7EB" }}>
                  <th style={{ padding: "1rem", textAlign: "left", fontWeight: "600" }}>Experiment Key</th>
                  <th style={{ padding: "1rem", textAlign: "left", fontWeight: "600" }}>Status</th>
                  <th style={{ padding: "1rem", textAlign: "left", fontWeight: "600" }}>Variant</th>
                  <th style={{ padding: "1rem", textAlign: "right", fontWeight: "600" }}>Exposures</th>
                  <th style={{ padding: "1rem", textAlign: "right", fontWeight: "600" }}>ATC Rate</th>
                  <th style={{ padding: "1rem", textAlign: "right", fontWeight: "600" }}>Order Rate</th>
                  <th style={{ padding: "1rem", textAlign: "right", fontWeight: "600" }}>Revenue/Exposure</th>
                  <th style={{ padding: "1rem", textAlign: "left", fontWeight: "600" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {experiments.flatMap((exp, expIdx) =>
                  exp.results.length === 0
                    ? [
                        <tr key={exp.id} style={{ borderBottom: "1px solid #E5E7EB" }}>
                          <td style={{ padding: "1rem" }}>{exp.key}</td>
                          <td style={{ padding: "1rem" }}>
                            <span
                              style={{
                                padding: "0.25rem 0.75rem",
                                borderRadius: "12px",
                                fontSize: "0.875rem",
                                backgroundColor: exp.isActive ? "#D1FAE5" : "#E5E7EB",
                                color: exp.isActive ? "#065F46" : "#374151",
                              }}
                            >
                              {exp.isActive ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td style={{ padding: "1rem" }} colSpan={5}>No data</td>
                          <td style={{ padding: "1rem" }}>
                            <div style={{ display: "flex", gap: "0.5rem" }}>
                              <button
                                type="button"
                                onClick={() => handleEdit(exp)}
                                style={{
                                  padding: "0.5rem 1rem",
                                  background: "white",
                                  border: "1px solid #E5E7EB",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  fontSize: "0.875rem",
                                }}
                              >
                                Edit
                              </button>
                              <Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="actionType" value="toggle" />
                                <input type="hidden" name="id" value={exp.id} />
                                <input type="hidden" name="isActive" value={String(!exp.isActive)} />
                                <button
                                  type="submit"
                                  style={{
                                    padding: "0.5rem 1rem",
                                    background: exp.isActive ? "white" : "#7C3AED",
                                    color: exp.isActive ? "#0B0B0F" : "white",
                                    border: "1px solid #E5E7EB",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    fontSize: "0.875rem",
                                  }}
                                >
                                  {exp.isActive ? "Disable" : "Enable"}
                                </button>
                              </Form>
                              <Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="actionType" value="delete" />
                                <input type="hidden" name="id" value={exp.id} />
                                <button
                                  type="submit"
                                  style={{
                                    padding: "0.5rem 1rem",
                                    background: "white",
                                    border: "1px solid #EF4444",
                                    color: "#EF4444",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    fontSize: "0.875rem",
                                  }}
                                >
                                  Delete
                                </button>
                              </Form>
                            </div>
                          </td>
                        </tr>,
                      ]
                    : exp.results.map((result, idx) => (
                        <tr key={`${exp.id}-${idx}`} style={{ borderBottom: "1px solid #E5E7EB" }}>
                          {idx === 0 && <td style={{ padding: "1rem" }} rowSpan={exp.results.length}>{exp.key}</td>}
                          {idx === 0 && (
                            <td style={{ padding: "1rem" }} rowSpan={exp.results.length}>
                              <span
                                style={{
                                  padding: "0.25rem 0.75rem",
                                  borderRadius: "12px",
                                  fontSize: "0.875rem",
                                  backgroundColor: exp.isActive ? "#D1FAE5" : "#E5E7EB",
                                  color: exp.isActive ? "#065F46" : "#374151",
                                }}
                              >
                                {exp.isActive ? "Active" : "Inactive"}
                              </span>
                            </td>
                          )}
                          <td style={{ padding: "1rem" }}>{result.variantName}</td>
                          <td style={{ padding: "1rem", textAlign: "right" }}>{result.exposures.toLocaleString()}</td>
                          <td style={{ padding: "1rem", textAlign: "right" }}>{result.atcRate.toFixed(2)}%</td>
                          <td style={{ padding: "1rem", textAlign: "right" }}>{result.orderRate.toFixed(2)}%</td>
                          <td style={{ padding: "1rem", textAlign: "right" }}>${result.revenuePerExposure.toFixed(2)}</td>
                          {idx === 0 && (
                            <td style={{ padding: "1rem" }} rowSpan={exp.results.length}>
                              <div style={{ display: "flex", gap: "0.5rem" }}>
                                <button
                                  type="button"
                                  onClick={() => handleEdit(exp)}
                                  style={{
                                    padding: "0.5rem 1rem",
                                    background: "white",
                                    border: "1px solid #E5E7EB",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    fontSize: "0.875rem",
                                  }}
                                >
                                  Edit
                                </button>
                                <Form method="post" style={{ display: "inline" }}>
                                  <input type="hidden" name="actionType" value="toggle" />
                                  <input type="hidden" name="id" value={exp.id} />
                                  <input type="hidden" name="isActive" value={String(!exp.isActive)} />
                                  <button
                                    type="submit"
                                    style={{
                                      padding: "0.5rem 1rem",
                                      background: exp.isActive ? "white" : "#7C3AED",
                                      color: exp.isActive ? "#0B0B0F" : "white",
                                      border: "1px solid #E5E7EB",
                                      borderRadius: "6px",
                                      cursor: "pointer",
                                      fontSize: "0.875rem",
                                    }}
                                  >
                                    {exp.isActive ? "Disable" : "Enable"}
                                  </button>
                                </Form>
                                <Form method="post" style={{ display: "inline" }}>
                                  <input type="hidden" name="actionType" value="delete" />
                                  <input type="hidden" name="id" value={exp.id} />
                                  <button
                                    type="submit"
                                    style={{
                                      padding: "0.5rem 1rem",
                                      background: "white",
                                      border: "1px solid #EF4444",
                                      color: "#EF4444",
                                      borderRadius: "6px",
                                      cursor: "pointer",
                                      fontSize: "0.875rem",
                                    }}
                                  >
                                    Delete
                                  </button>
                                </Form>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </s-section>
    </s-page>
  );
}
