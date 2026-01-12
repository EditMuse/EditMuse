import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType } from "@prisma/client";
import { getEntitlements } from "~/models/billing.server";
import { PLAN_TIER } from "~/models/billing.server";

type LoaderData = {
  from: string;
  to: string;
  totals: Record<string, number>;
  creditsBurned: number;
  ctr: number | null;
  events: Array<{ createdAt: string; eventType: string; metadata: any; creditsBurned: number }>;
  canMidReporting: boolean;
  canAdvancedReporting: boolean;
  showUpsellBanner: boolean;
  creditsUsagePercent: number;
  nextPlanTier?: string;
  nextPlanName?: string;
};

function safeJson(s: string | null) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  // Get entitlements for reporting gates
  const entitlements = await getEntitlements(shop.id);
  
  // Reporting gates:
  // - Lite/Growth: basic only
  // - Scale+: mid reporting
  // - Pro or advanced add-on: advanced reporting
  const canMidReporting = 
    entitlements.planTier === PLAN_TIER.SCALE || 
    entitlements.planTier === PLAN_TIER.PRO;
  const canAdvancedReporting = 
    entitlements.planTier === PLAN_TIER.PRO || 
    entitlements.canAdvancedReporting;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const rows = await prisma.usageEvent.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: fromDate, lte: toDate },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const totals: Record<string, number> = {};
  let creditsBurned = 0;

  for (const r of rows) {
    totals[r.eventType] = (totals[r.eventType] || 0) + 1;
    creditsBurned += r.creditsBurned || 0;
  }

  const views = totals["RESULTS_VIEWED"] || 0;
  const clicks = totals["RECOMMENDATION_CLICKED"] || 0;
  const ctr = views > 0 ? clicks / views : null;

  const events = rows.map(r => ({
    createdAt: r.createdAt.toISOString(),
    eventType: r.eventType,
    metadata: safeJson(r.metadata),
    creditsBurned: r.creditsBurned || 0,
  }));

  // Check if credits usage >= 80% to show upsell banner
  const totalCreditsX2 = entitlements.totalCreditsX2 || 0;
  const usedCreditsX2 = entitlements.usedCreditsX2 || 0;
  const creditsUsagePercent = totalCreditsX2 > 0 ? (usedCreditsX2 / totalCreditsX2) * 100 : 0;
  const showUpsellBanner = creditsUsagePercent >= 80 && entitlements.planTier !== PLAN_TIER.PRO;

  // Determine next plan tier for upsell
  let nextPlanTier: string | undefined;
  let nextPlanName: string | undefined;
  if (showUpsellBanner) {
    if (entitlements.planTier === PLAN_TIER.TRIAL) {
      nextPlanTier = "LITE";
      nextPlanName = "Lite";
    } else if (entitlements.planTier === PLAN_TIER.LITE) {
      nextPlanTier = "GROWTH";
      nextPlanName = "Growth";
    } else if (entitlements.planTier === PLAN_TIER.GROWTH) {
      nextPlanTier = "SCALE";
      nextPlanName = "Scale";
    } else if (entitlements.planTier === PLAN_TIER.SCALE) {
      nextPlanTier = "PRO";
      nextPlanName = "Pro";
    }
  }

  const data: LoaderData = {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    totals,
    creditsBurned,
    ctr,
    events,
    canMidReporting,
    canAdvancedReporting,
    showUpsellBanner,
    creditsUsagePercent,
    nextPlanTier,
    nextPlanName,
  };

  return data;
};

