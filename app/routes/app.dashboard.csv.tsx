import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType } from "@prisma/client";
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

  // Fetch sessions and events (same logic as dashboard)
  const sessions = await prisma.conciergeSession.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: fromDate, lte: toDate },
    },
    include: {
      result: true,
    },
  });

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

  // Build CSV rows
  const rows: string[] = [];

  // Header
  rows.push(
    "Date Range,From,To,Sessions,Results Generated,Product Clicks,Add to Cart Clicks,Checkout Started,Orders Attributed (Direct),Orders Attributed (Assisted),Revenue"
  );

  // Metrics row
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
  
  // Calculate revenue from order attributions
  let revenue = 0;
  for (const order of orderAttributions) {
    const price = parseFloat(order.totalPrice || "0");
    if (!isNaN(price)) {
      revenue += price;
    }
  }

  rows.push(
    [
      `${fromDate.toISOString().slice(0, 10)} to ${toDate.toISOString().slice(0, 10)}`,
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10),
      sessionsCount,
      resultsGenerated,
      productClicked,
      addToCartClicked,
      checkoutStarted,
      ordersAttributedDirect,
      ordersAttributedAssisted,
      revenue.toFixed(2),
    ].join(",")
  );

  // Funnel section
  rows.push("");
  rows.push("Funnel,Step,Count,Conversion %");
  const funnelSteps = [
    {
      step: "Sessions Started",
      count: events.filter(
        (e) => e.eventType === UsageEventType.SESSION_STARTED
      ).length,
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

  funnelSteps.forEach((step, index) => {
    const prevCount = index > 0 ? funnelSteps[index - 1].count : step.count;
    const conversionPercent =
      prevCount > 0 ? (step.count / prevCount) * 100 : 0;
    rows.push(
      `,${step.step},${step.count},${conversionPercent.toFixed(1)}%`
    );
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

  // Top Queries section
  rows.push("");
  rows.push("Top Queries,Query,Sessions,Revenue,Conversion %");

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
              if (a.question && a.answer) return `${a.question}: ${a.answer}`;
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
        query: mostCommonRaw.substring(0, 200).replace(/"/g, '""'), // CSV escape, use most common raw form
        sessions: data.sessions.size,
        revenue: data.revenue,
        conversionRate: data.sessions.size > 0 ? data.conversions / data.sessions.size : 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 50);

  topQueries.forEach((q) => {
    rows.push(
      `,"${q.query}",${q.sessions},${q.revenue.toFixed(2)},${(q.conversionRate * 100).toFixed(1)}%`
    );
  });

  // Top Products section
  rows.push("");
  rows.push(
    "Top Products,Product,Recommended,Clicks,Add to Cart,Direct Orders,Direct Revenue,Assisted Orders,Assisted Revenue,In Stock"
  );

  const productHandleMap = new Map<
    string,
    {
      recommendedCount: number;
      clicks: number;
      addToCart: number;
      directOrdersCount: number;
      directRevenue: number;
      assistedOrdersCount: number;
      assistedRevenue: number;
    }
  >();

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
        // Skip
      }
    }
  }

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

  const topProductHandles = Array.from(productHandleMap.entries())
    .sort((a, b) => b[1].recommendedCount - a[1].recommendedCount)
    .slice(0, 50)
    .map(([handle]) => handle);

  let productDetailsMap = new Map<string, { title: string; inStock: boolean }>();

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
      // Skip if product fetch fails
    }
  }

  const topProducts = Array.from(productHandleMap.entries())
    .map(([handle, stats]) => ({
      handle,
      title: (productDetailsMap.get(handle)?.title || handle).replace(/"/g, '""'), // CSV escape
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

  topProducts.forEach((p) => {
    rows.push(
      `,"${p.title}",${p.recommendedCount},${p.clicks},${p.addToCart},${p.directOrdersCount},${p.directRevenue.toFixed(2)},${p.assistedOrdersCount},${p.assistedRevenue.toFixed(2)},${p.inStock ? "Yes" : "No"}`
    );
  });

  const csv = rows.join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="editmuse-dashboard-${fromDate.toISOString().slice(0, 10)}-${toDate.toISOString().slice(0, 10)}.csv"`,
    },
  });
};

