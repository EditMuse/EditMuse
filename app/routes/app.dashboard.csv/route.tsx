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

  // Build CSV rows (engagement analytics only - no order/customer data)
  const rows: string[] = [];

  // Header
  rows.push(
    "Date Range,From,To,Sessions,Results Generated,Product Clicks,Add to Cart Clicks,Checkout Started"
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
    // Note: Checkout Started and Order metrics removed for PCD Level 0 compliance
  ];

  funnelSteps.forEach((step, index) => {
    const prevCount = index > 0 ? funnelSteps[index - 1].count : step.count;
    const conversionPercent =
      prevCount > 0 ? (step.count / prevCount) * 100 : 0;
    rows.push(
      `,${step.step},${step.count},${conversionPercent.toFixed(1)}%`
    );
  });

  // Top Queries section (engagement analytics only)
  rows.push("");
  rows.push("Top Queries,Query,Sessions");

  // Build top queries from queryNormalized (grouping) and queryRaw (display)
  // Note: Revenue and conversion tracking removed for PCD Level 0 compliance
  const queryMap = new Map<
    string,
    { 
      sessions: Set<string>; 
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
      };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 50);

  topQueries.forEach((q) => {
    rows.push(
      `,"${q.query}",${q.sessions}`
    );
  });

  // Top Products section (engagement analytics only)
  rows.push("");
  rows.push(
    "Top Products,Product,Recommended,Clicks,Add to Cart,In Stock"
  );

  const productHandleMap = new Map<
    string,
    {
      recommendedCount: number;
      clicks: number;
      addToCart: number;
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
      inStock: productDetailsMap.get(handle)?.inStock ?? true,
    }))
    .sort((a, b) => b.recommendedCount - a.recommendedCount)
    .slice(0, 50);

  topProducts.forEach((p) => {
    rows.push(
      `,"${p.title}",${p.recommendedCount},${p.clicks},${p.addToCart},${p.inStock ? "Yes" : "No"}`
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
