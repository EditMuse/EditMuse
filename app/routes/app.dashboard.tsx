import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType, ConciergeSessionStatus } from "@prisma/client";
import { getOfflineAccessTokenForShop } from "~/shopify-admin.server";
import { fetchShopifyProductsByHandlesGraphQL } from "~/shopify-admin.server";

function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type DashboardData = {
  from: string;
  to: string;
  metrics: {
    sessions: number;
    resultsGenerated: number;
    productClicked: number;
    addToCartClicked: number;
    checkoutStarted: number;
    ordersAttributedDirect: number;
    ordersAttributedAssisted: number;
    revenue: number;
  };
  funnel: Array<{
    step: string;
    count: number;
    conversionPercent: number | null;
  }>;
  topQueries: Array<{
    query: string;
    sessions: number;
    revenue: number;
    conversionRate: number;
  }>;
  topProducts: Array<{
    handle: string;
    title: string;
    recommendedCount: number;
    clicks: number;
    addToCart: number;
    directOrdersCount: number;
    directRevenue: number;
    assistedOrdersCount: number;
    assistedRevenue: number;
    inStock: boolean;
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

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const toDate = to ? new Date(to) : new Date();
  toDate.setHours(23, 59, 59, 999);
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  fromDate.setHours(0, 0, 0, 0);

  // Fetch sessions in date range
  const sessions = await prisma.conciergeSession.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: fromDate, lte: toDate },
    },
    include: {
      result: true,
    },
  });

  // Fetch usage events in date range
  const events = await prisma.usageEvent.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: fromDate, lte: toDate },
    },
    orderBy: { createdAt: "desc" },
  });

  // Fetch order attributions in date range
  const orderAttributions = await prisma.orderAttribution.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: fromDate, lte: toDate },
    },
  });

  // Calculate metrics
  const sessionsCount = sessions.length;
  const resultsGenerated =
    events.filter((e) => e.eventType === UsageEventType.AI_RANKING_EXECUTED)
      .length || sessions.filter((s) => s.result).length;
  const productClicked = events.filter(
    (e) => e.eventType === UsageEventType.RECOMMENDATION_CLICKED
  ).length;
  const addToCartClicked = events.filter(
    (e) => e.eventType === UsageEventType.ADD_TO_CART_CLICKED
  ).length;
  const checkoutStarted = events.filter(
    (e) => e.eventType === UsageEventType.CHECKOUT_STARTED
  ).length;
  const ordersAttributedDirect = orderAttributions.filter(
    (o) => o.attributionType === "direct"
  ).length;
  const ordersAttributedAssisted = orderAttributions.filter(
    (o) => o.attributionType === "assisted"
  ).length;
  
  // Calculate revenue from order attributions (sum of all attributed orders)
  let revenue = 0;
  for (const order of orderAttributions) {
    const price = parseFloat(order.totalPrice || "0");
    if (!isNaN(price)) {
      revenue += price;
    }
  }

  // Build funnel
  const funnelSteps = [
    {
      step: "Sessions Started",
      count: events.filter((e) => e.eventType === UsageEventType.SESSION_STARTED)
        .length,
    },
    {
      step: "Results Generated",
      count: resultsGenerated,
    },
    {
      step: "Results Viewed",
      count: events.filter(
        (e) => e.eventType === UsageEventType.RESULTS_VIEWED
      ).length,
    },
    {
      step: "Product Clicked",
      count: productClicked,
    },
    {
      step: "Add to Cart",
      count: addToCartClicked,
    },
    {
      step: "Checkout Started",
      count: checkoutStarted,
    },
  ];

  const funnel = funnelSteps.map((step, index) => {
    const prevCount = index > 0 ? funnelSteps[index - 1].count : step.count;
    const conversionPercent =
      prevCount > 0 ? (step.count / prevCount) * 100 : null;
    return {
      ...step,
      conversionPercent,
    };
  });

  // Build session ID to order attributions map for revenue/conversion tracking
  const sessionOrdersMap = new Map<string, typeof orderAttributions>();
  for (const order of orderAttributions) {
    if (order.sessionId) {
      if (!sessionOrdersMap.has(order.sessionId)) {
        sessionOrdersMap.set(order.sessionId, []);
      }
      sessionOrdersMap.get(order.sessionId)!.push(order);
    }
  }

  // Build top queries from queryNormalized (grouping) and queryRaw (display)
  const queryMap = new Map<
    string,
    { 
      sessions: Set<string>; 
      revenue: number; 
      conversions: number;
      rawQueries: Map<string, number>; // Track most common raw form per normalized query
    }
  >();

  for (const session of sessions) {
    // Use queryNormalized if available, otherwise fall back to extracting from answersJson
    let queryNormalized: string | null = session.queryNormalized;
    let queryRaw: string | null = session.queryRaw;

    // Fallback: extract from answersJson if queryNormalized is null
    if (!queryNormalized) {
      try {
        const answers = safeJson(session.answersJson);
        if (Array.isArray(answers) && answers.length > 0) {
          const queryText = answers
            .map((a: any) => {
              if (typeof a === "string") return a;
              if (a.question && a.answer)
                return `${a.question}: ${a.answer}`;
              if (a.text) return a.text;
              return JSON.stringify(a);
            })
            .join(" ")
            .trim();

          if (queryText) {
            queryRaw = queryText;
            queryNormalized = queryText.toLowerCase().trim();
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }

    if (queryNormalized) {
      if (!queryMap.has(queryNormalized)) {
        queryMap.set(queryNormalized, {
          sessions: new Set(),
          revenue: 0,
          conversions: 0,
          rawQueries: new Map(),
        });
      }
      const entry = queryMap.get(queryNormalized)!;
      entry.sessions.add(session.id);
      
      // Track raw query (for displaying most common form)
      if (queryRaw) {
        const count = entry.rawQueries.get(queryRaw) || 0;
        entry.rawQueries.set(queryRaw, count + 1);
      }
      
      // Calculate revenue and conversions from order attributions
      const sessionOrders = sessionOrdersMap.get(session.id) || [];
      for (const order of sessionOrders) {
        const price = parseFloat(order.totalPrice || "0");
        if (!isNaN(price)) {
          entry.revenue += price;
        }
        if (order.attributionType === "direct") {
          entry.conversions += 1;
        }
      }
    }
  }

  const topQueries = Array.from(queryMap.entries())
    .map(([normalizedQuery, data]) => {
      // Find most common raw query for this normalized query
      let mostCommonRaw = normalizedQuery;
      let maxCount = 0;
      for (const [raw, count] of data.rawQueries.entries()) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonRaw = raw;
        }
      }
      
      return {
        query: mostCommonRaw.substring(0, 100), // Limit length, use most common raw form
        sessions: data.sessions.size,
        revenue: data.revenue,
        conversionRate: data.sessions.size > 0 ? data.conversions / data.sessions.size : 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20);

  // Build top products from ConciergeResult and events
  const productHandleMap = new Map<
    string,
    {
      recommendedCount: number;
      clicks: number;
      addToCart: number;
      attributedOrders: number;
      revenue: number;
    }
  >();

  // Count recommendations from ConciergeResult
  for (const session of sessions) {
    if (session.result) {
      try {
        const handles = Array.isArray(session.result.productHandles)
          ? session.result.productHandles
          : [];
        for (const handle of handles) {
          if (typeof handle === "string") {
            if (!productHandleMap.has(handle)) {
              productHandleMap.set(handle, {
                recommendedCount: 0,
                clicks: 0,
                addToCart: 0,
                directOrdersCount: 0,
                directRevenue: 0,
                assistedOrdersCount: 0,
                assistedRevenue: 0,
              });
            }
            productHandleMap.get(handle)!.recommendedCount++;
          }
        }
      } catch (e) {
        // Skip invalid data
      }
    }
  }

  // Count clicks and ATC from events
  for (const event of events) {
    const metadata = safeJson(event.metadata);
    if (metadata?.handle && typeof metadata.handle === "string") {
      const handle = metadata.handle;
      if (!productHandleMap.has(handle)) {
        productHandleMap.set(handle, {
          recommendedCount: 0,
          clicks: 0,
          addToCart: 0,
          directOrdersCount: 0,
          directRevenue: 0,
          assistedOrdersCount: 0,
          assistedRevenue: 0,
        });
      }
      const product = productHandleMap.get(handle)!;

      if (event.eventType === UsageEventType.RECOMMENDATION_CLICKED) {
        product.clicks++;
      } else if (event.eventType === UsageEventType.ADD_TO_CART_CLICKED) {
        product.addToCart++;
      }
    }
  }

  // Calculate assisted orders and revenue for products (session-level attribution only)
  // Note: We cannot reliably map products to order line items, so we do NOT attribute direct product revenue
  // Direct product attribution would require matching product handles/variants to order line items,
  // which we don't have in the current OrderAttribution model.
  const productSessionMap = new Map<string, Set<string>>(); // handle -> sessionIds that recommended it
  for (const session of sessions) {
    if (session.result) {
      try {
        const handles = Array.isArray(session.result.productHandles)
          ? session.result.productHandles
          : [];
        for (const handle of handles) {
          if (typeof handle === "string") {
            if (!productSessionMap.has(handle)) {
              productSessionMap.set(handle, new Set());
            }
            productSessionMap.get(handle)!.add(session.id);
          }
        }
      } catch (e) {
        // Skip invalid data
      }
    }
  }

  // Calculate assisted orders and revenue per product (session-level only)
  // Direct metrics remain 0 since we cannot map products to order line items
  for (const [handle, sessionIds] of productSessionMap.entries()) {
    if (productHandleMap.has(handle)) {
      const product = productHandleMap.get(handle)!;
      for (const sessionId of sessionIds) {
        const sessionOrders = sessionOrdersMap.get(sessionId) || [];
        for (const order of sessionOrders) {
          // Only count assisted metrics at session level
          // Direct metrics require product -> order line item mapping which we don't have
          if (order.attributionType === "assisted" || order.attributionType === "direct") {
            product.assistedOrdersCount++;
            const price = parseFloat(order.totalPrice || "0");
            if (!isNaN(price)) {
              product.assistedRevenue += price;
            }
          }
        }
      }
    }
  }

  // Fetch product details for top products
  const topProductHandles = Array.from(productHandleMap.entries())
    .sort((a, b) => b[1].recommendedCount - a[1].recommendedCount)
    .slice(0, 50)
    .map(([handle]) => handle);

  let productDetailsMap = new Map<
    string,
    { title: string; inStock: boolean }
  >();

  if (topProductHandles.length > 0) {
    try {
      const accessToken = await getOfflineAccessTokenForShop(shop.domain);
      if (accessToken) {
        const products = await fetchShopifyProductsByHandlesGraphQL({
          shopDomain: shop.domain,
          accessToken,
          handles: topProductHandles,
        });

        for (const product of products) {
          productDetailsMap.set(product.handle, {
            title: product.title,
            inStock: product.available,
          });
        }
      }
    } catch (e) {
      console.error("[Dashboard] Error fetching product details:", e);
    }
  }

  const topProducts = Array.from(productHandleMap.entries())
    .map(([handle, stats]) => ({
      handle,
      title: productDetailsMap.get(handle)?.title || handle,
      recommendedCount: stats.recommendedCount,
      clicks: stats.clicks,
      addToCart: stats.addToCart,
      directOrdersCount: stats.directOrdersCount, // Always 0 - we cannot map products to order line items
      directRevenue: stats.directRevenue, // Always 0 - we cannot map products to order line items
      assistedOrdersCount: stats.assistedOrdersCount,
      assistedRevenue: stats.assistedRevenue,
      inStock: productDetailsMap.get(handle)?.inStock ?? true,
    }))
    .sort((a, b) => b.recommendedCount - a.recommendedCount)
    .slice(0, 50);

  const data: DashboardData = {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    metrics: {
      sessions: sessionsCount,
      resultsGenerated,
      productClicked,
      addToCartClicked,
      checkoutStarted,
      ordersAttributedDirect,
      ordersAttributedAssisted,
      revenue,
    },
    funnel,
    topQueries,
    topProducts,
  };

  return data;
};

export default function DashboardPage() {
  const data = useLoaderData<DashboardData>();

  return (
    <s-page heading="Dashboard">
      <s-section>
        <div style={{ marginBottom: "1.5rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1rem",
            }}
          >
            <p style={{ color: "rgba(11,11,15,0.62)", fontSize: "0.875rem" }}>
              Range: <strong style={{ color: "#0B0B0F" }}>{data.from}</strong> →{" "}
              <strong style={{ color: "#0B0B0F" }}>{data.to}</strong>
            </p>
            <a
              href={`/app/dashboard.csv?from=${data.from}&to=${data.to}`}
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
              }}
            >
              Export CSV
            </a>
          </div>

          {/* KPI Cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
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
                Sessions
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#7C3AED",
                }}
              >
                {data.metrics.sessions.toLocaleString()}
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
                Results Generated
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#06B6D4",
                }}
              >
                {data.metrics.resultsGenerated.toLocaleString()}
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
                Product Clicks
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#0B0B0F",
                }}
              >
                {data.metrics.productClicked.toLocaleString()}
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
                Add to Cart
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#0B0B0F",
                }}
              >
                {data.metrics.addToCartClicked.toLocaleString()}
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
                Revenue
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#10B981",
                }}
              >
                ${data.metrics.revenue.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Funnel Table */}
          <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>
            Conversion Funnel
          </h2>
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              overflow: "hidden",
              marginBottom: "2rem",
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
                    Step
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
                    Count
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
                    Conversion %
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.funnel.map((step, idx) => (
                  <tr
                    key={idx}
                    style={{
                      backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                    }}
                  >
                    <td
                      style={{
                        borderBottom: "1px solid rgba(11,11,15,0.08)",
                        padding: "0.75rem 1rem",
                        color: "#0B0B0F",
                      }}
                    >
                      {step.step}
                    </td>
                    <td
                      style={{
                        borderBottom: "1px solid rgba(11,11,15,0.08)",
                        padding: "0.75rem 1rem",
                        textAlign: "right",
                        color: "#0B0B0F",
                        fontWeight: "500",
                      }}
                    >
                      {step.count.toLocaleString()}
                    </td>
                    <td
                      style={{
                        borderBottom: "1px solid rgba(11,11,15,0.08)",
                        padding: "0.75rem 1rem",
                        textAlign: "right",
                        color: "#0B0B0F",
                      }}
                    >
                      {step.conversionPercent === null
                        ? "—"
                        : step.conversionPercent.toFixed(1) + "%"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Top Queries Table */}
          <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>
            Top Queries
          </h2>
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              overflow: "hidden",
              marginBottom: "2rem",
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
                    Query
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
                    Sessions
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
                    Revenue
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
                    Conversion %
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.topQueries.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      style={{
                        padding: "2rem",
                        textAlign: "center",
                        color: "rgba(11,11,15,0.62)",
                      }}
                    >
                      No queries found
                    </td>
                  </tr>
                ) : (
                  data.topQueries.map((query, idx) => (
                    <tr
                      key={idx}
                      style={{
                        backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                      }}
                    >
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          color: "#0B0B0F",
                        }}
                      >
                        {query.query}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                          fontWeight: "500",
                        }}
                      >
                        {query.sessions.toLocaleString()}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        ${query.revenue.toFixed(2)}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        {(query.conversionRate * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Top Products Table */}
          <h2 style={{ marginBottom: "1rem", color: "#0B0B0F" }}>
            Top Recommended Products
          </h2>
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              overflow: "hidden",
              marginBottom: "2rem",
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
                    Product
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
                    Recommended
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
                    Clicks
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
                    Add to Cart
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
                    Assisted Orders
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
                    Assisted Revenue
                  </th>
                  <th
                    style={{
                      textAlign: "center",
                      borderBottom: "1px solid rgba(11,11,15,0.12)",
                      padding: "0.75rem 1rem",
                      fontWeight: "500",
                      color: "#0B0B0F",
                    }}
                  >
                    Stock
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        padding: "2rem",
                        textAlign: "center",
                        color: "rgba(11,11,15,0.62)",
                      }}
                    >
                      No products found
                    </td>
                  </tr>
                ) : (
                  data.topProducts.map((product, idx) => (
                    <tr
                      key={idx}
                      style={{
                        backgroundColor: idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB",
                      }}
                    >
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          color: "#0B0B0F",
                        }}
                      >
                        {product.title}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                          fontWeight: "500",
                        }}
                      >
                        {product.recommendedCount.toLocaleString()}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        {product.clicks.toLocaleString()}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        {product.addToCart.toLocaleString()}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        {product.assistedOrdersCount.toLocaleString()}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                          color: "#0B0B0F",
                        }}
                      >
                        ${product.assistedRevenue.toFixed(2)}
                      </td>
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "center",
                        }}
                      >
                        {product.inStock ? (
                          <span
                            style={{
                              padding: "0.25rem 0.5rem",
                              borderRadius: "4px",
                              backgroundColor: "#D1FAE5",
                              color: "#065F46",
                              fontSize: "0.75rem",
                              fontWeight: "500",
                            }}
                          >
                            In Stock
                          </span>
                        ) : (
                          <span
                            style={{
                              padding: "0.25rem 0.5rem",
                              borderRadius: "4px",
                              backgroundColor: "#FEE2E2",
                              color: "#991B1B",
                              fontSize: "0.75rem",
                              fontWeight: "500",
                            }}
                          >
                            Out of Stock
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