export default function UsagePage() {
  const data = useLoaderData<LoaderData>();

  return (
    <s-page heading="Usage & Analytics">
      <s-section>
        <div style={{ marginBottom: "1.5rem" }}>
          <p style={{ color: "rgba(11,11,15,0.62)", fontSize: "0.875rem", marginBottom: "1rem" }}>
            Range: <strong style={{ color: "#0B0B0F" }}>{data.from}</strong> → <strong style={{ color: "#0B0B0F" }}>{data.to}</strong>
          </p>

          {/* Upsell Banner - Show when credits usage >= 80% */}
          {data.showUpsellBanner && data.nextPlanTier && (
            <div style={{
              padding: "1rem 1.5rem",
              background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
              border: "2px solid rgba(124, 58, 237, 0.5)",
              borderRadius: "12px",
              marginBottom: "1.5rem",
              color: "#FFFFFF",
              boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "1rem"
            }}>
              <div>
                <div style={{ fontWeight: "600", fontSize: "1rem", marginBottom: "0.25rem" }}>
                  Running low on credits! ({data.creditsUsagePercent.toFixed(1)}% used)
                </div>
                <div style={{ fontSize: "0.875rem", opacity: 0.9 }}>
                  Upgrade to <strong>{data.nextPlanName}</strong> plan for more credits and better features.
                </div>
              </div>
              <a
                href="/app/billing"
                style={{
                  padding: "0.625rem 1.25rem",
                  background: "rgba(255, 255, 255, 0.2)",
                  border: "1px solid rgba(255, 255, 255, 0.3)",
                  borderRadius: "8px",
                  color: "#FFFFFF",
                  textDecoration: "none",
                  fontWeight: "500",
                  fontSize: "0.875rem",
                  transition: "background 0.2s",
                  whiteSpace: "nowrap"
                }}
                onMouseOver={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.3)"}
                onMouseOut={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.2)"}
              >
                Upgrade Now
              </a>
            </div>
          )}

          <div style={{ 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", 
            gap: "1rem", 
            marginBottom: "2rem" 
          }}>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Credits burned</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#7C3AED" }}>{data.creditsBurned.toFixed(2)}</div>
            </div>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>CTR</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#06B6D4" }}>{data.ctr === null ? "—" : (data.ctr * 100).toFixed(1) + "%"}</div>
            </div>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Sessions started</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{data.totals["SESSION_STARTED"] || 0}</div>
            </div>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Results viewed</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{data.totals["RESULTS_VIEWED"] || 0}</div>
            </div>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Recommendation clicks</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{data.totals["RECOMMENDATION_CLICKED"] || 0}</div>
            </div>
            <div style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
            }}>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>AI executions</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{data.totals["AI_RANKING_EXECUTED"] || 0}</div>
            </div>
          </div>
        </div>

        {/* Mid Reporting Section - Only for Scale+ */}
        {data.canMidReporting && (
          <div style={{ 
            marginBottom: "1.5rem", 
            padding: "1.5rem", 
            background: "linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(6, 182, 212, 0.1))",
            border: "2px solid rgba(124, 58, 237, 0.3)", 
            borderRadius: "12px",
            boxShadow: "0 4px 12px rgba(124, 58, 237, 0.2)"
          }}>
            <h2 style={{ marginTop: 0, color: "#7C3AED", fontSize: "1.25rem", marginBottom: "0.5rem" }}>Mid Reporting (Scale+)</h2>
            <p style={{ color: "rgba(11,11,15,0.62)", margin: 0 }}>Additional analytics and insights available for Scale and Pro plans.</p>
            {/* Add mid reporting content here */}
          </div>
        )}

        {/* Advanced Reporting Section - Only for Pro or advanced add-on */}
        {data.canAdvancedReporting && (
          <div style={{ 
            marginBottom: "1.5rem", 
            padding: "1.5rem", 
            background: "linear-gradient(135deg, rgba(124, 58, 237, 0.15), rgba(6, 182, 212, 0.15))",
            border: "2px solid rgba(124, 58, 237, 0.4)", 
            borderRadius: "12px",
            boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)"
          }}>
            <h2 style={{ marginTop: 0, color: "#7C3AED", fontSize: "1.25rem", marginBottom: "0.5rem" }}>Advanced Reporting (Pro/Add-on)</h2>
            <p style={{ color: "rgba(11,11,15,0.62)", margin: 0 }}>Advanced attribution and analytics available for Pro plans or with Advanced Reporting add-on.</p>
            {/* Add advanced reporting content here */}
          </div>
        )}

        <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Recent events (latest 500)</h2>
        <div style={{
          backgroundColor: "#FFFFFF",
          border: "1px solid rgba(11,11,15,0.12)",
          borderRadius: "12px",
          overflow: "hidden",
          boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
        }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: "#F9FAFB" }}>
                <th style={{ textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", padding: "0.75rem 1rem", fontWeight: "500", color: "#0B0B0F" }}>Time</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", padding: "0.75rem 1rem", fontWeight: "500", color: "#0B0B0F" }}>Type</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid rgba(11,11,15,0.12)", padding: "0.75rem 1rem", fontWeight: "500", color: "#0B0B0F" }}>Metadata</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid rgba(11,11,15,0.12)", padding: "0.75rem 1rem", fontWeight: "500", color: "#0B0B0F" }}>Credits</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e, idx) => (
                <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB" }}>
                  <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", whiteSpace: "nowrap", color: "rgba(11,11,15,0.62)", fontSize: "0.875rem" }}>{e.createdAt}</td>
                  <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", color: "#0B0B0F" }}>{e.eventType}</td>
                  <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem" }}>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.75rem", color: "rgba(11,11,15,0.62)" }}>{JSON.stringify(e.metadata, null, 2)}</pre>
                  </td>
                  <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", textAlign: "right", fontWeight: "500", color: "#7C3AED" }}>{e.creditsBurned.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
