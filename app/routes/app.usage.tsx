import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
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

  // Get entitlements
  const entitlements = await getEntitlements(shop.id);

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

  // Calculate credits forecasting
  const periodDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) || 1;
  const dailyBurnRate = creditsBurned / periodDays;
  const remainingCreditsX2 = Math.max(0, totalCreditsX2 - usedCreditsX2);
  const daysUntilExhaustion = dailyBurnRate > 0 ? Math.floor(remainingCreditsX2 / (dailyBurnRate * 2)) : null;
  const projectedMonthlyBurn = dailyBurnRate * 30;

  // Calculate usage trends (daily burn and hourly peak)
  const dailyBurnMap = new Map<string, number>();
  const hourlyBurnMap = new Map<number, number>();
  
  for (const event of rows) {
    const eventDate = event.createdAt.toISOString().slice(0, 10);
    const eventHour = event.createdAt.getHours();
    const eventCredits = event.creditsBurned || 0;
    
    dailyBurnMap.set(eventDate, (dailyBurnMap.get(eventDate) || 0) + eventCredits);
    hourlyBurnMap.set(eventHour, (hourlyBurnMap.get(eventHour) || 0) + eventCredits);
  }

  const dailyBurn = Array.from(dailyBurnMap.entries())
    .map(([date, credits]) => ({ date, credits }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let hourlyPeak = { hour: 0, credits: 0 };
  for (const [hour, credits] of hourlyBurnMap.entries()) {
    if (credits > hourlyPeak.credits) {
      hourlyPeak = { hour, credits };
    }
  }

  const data: LoaderData = {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    totals,
    creditsBurned,
    ctr,
    events,
    showUpsellBanner,
    creditsUsagePercent,
    nextPlanTier,
    nextPlanName,
    creditsForecast: {
      dailyBurnRate,
      daysUntilExhaustion,
      projectedMonthlyBurn,
    },
    usageTrends: {
      dailyBurn,
      hourlyPeak,
    },
  };

  return data;
};

export default function UsagePage() {
  const data = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [fromDate, setFromDate] = useState(data.from);
  const [toDate, setToDate] = useState(data.to);
  const [preset, setPreset] = useState<string>("custom");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [eventSearch, setEventSearch] = useState<string>("");
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);

  // Update dates when loader data changes
  useEffect(() => {
    setFromDate(data.from);
    setToDate(data.to);
  }, [data.from, data.to]);

  // Check which preset matches current dates
  useEffect(() => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const todayStr = today.toISOString().slice(0, 10);
    
    const from = new Date(data.from);
    const to = new Date(data.to);
    const daysDiff = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    
    if (data.to === todayStr) {
      if (daysDiff === 6) {
        setPreset("7");
      } else if (daysDiff === 29) {
        setPreset("30");
      } else if (daysDiff === 89) {
        setPreset("90");
      } else {
        setPreset("custom");
      }
    } else {
      setPreset("custom");
    }
  }, [data.from, data.to]);

  const handlePresetChange = (days: number | "custom") => {
    if (days === "custom") {
      setPreset("custom");
      return;
    }

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const to = today.toISOString().slice(0, 10);
    
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    from.setHours(0, 0, 0, 0);
    const fromStr = from.toISOString().slice(0, 10);

    setPreset(String(days));
    setFromDate(fromStr);
    setToDate(to);
    
    navigate(`/app/usage?from=${fromStr}&to=${to}`);
  };

  const handleDateChange = () => {
    if (fromDate && toDate) {
      navigate(`/app/usage?from=${fromDate}&to=${toDate}`);
    }
  };

  return (
    <s-page heading="Usage & Analytics">
      <s-section>
        <div style={{ marginBottom: "1.5rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: "1rem",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            {/* Date Range Controls */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
                flex: "1",
                minWidth: "300px",
              }}
            >
              <div style={{ fontSize: "0.875rem", fontWeight: "500", color: "#0B0B0F", marginBottom: "0.25rem" }}>
                Date Range
              </div>
              
              {/* Quick Presets */}
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => handlePresetChange(7)}
                  style={{
                    padding: "0.5rem 1rem",
                    background: preset === "7" ? "#7C3AED" : "#FFFFFF",
                    color: preset === "7" ? "#FFFFFF" : "#0B0B0F",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    if (preset !== "7") {
                      e.currentTarget.style.background = "#F9FAFB";
                      e.currentTarget.style.borderColor = "#7C3AED";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (preset !== "7") {
                      e.currentTarget.style.background = "#FFFFFF";
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                    }
                  }}
                >
                  Last 7 days
                </button>
                <button
                  type="button"
                  onClick={() => handlePresetChange(30)}
                  style={{
                    padding: "0.5rem 1rem",
                    background: preset === "30" ? "#7C3AED" : "#FFFFFF",
                    color: preset === "30" ? "#FFFFFF" : "#0B0B0F",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    if (preset !== "30") {
                      e.currentTarget.style.background = "#F9FAFB";
                      e.currentTarget.style.borderColor = "#7C3AED";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (preset !== "30") {
                      e.currentTarget.style.background = "#FFFFFF";
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                    }
                  }}
                >
                  Last 30 days
                </button>
                <button
                  type="button"
                  onClick={() => handlePresetChange(90)}
                  style={{
                    padding: "0.5rem 1rem",
                    background: preset === "90" ? "#7C3AED" : "#FFFFFF",
                    color: preset === "90" ? "#FFFFFF" : "#0B0B0F",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    if (preset !== "90") {
                      e.currentTarget.style.background = "#F9FAFB";
                      e.currentTarget.style.borderColor = "#7C3AED";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (preset !== "90") {
                      e.currentTarget.style.background = "#FFFFFF";
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                    }
                  }}
                >
                  Last 90 days
                </button>
                <button
                  type="button"
                  onClick={() => setPreset("custom")}
                  style={{
                    padding: "0.5rem 1rem",
                    background: preset === "custom" ? "#7C3AED" : "#FFFFFF",
                    color: preset === "custom" ? "#FFFFFF" : "#0B0B0F",
                    border: "1px solid rgba(11,11,15,0.12)",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    if (preset !== "custom") {
                      e.currentTarget.style.background = "#F9FAFB";
                      e.currentTarget.style.borderColor = "#7C3AED";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (preset !== "custom") {
                      e.currentTarget.style.background = "#FFFFFF";
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                    }
                  }}
                >
                  Custom
                </button>
              </div>

              {/* Date Pickers */}
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "1", minWidth: "140px" }}>
                  <label
                    style={{
                      fontSize: "0.75rem",
                      color: "rgba(11,11,15,0.62)",
                      fontWeight: "500",
                    }}
                  >
                    From
                  </label>
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => {
                      setFromDate(e.target.value);
                      setPreset("custom");
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                      e.currentTarget.style.boxShadow = "none";
                      handleDateChange();
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "#7C3AED";
                      e.currentTarget.style.boxShadow = "0 0 0 3px rgba(124, 58, 237, 0.1)";
                    }}
                    max={toDate}
                    style={{
                      padding: "0.625rem 0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontSize: "0.875rem",
                      fontFamily: "inherit",
                      color: "#0B0B0F",
                      backgroundColor: "#FFFFFF",
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: "1.25rem",
                    color: "rgba(11,11,15,0.62)",
                    marginTop: "1.5rem",
                  }}
                >
                  →
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: "1", minWidth: "140px" }}>
                  <label
                    style={{
                      fontSize: "0.75rem",
                      color: "rgba(11,11,15,0.62)",
                      fontWeight: "500",
                    }}
                  >
                    To
                  </label>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => {
                      setToDate(e.target.value);
                      setPreset("custom");
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "rgba(11,11,15,0.12)";
                      e.currentTarget.style.boxShadow = "none";
                      handleDateChange();
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "#7C3AED";
                      e.currentTarget.style.boxShadow = "0 0 0 3px rgba(124, 58, 237, 0.1)";
                    }}
                    min={fromDate}
                    max={new Date().toISOString().slice(0, 10)}
                    style={{
                      padding: "0.625rem 0.75rem",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "8px",
                      fontSize: "0.875rem",
                      fontFamily: "inherit",
                      color: "#0B0B0F",
                      backgroundColor: "#FFFFFF",
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Export CSV Button */}
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <a
                href={`/app/usage.csv?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`}
                style={{
                  padding: "0.625rem 1.25rem",
                  background: "#7C3AED",
                  border: "none",
                  borderRadius: "8px",
                  color: "#FFFFFF",
                  textDecoration: "none",
                  fontWeight: "500",
                  fontSize: "0.875rem",
                  display: "inline-block",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#6D28D9";
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow = "0 4px 12px rgba(124, 58, 237, 0.3)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#7C3AED";
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                Export CSV
              </a>
            </div>
          </div>

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

        {/* Credits Forecasting */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
            marginBottom: "2rem",
          }}
        >
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
            }}
          >
            <div
              style={{
                fontSize: "0.875rem",
                color: "rgba(11,11,15,0.62)",
                marginBottom: "0.25rem",
              }}
            >
              Daily Burn Rate
            </div>
            <div
              style={{
                fontSize: "1.25rem",
                fontWeight: "bold",
                color: "#7C3AED",
              }}
            >
              {data.creditsForecast.dailyBurnRate.toFixed(2)}
            </div>
          </div>
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
            }}
          >
            <div
              style={{
                fontSize: "0.875rem",
                color: "rgba(11,11,15,0.62)",
                marginBottom: "0.25rem",
              }}
            >
              Days Until Exhaustion
            </div>
            <div
              style={{
                fontSize: "1.25rem",
                fontWeight: "bold",
                color: data.creditsForecast.daysUntilExhaustion !== null && data.creditsForecast.daysUntilExhaustion < 30 ? "#EF4444" : "#06B6D4",
              }}
            >
              {data.creditsForecast.daysUntilExhaustion !== null
                ? `${data.creditsForecast.daysUntilExhaustion} days`
                : "N/A"}
            </div>
          </div>
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
            }}
          >
            <div
              style={{
                fontSize: "0.875rem",
                color: "rgba(11,11,15,0.62)",
                marginBottom: "0.25rem",
              }}
            >
              Projected Monthly Burn
            </div>
            <div
              style={{
                fontSize: "1.25rem",
                fontWeight: "bold",
                color: "#0B0B0F",
              }}
            >
              {data.creditsForecast.projectedMonthlyBurn.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Usage Trends */}
        {data.usageTrends.dailyBurn.length > 0 && (
          <div style={{ marginBottom: "2rem" }}>
            <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Usage Trends</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                gap: "1rem",
                marginBottom: "1rem",
              }}
            >
              <div
                style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.875rem",
                    color: "rgba(11,11,15,0.62)",
                    marginBottom: "0.5rem",
                  }}
                >
                  Peak Usage Hour
                </div>
                <div
                  style={{
                    fontSize: "1rem",
                    fontWeight: "500",
                    color: "#0B0B0F",
                  }}
                >
                  {data.usageTrends.hourlyPeak.hour}:00 - {data.usageTrends.hourlyPeak.credits.toFixed(2)} credits
                </div>
              </div>
            </div>
            <div
              style={{
                padding: "1rem",
                backgroundColor: "#FFFFFF",
                border: "1px solid rgba(11,11,15,0.12)",
                borderRadius: "12px",
                boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
              }}
            >
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "rgba(11,11,15,0.62)",
                  marginBottom: "0.75rem",
                  fontWeight: "500",
                }}
              >
                Daily Credits Burn
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", height: "120px", overflowX: "auto" }}>
                {data.usageTrends.dailyBurn.map((day, idx) => {
                  const maxCredits = Math.max(...data.usageTrends.dailyBurn.map(d => d.credits), 1);
                  const heightPercent = (day.credits / maxCredits) * 100;
                  return (
                    <div
                      key={idx}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "0.25rem",
                        flex: "1",
                        minWidth: "40px",
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: `${heightPercent}%`,
                          minHeight: "4px",
                          backgroundColor: "#7C3AED",
                          borderRadius: "4px 4px 0 0",
                          transition: "all 0.3s",
                        }}
                        title={`${day.date}: ${day.credits.toFixed(2)} credits`}
                      />
                      <div
                        style={{
                          fontSize: "0.625rem",
                          color: "rgba(11,11,15,0.62)",
                          transform: "rotate(-45deg)",
                          transformOrigin: "center",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {new Date(day.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Recent events (latest 500)</h2>
        
        {/* Event Filtering */}
        <div
          style={{
            display: "flex",
            gap: "1rem",
            marginBottom: "1rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "1", minWidth: "200px" }}>
            <label
              style={{
                fontSize: "0.875rem",
                color: "rgba(11,11,15,0.62)",
                fontWeight: "500",
                whiteSpace: "nowrap",
              }}
            >
              Filter by Type:
            </label>
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              style={{
                padding: "0.5rem 0.75rem",
                border: "1px solid rgba(11,11,15,0.12)",
                borderRadius: "6px",
                fontSize: "0.875rem",
                fontFamily: "inherit",
                color: "#0B0B0F",
                backgroundColor: "#FFFFFF",
                cursor: "pointer",
                flex: "1",
              }}
            >
              <option value="all">All Events</option>
              <option value="SESSION_STARTED">Sessions Started</option>
              <option value="AI_RANKING_EXECUTED">AI Executions</option>
              <option value="RESULTS_VIEWED">Results Viewed</option>
              <option value="RECOMMENDATION_CLICKED">Product Clicks</option>
              <option value="ADD_TO_CART_CLICKED">Add to Cart</option>
              <option value="CHECKOUT_STARTED">Checkout Started</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "1", minWidth: "200px" }}>
            <label
              style={{
                fontSize: "0.875rem",
                color: "rgba(11,11,15,0.62)",
                fontWeight: "500",
                whiteSpace: "nowrap",
              }}
            >
              Search:
            </label>
            <input
              type="text"
              value={eventSearch}
              onChange={(e) => setEventSearch(e.target.value)}
              placeholder="Search by metadata, session ID, handle..."
              style={{
                padding: "0.5rem 0.75rem",
                border: "1px solid rgba(11,11,15,0.12)",
                borderRadius: "6px",
                fontSize: "0.875rem",
                fontFamily: "inherit",
                color: "#0B0B0F",
                backgroundColor: "#FFFFFF",
                flex: "1",
              }}
            />
          </div>
        </div>

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
                <th style={{ textAlign: "center", borderBottom: "1px solid rgba(11,11,15,0.12)", padding: "0.75rem 1rem", fontWeight: "500", color: "#0B0B0F" }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let filteredEvents = data.events;
                
                // Filter by event type
                if (eventFilter !== "all") {
                  filteredEvents = filteredEvents.filter(e => e.eventType === eventFilter);
                }
                
                // Filter by search term
                if (eventSearch.trim()) {
                  const searchLower = eventSearch.toLowerCase();
                  filteredEvents = filteredEvents.filter(e => {
                    const metadataStr = JSON.stringify(e.metadata || {}).toLowerCase();
                    return e.eventType.toLowerCase().includes(searchLower) || metadataStr.includes(searchLower);
                  });
                }
                
                return filteredEvents.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        padding: "2rem",
                        textAlign: "center",
                        color: "rgba(11,11,15,0.62)",
                      }}
                    >
                      No events found matching your filters
                    </td>
                  </tr>
                ) : (
                  filteredEvents.map((e, idx) => (
                    <tr
                      key={idx}
                      style={{
                        backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                        cursor: "pointer",
                      }}
                      onClick={() => setSelectedEvent(selectedEvent === idx ? null : idx)}
                    >
                      <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", whiteSpace: "nowrap", color: "rgba(11,11,15,0.62)", fontSize: "0.875rem" }}>
                        {new Date(e.createdAt).toLocaleString()}
                      </td>
                      <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", color: "#0B0B0F" }}>{e.eventType}</td>
                      <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.75rem", color: "rgba(11,11,15,0.62)", maxHeight: selectedEvent === idx ? "none" : "3rem", overflow: selectedEvent === idx ? "visible" : "hidden" }}>
                          {JSON.stringify(e.metadata, null, 2)}
                        </pre>
                      </td>
                      <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", textAlign: "right", fontWeight: "500", color: "#7C3AED" }}>{e.creditsBurned.toFixed(2)}</td>
                      <td style={{ borderBottom: "1px solid rgba(11,11,15,0.08)", padding: "0.75rem 1rem", textAlign: "center" }}>
                        <button
                          style={{
                            padding: "0.25rem 0.5rem",
                            background: selectedEvent === idx ? "#7C3AED" : "transparent",
                            color: selectedEvent === idx ? "#FFFFFF" : "#7C3AED",
                            border: "1px solid #7C3AED",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            cursor: "pointer",
                          }}
                        >
                          {selectedEvent === idx ? "Hide" : "View"}
                        </button>
                      </td>
                    </tr>
                  ))
                );
              })()}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
