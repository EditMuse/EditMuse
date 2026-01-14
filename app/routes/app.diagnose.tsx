import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { useState } from "react";

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

  const handleCopyDebugBundle = async () => {
    const debugData = {
      errors: errors.map((e) => ({
        id: e.id,
        requestId: e.requestId,
        route: e.route,
        message: e.message,
        stack: e.stack,
        contextJson: e.contextJson ? JSON.parse(e.contextJson) : null,
        createdAt: e.createdAt.toISOString(),
      })),
      proxyLogs: proxyLogs.map((l) => ({
        id: l.id,
        requestId: l.requestId,
        route: l.route,
        status: l.status,
        durationMs: l.durationMs,
        createdAt: l.createdAt.toISOString(),
      })),
      exportedAt: new Date().toISOString(),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy debug bundle:", error);
    }
  };

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

          {/* Errors Table */}
          <div style={{ marginBottom: "3rem" }}>
            <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>Recent Errors ({errors.length})</h2>
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
                  {errors.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "2rem", textAlign: "center", color: "rgba(11,11,15,0.62)" }}>
                        No errors found
                      </td>
                    </tr>
                  ) : (
                    errors.map((error, idx) => (
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
                              whiteSpace: "nowrap",
                            }}
                            title={error.message}
                          >
                            {error.message}
                          </div>
                          {error.stack && (
                            <details style={{ marginTop: "0.5rem" }}>
                              <summary style={{ cursor: "pointer", color: "#7C3AED", fontSize: "0.75rem" }}>
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
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Proxy Logs Table */}
          <div>
            <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>App Proxy Logs ({proxyLogs.length})</h2>
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
                  {proxyLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: "2rem", textAlign: "center", color: "rgba(11,11,15,0.62)" }}>
                        No proxy logs found
                      </td>
                    </tr>
                  ) : (
                    proxyLogs.map((log, idx) => (
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
                            color: "#0B0B0F",
                            fontSize: "0.875rem",
                          }}
                        >
                          {log.durationMs}
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

