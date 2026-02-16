import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { useState, useMemo } from "react";

type LoaderData = {
  errors: Array<{
    id: string;
    requestId: string;
    route: string | null;
    message: string;
    stack: string | null;
    contextJson: string | null;
    createdAt: Date;
  }>;
  proxyLogs: Array<{
    id: string;
    requestId: string;
    route: string;
    status: number;
    durationMs: number;
    createdAt: Date;
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  // Fetch last 50 errors
  const errors = await prisma.appError.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      requestId: true,
      route: true,
      message: true,
      stack: true,
      contextJson: true,
      createdAt: true,
    },
  });

  // Fetch last 50 proxy logs
  const proxyLogs = await prisma.appProxyLog.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      requestId: true,
      route: true,
      status: true,
      durationMs: true,
      createdAt: true,
    },
  });

  return {
    errors,
    proxyLogs,
  };
};

export default function DiagnosePage() {
  const { errors, proxyLogs } = useLoaderData<LoaderData>();
  const [copied, setCopied] = useState(false);
  const [errorFilter, setErrorFilter] = useState<string>("all");
  const [errorSearch, setErrorSearch] = useState<string>("");
  const [proxyStatusFilter, setProxyStatusFilter] = useState<string>("all");
  const [showSlowRequests, setShowSlowRequests] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);

  // Calculate error analytics
  const errorAnalytics = useMemo(() => {
    const routeCounts = new Map<string, number>();
    const messageCounts = new Map<string, number>();
    const dailyCounts = new Map<string, number>();

    errors.forEach((error) => {
      const route = error.route || "unknown";
      routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
      
      const messageKey = error.message.substring(0, 100);
      messageCounts.set(messageKey, (messageCounts.get(messageKey) || 0) + 1);
      
      const date = new Date(error.createdAt).toISOString().slice(0, 10);
      dailyCounts.set(date, (dailyCounts.get(date) || 0) + 1);
    });

    const mostCommonRoute = Array.from(routeCounts.entries())
      .sort((a, b) => b[1] - a[1])[0] || ["none", 0];
    const mostCommonMessage = Array.from(messageCounts.entries())
      .sort((a, b) => b[1] - a[1])[0] || ["none", 0];

    return {
      total: errors.length,
      mostCommonRoute: { route: mostCommonRoute[0], count: mostCommonRoute[1] },
      mostCommonMessage: { message: mostCommonMessage[0], count: mostCommonMessage[1] },
      dailyCounts: Array.from(dailyCounts.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [errors]);

  // Filter errors
  const filteredErrors = useMemo(() => {
    let filtered = errors;

    if (errorFilter !== "all") {
      filtered = filtered.filter((e) => e.route === errorFilter);
    }

    if (errorSearch.trim()) {
      const searchLower = errorSearch.toLowerCase();
      filtered = filtered.filter((e) =>
        e.message.toLowerCase().includes(searchLower) ||
        e.route?.toLowerCase().includes(searchLower) ||
        e.requestId.toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }, [errors, errorFilter, errorSearch]);

  // Filter proxy logs
  const filteredProxyLogs = useMemo(() => {
    let filtered = proxyLogs;

    if (proxyStatusFilter === "4xx") {
      filtered = filtered.filter((l) => l.status >= 400 && l.status < 500);
    } else if (proxyStatusFilter === "5xx") {
      filtered = filtered.filter((l) => l.status >= 500);
    } else if (proxyStatusFilter === "slow") {
      filtered = filtered.filter((l) => l.durationMs > 1000);
    }

    if (showSlowRequests) {
      filtered = filtered.filter((l) => l.durationMs > 1000);
    }

    return filtered;
  }, [proxyLogs, proxyStatusFilter, showSlowRequests]);

  // Calculate proxy analytics
  const proxyAnalytics = useMemo(() => {
    const statusCounts = new Map<number, number>();
    const slowRequests = proxyLogs.filter((l) => l.durationMs > 1000).length;
    let totalDuration = 0;

    proxyLogs.forEach((log) => {
      statusCounts.set(log.status, (statusCounts.get(log.status) || 0) + 1);
      totalDuration += log.durationMs;
    });

    const avgDuration = proxyLogs.length > 0 ? totalDuration / proxyLogs.length : 0;
    const p95Duration = proxyLogs.length > 0
      ? [...proxyLogs].sort((a, b) => b.durationMs - a.durationMs)[Math.floor(proxyLogs.length * 0.05)]?.durationMs || 0
      : 0;

    return {
      total: proxyLogs.length,
      slowRequests,
      avgDuration: Math.round(avgDuration),
      p95Duration,
      statusCounts: Array.from(statusCounts.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
    };
  }, [proxyLogs]);

  const handleCopyDebugBundle = async () => {
    const debugData = {
      errors: filteredErrors.map((e) => ({
        id: e.id,
        requestId: e.requestId,
        route: e.route,
        message: e.message,
        stack: e.stack,
        contextJson: e.contextJson ? JSON.parse(e.contextJson) : null,
        createdAt: e.createdAt.toISOString(),
      })),
      proxyLogs: filteredProxyLogs.map((l) => ({
        id: l.id,
        requestId: l.requestId,
        route: l.route,
        status: l.status,
        durationMs: l.durationMs,
        createdAt: l.createdAt.toISOString(),
      })),
      analytics: {
        errors: errorAnalytics,
        proxy: proxyAnalytics,
      },
      exportedAt: new Date().toISOString(),
      shopDomain: window.location.hostname,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy debug bundle:", error);
    }
  };

  // Get unique routes for filter
  const uniqueRoutes = useMemo(() => {
    const routes = new Set<string>();
    errors.forEach((e) => {
      if (e.route) routes.add(e.route);
    });
    return Array.from(routes).sort();
  }, [errors]);

  return (
    <s-page heading="Diagnostics">
      <s-section>
        <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
          <div style={{ marginBottom: "2rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h1 style={{ margin: "0 0 0.5rem 0", color: "#0B0B0F" }}>Diagnostics</h1>
              <p style={{ margin: 0, color: "rgba(11,11,15,0.62)" }}>
                View error logs and app proxy request logs for debugging
              </p>
            </div>
            <button
              onClick={handleCopyDebugBundle}
              style={{
                padding: "0.75rem 1.5rem",
                background: copied ? "#10B981" : "#7C3AED",
                color: "#FFFFFF",
                border: "none",
                borderRadius: "8px",
                fontWeight: "500",
                cursor: "pointer",
              }}
            >
              {copied ? "✓ Copied!" : "Copy Debug Bundle"}
            </button>
          </div>

          {/* Error Analytics */}
          {errors.length > 0 && (
            <div style={{ marginBottom: "2rem" }}>
              <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Error Analytics</h2>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "1rem",
                marginBottom: "1rem",
              }}>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Total Errors</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#EF4444" }}>{errorAnalytics.total}</div>
                </div>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Most Common Route</div>
                  <div style={{ fontSize: "1rem", fontWeight: "500", color: "#0B0B0F" }}>
                    {errorAnalytics.mostCommonRoute.route} ({errorAnalytics.mostCommonRoute.count})
                  </div>
                </div>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Most Common Error</div>
                  <div style={{ fontSize: "0.875rem", fontWeight: "500", color: "#0B0B0F", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {errorAnalytics.mostCommonMessage.message.substring(0, 50)}... ({errorAnalytics.mostCommonMessage.count})
                  </div>
                </div>
              </div>
              {errorAnalytics.dailyCounts.length > 0 && (
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.75rem", fontWeight: "500" }}>
                    Error Frequency (Last 30 Days)
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", height: "120px", overflowX: "auto" }}>
                    {errorAnalytics.dailyCounts.map((day, idx) => {
                      const maxCount = Math.max(...errorAnalytics.dailyCounts.map(d => d.count), 1);
                      const heightPercent = (day.count / maxCount) * 100;
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
                              backgroundColor: "#EF4444",
                              borderRadius: "4px 4px 0 0",
                              transition: "all 0.3s",
                            }}
                            title={`${day.date}: ${day.count} errors`}
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
              )}
            </div>
          )}

          {/* Errors Table */}
          <div style={{ marginBottom: "3rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 style={{ margin: 0, color: "#0B0B0F" }}>Recent Errors ({filteredErrors.length})</h2>
            </div>
            
            {/* Error Filtering */}
            <div style={{
              display: "flex",
              gap: "1rem",
              marginBottom: "1rem",
              flexWrap: "wrap",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "1", minWidth: "200px" }}>
                <label style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", fontWeight: "500", whiteSpace: "nowrap" }}>
                  Filter by Route:
                </label>
                <select
                  value={errorFilter}
                  onChange={(e) => setErrorFilter(e.target.value)}
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
                  <option value="all">All Routes</option>
                  {uniqueRoutes.map((route) => (
                    <option key={route} value={route}>{route}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "1", minWidth: "200px" }}>
                <label style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", fontWeight: "500", whiteSpace: "nowrap" }}>
                  Search:
                </label>
                <input
                  type="text"
                  value={errorSearch}
                  onChange={(e) => setErrorSearch(e.target.value)}
                  placeholder="Search by message, route, request ID..."
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
            <div
              style={{
                backgroundColor: "#FFFFFF",
                border: "1px solid rgba(11,11,15,0.12)",
                borderRadius: "12px",
                overflow: "hidden",
                boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ backgroundColor: "#F9FAFB" }}>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Time
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Request ID
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Route
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Message
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredErrors.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "2rem", textAlign: "center", color: "rgba(11,11,15,0.62)" }}>
                        No errors found matching your filters
                      </td>
                    </tr>
                  ) : (
                    filteredErrors.map((error, idx) => (
                      <tr
                        key={error.id}
                        style={{
                          backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                        }}
                      >
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          {new Date(error.createdAt).toLocaleString()}
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontFamily: "monospace",
                            fontSize: "0.875rem",
                          }}
                        >
                          {error.requestId.substring(0, 8)}...
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          {error.route || "-"}
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          <div
                            style={{
                              maxWidth: "500px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: selectedError === error.id ? "normal" : "nowrap",
                            }}
                            title={error.message}
                          >
                            {error.message}
                          </div>
                          {error.stack && (
                            <details style={{ marginTop: "0.5rem" }} open={selectedError === error.id}>
                              <summary
                                style={{ cursor: "pointer", color: "#7C3AED", fontSize: "0.75rem" }}
                                onClick={() => setSelectedError(selectedError === error.id ? null : error.id)}
                              >
                                Stack trace
                              </summary>
                              <pre
                                style={{
                                  marginTop: "0.5rem",
                                  padding: "0.5rem",
                                  backgroundColor: "#F9FAFB",
                                  borderRadius: "4px",
                                  fontSize: "0.75rem",
                                  overflow: "auto",
                                  maxHeight: "200px",
                                }}
                              >
                                {error.stack}
                              </pre>
                            </details>
                          )}
                          {error.contextJson && (
                            <details style={{ marginTop: "0.5rem" }} open={selectedError === error.id}>
                              <summary
                                style={{ cursor: "pointer", color: "#7C3AED", fontSize: "0.75rem" }}
                                onClick={() => setSelectedError(selectedError === error.id ? null : error.id)}
                              >
                                Context
                              </summary>
                              <pre
                                style={{
                                  marginTop: "0.5rem",
                                  padding: "0.5rem",
                                  backgroundColor: "#F9FAFB",
                                  borderRadius: "4px",
                                  fontSize: "0.75rem",
                                  overflow: "auto",
                                  maxHeight: "200px",
                                }}
                              >
                                {JSON.stringify(JSON.parse(error.contextJson), null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Proxy Analytics */}
          {proxyLogs.length > 0 && (
            <div style={{ marginBottom: "2rem" }}>
              <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Proxy Log Analytics</h2>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "1rem",
                marginBottom: "1rem",
              }}>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Total Requests</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#7C3AED" }}>{proxyAnalytics.total}</div>
                </div>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Slow Requests (&gt;1s)</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: proxyAnalytics.slowRequests > 0 ? "#EF4444" : "#10B981" }}>
                    {proxyAnalytics.slowRequests}
                  </div>
                </div>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>Avg Duration</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{proxyAnalytics.avgDuration}ms</div>
                </div>
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.25rem" }}>P95 Duration</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: "#0B0B0F" }}>{proxyAnalytics.p95Duration}ms</div>
                </div>
              </div>
              {proxyAnalytics.statusCounts.length > 0 && (
                <div style={{
                  padding: "1rem",
                  backgroundColor: "#FFFFFF",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
                }}>
                  <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginBottom: "0.75rem", fontWeight: "500" }}>
                    Status Code Distribution
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {proxyAnalytics.statusCounts.map(({ status, count }) => (
                      <div
                        key={status}
                        style={{
                          padding: "0.5rem 0.75rem",
                          backgroundColor: status >= 500 ? "#FEE2E2" : status >= 400 ? "#FEF3C7" : "#D1FAE5",
                          color: status >= 500 ? "#991B1B" : status >= 400 ? "#92400E" : "#065F46",
                          borderRadius: "6px",
                          fontSize: "0.875rem",
                          fontWeight: "500",
                        }}
                      >
                        {status}: {count}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Proxy Logs Table */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 style={{ margin: 0, color: "#0B0B0F" }}>App Proxy Logs ({filteredProxyLogs.length})</h2>
            </div>
            
            {/* Proxy Log Filtering */}
            <div style={{
              display: "flex",
              gap: "1rem",
              marginBottom: "1rem",
              flexWrap: "wrap",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "1", minWidth: "200px" }}>
                <label style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", fontWeight: "500", whiteSpace: "nowrap" }}>
                  Filter by Status:
                </label>
                <select
                  value={proxyStatusFilter}
                  onChange={(e) => setProxyStatusFilter(e.target.value)}
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
                  <option value="all">All Status Codes</option>
                  <option value="4xx">4xx (Client Errors)</option>
                  <option value="5xx">5xx (Server Errors)</option>
                  <option value="slow">Slow Requests (&gt;1s)</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  id="showSlow"
                  checked={showSlowRequests}
                  onChange={(e) => setShowSlowRequests(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <label htmlFor="showSlow" style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", cursor: "pointer" }}>
                  Show only slow requests (&gt;1s)
                </label>
              </div>
            </div>
            <div
              style={{
                backgroundColor: "#FFFFFF",
                border: "1px solid rgba(11,11,15,0.12)",
                borderRadius: "12px",
                overflow: "hidden",
                boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ backgroundColor: "#F9FAFB" }}>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Time
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Request ID
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Route
                    </th>
                    <th
                      style={{
                        textAlign: "right",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Status
                    </th>
                    <th
                      style={{
                        textAlign: "right",
                        borderBottom: "1px solid rgba(11,11,15,0.12)",
                        padding: "0.75rem 1rem",
                        fontWeight: "500",
                        color: "#0B0B0F",
                      }}
                    >
                      Duration (ms)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProxyLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: "2rem", textAlign: "center", color: "rgba(11,11,15,0.62)" }}>
                        No proxy logs found matching your filters
                      </td>
                    </tr>
                  ) : (
                    filteredProxyLogs.map((log, idx) => (
                      <tr
                        key={log.id}
                        style={{
                          backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                        }}
                      >
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontFamily: "monospace",
                            fontSize: "0.875rem",
                          }}
                        >
                          {log.requestId.substring(0, 8)}...
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          {log.route}
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            textAlign: "right",
                            color: log.status >= 500 ? "#EF4444" : log.status >= 400 ? "#F59E0B" : "#10B981",
                            fontWeight: "500",
                            fontSize: "0.875rem",
                          }}
                        >
                          {log.status}
                        </td>
                        <td
                          style={{
                            borderBottom: "1px solid rgba(11,11,15,0.08)",
                            padding: "0.75rem 1rem",
                            textAlign: "right",
                            color: log.durationMs > 1000 ? "#EF4444" : log.durationMs > 500 ? "#F59E0B" : "#0B0B0F",
                            fontWeight: log.durationMs > 1000 ? "bold" : "normal",
                            fontSize: "0.875rem",
                          }}
                        >
                          {log.durationMs}ms
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

