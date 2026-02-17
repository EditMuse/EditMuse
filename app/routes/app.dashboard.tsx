import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { UsageEventType, ConciergeSessionStatus } from "@prisma/client";
import { getOfflineAccessTokenForShop } from "~/shopify-admin.server";
import { fetchShopifyProductsByHandlesGraphQL } from "~/shopify-admin.server";
import { useState, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useNavigation, useRevalidator } from "react-router";
import { showToast } from "~/components/Toast";
import { LoadingSkeleton, TableSkeleton } from "~/components/LoadingSkeleton";

function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type DashboardData = {
  shopDomain: string;
  from: string;
  to: string;
  metrics: {
    sessions: number;
    resultsGenerated: number;
    productClicked: number;
    addToCartClicked: number;
    checkoutStarted: number;
    ordersAttributedDirect: number; // Always 0 - removed for PCD Level 0 compliance
    ordersAttributedAssisted: number; // Always 0 - removed for PCD Level 0 compliance
    revenue: number; // Always 0 - removed for PCD Level 0 compliance
  };
  previousPeriodMetrics: {
    sessions: number;
    resultsGenerated: number;
    productClicked: number;
    addToCartClicked: number;
  };
  performanceMetrics: {
    avgResultsPerSession: number;
    sessionCompletionRate: number;
  };
  funnel: Array<{
    step: string;
    count: number;
    conversionPercent: number | null;
  }>;
  topQueries: Array<{
    query: string;
    sessions: number;
    noResultsCount?: number;
  }>;
  topProducts: Array<{
    handle: string;
    title: string;
    imageUrl?: string;
    recommendedCount: number;
    clicks: number;
    addToCart: number;
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

  // Calculate metrics (engagement analytics only - no order/customer data)
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

  // Build funnel (engagement analytics only - stops at Add to Cart)
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
    // Note: Add to Cart, Checkout Started and Order metrics removed for PCD Level 0 compliance
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
        query: mostCommonRaw.substring(0, 100), // Limit length, use most common raw form
        sessions: data.sessions.size,
      };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20);

  // Build top products from ConciergeResult and events (engagement analytics only)
  const productHandleMap = new Map<
    string,
    {
      recommendedCount: number;
      clicks: number;
      addToCart: number;
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

  // Count clicks and ATC from events (engagement analytics only)
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

  // Fetch product details for top products
  const topProductHandles = Array.from(productHandleMap.entries())
    .sort((a, b) => b[1].recommendedCount - a[1].recommendedCount)
    .slice(0, 50)
    .map(([handle]) => handle);

  let productDetailsMap = new Map<
    string,
    { title: string; inStock: boolean; imageUrl?: string }
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
            imageUrl: product.image || undefined,
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
      imageUrl: productDetailsMap.get(handle)?.imageUrl,
      recommendedCount: stats.recommendedCount,
      clicks: stats.clicks,
      addToCart: stats.addToCart,
      inStock: productDetailsMap.get(handle)?.inStock ?? true,
    }))
    .sort((a, b) => b.recommendedCount - a.recommendedCount)
    .slice(0, 50);

  // Calculate previous period metrics for comparison
  const periodDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
  const previousToDate = new Date(fromDate);
  previousToDate.setHours(23, 59, 59, 999);
  previousToDate.setDate(previousToDate.getDate() - 1);
  const previousFromDate = new Date(previousToDate);
  previousFromDate.setDate(previousFromDate.getDate() - periodDays);
  previousFromDate.setHours(0, 0, 0, 0);

  const previousSessions = await prisma.conciergeSession.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: previousFromDate, lte: previousToDate },
    },
    include: { result: true },
  });

  const previousEvents = await prisma.usageEvent.findMany({
    where: {
      shopId: shop.id,
      createdAt: { gte: previousFromDate, lte: previousToDate },
    },
  });

  const previousSessionsCount = previousSessions.length;
  const previousResultsGenerated =
    previousEvents.filter((e) => e.eventType === UsageEventType.AI_RANKING_EXECUTED).length ||
    previousSessions.filter((s) => s.result).length;
  const previousProductClicked = previousEvents.filter(
    (e) => e.eventType === UsageEventType.RECOMMENDATION_CLICKED
  ).length;
  const previousAddToCartClicked = previousEvents.filter(
    (e) => e.eventType === UsageEventType.ADD_TO_CART_CLICKED
  ).length;

  // Calculate performance metrics
  const sessionsWithResults = sessions.filter((s) => s.result).length;
  // Avg Results per Session = total number of products returned / total sessions
  const totalResultsCount = sessions
    .filter((s) => s.result && s.resultCount)
    .reduce((sum, s) => sum + (s.resultCount || 0), 0);
  const avgResultsPerSession = sessionsCount > 0 ? totalResultsCount / sessionsCount : 0;
  const sessionCompletionRate = sessionsCount > 0 ? (sessionsWithResults / sessionsCount) * 100 : 0;
  // Avg Clicks per Result = total clicks / total products returned (not result sets)
  const avgClicksPerResult = totalResultsCount > 0 ? productClicked / totalResultsCount : 0;

  const data: DashboardData = {
    shopDomain: shop.domain,
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    metrics: {
      sessions: sessionsCount,
      resultsGenerated,
      productClicked,
      addToCartClicked,
      checkoutStarted,
      ordersAttributedDirect: 0, // Removed for PCD Level 0 compliance
      ordersAttributedAssisted: 0, // Removed for PCD Level 0 compliance
      revenue: 0, // Removed for PCD Level 0 compliance
    },
    previousPeriodMetrics: {
      sessions: previousSessionsCount,
      resultsGenerated: previousResultsGenerated,
      productClicked: previousProductClicked,
      addToCartClicked: previousAddToCartClicked,
    },
    performanceMetrics: {
      avgResultsPerSession,
      sessionCompletionRate,
    },
    funnel,
    topQueries,
    topProducts,
  };

  return data;
};

// Helper function to calculate percentage change
function calculateChange(current: number, previous: number): { value: number; isPositive: boolean } | null {
  if (previous === 0) return current > 0 ? { value: 100, isPositive: true } : null;
  const change = ((current - previous) / previous) * 100;
  return { value: Math.abs(change), isPositive: change >= 0 };
}

export default function DashboardPage() {
  const data = useLoaderData<DashboardData>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const app = useAppBridge();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [fromDate, setFromDate] = useState(data.from);
  const [toDate, setToDate] = useState(data.to);
  const [preset, setPreset] = useState<string>("custom");
  const [isExporting, setIsExporting] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [topQueriesPage, setTopQueriesPage] = useState(1);
  const [topProductsPage, setTopProductsPage] = useState(1);
  const itemsPerPage = 10;

  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  // Auto-refresh functionality
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, [autoRefresh, revalidator]);

  // Paginated data
  const paginatedTopQueries = data.topQueries.slice(
    (topQueriesPage - 1) * itemsPerPage,
    topQueriesPage * itemsPerPage
  );
  const paginatedTopProducts = data.topProducts.slice(
    (topProductsPage - 1) * itemsPerPage,
    topProductsPage * itemsPerPage
  );
  const totalQueriesPages = Math.ceil(data.topQueries.length / itemsPerPage);
  const totalProductsPages = Math.ceil(data.topProducts.length / itemsPerPage);

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
    
    navigate(`/app/dashboard?from=${fromStr}&to=${to}`);
  };

  const handleDateChange = () => {
    if (fromDate && toDate) {
      navigate(`/app/dashboard?from=${fromDate}&to=${toDate}`);
    }
  };

  const handleExportCSV = async () => {
    if (isExporting) return;
    
    setIsExporting(true);
    try {
      const url = `/app/dashboard/export-csv?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`;
      
      // Use regular fetch with credentials for embedded app context
      const response = await fetch(url, { credentials: 'include' });
      
      if (!response.ok) {
        throw new Error(`Export failed: ${response.status} ${response.statusText}`);
      }
      
      const csvText = await response.text();
      
      // Create blob and trigger download
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const filename = `dashboard-${data.from}_to_${data.to}.csv`;
      
      // Create temporary anchor element and trigger download
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Clean up blob URL
      URL.revokeObjectURL(blobUrl);
      showToast("CSV exported successfully", "success");
    } catch (error) {
      console.error('CSV export failed:', error);
      showToast('Failed to export CSV. Please try again.', "error");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <s-page heading="Dashboard">
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

            {/* Export CSV Button and Auto-Refresh Toggle */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: "0.75rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <span>Auto-refresh (30s)</span>
              </label>
              <button
                onClick={handleExportCSV}
                disabled={isExporting}
              style={{
                padding: "0.625rem 1.25rem",
                  background: isExporting ? "#9CA3AF" : "#7C3AED",
                border: "none",
                borderRadius: "8px",
                color: "#FFFFFF",
                textDecoration: "none",
                fontWeight: "500",
                fontSize: "0.875rem",
                display: "inline-block",
                  cursor: isExporting ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  if (!isExporting) {
                    e.currentTarget.style.background = "#6D28D9";
                    e.currentTarget.style.transform = "translateY(-1px)";
                    e.currentTarget.style.boxShadow = "0 4px 12px rgba(124, 58, 237, 0.3)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isExporting) {
                    e.currentTarget.style.background = "#7C3AED";
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "none";
                  }
                }}
              >
                {isExporting ? "Exporting..." : "Export CSV"}
              </button>
              </div>
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
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#7C3AED",
                }}
              >
                {data.metrics.sessions.toLocaleString()}
                </div>
                {(() => {
                  const change = calculateChange(data.metrics.sessions, data.previousPeriodMetrics.sessions);
                  if (change) {
                    return (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: change.isPositive ? "#10B981" : "#EF4444",
                          fontWeight: "500",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.25rem",
                        }}
                      >
                        {change.isPositive ? "↑" : "↓"} {change.value.toFixed(1)}%
                      </div>
                    );
                  }
                  return null;
                })()}
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
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#06B6D4",
                }}
              >
                {data.metrics.resultsGenerated.toLocaleString()}
                </div>
                {(() => {
                  const change = calculateChange(data.metrics.resultsGenerated, data.previousPeriodMetrics.resultsGenerated);
                  if (change) {
                    return (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: change.isPositive ? "#10B981" : "#EF4444",
                          fontWeight: "500",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.25rem",
                        }}
                      >
                        {change.isPositive ? "↑" : "↓"} {change.value.toFixed(1)}%
                      </div>
                    );
                  }
                  return null;
                })()}
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
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: "bold",
                  color: "#0B0B0F",
                }}
              >
                {data.metrics.productClicked.toLocaleString()}
              </div>
                {(() => {
                  const change = calculateChange(data.metrics.productClicked, data.previousPeriodMetrics.productClicked);
                  if (change) {
                    return (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: change.isPositive ? "#10B981" : "#EF4444",
                          fontWeight: "500",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.25rem",
                        }}
                      >
                        {change.isPositive ? "↑" : "↓"} {change.value.toFixed(1)}%
            </div>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>
          </div>

          {/* Performance Metrics */}
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
                Avg Results per Session
              </div>
              <div
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "bold",
                  color: "#7C3AED",
                }}
              >
                {data.performanceMetrics.avgResultsPerSession.toFixed(1)}
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
                Session Completion Rate
              </div>
              <div
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "bold",
                  color: "#06B6D4",
                }}
              >
                {data.performanceMetrics.sessionCompletionRate.toFixed(1)}%
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ margin: 0, color: "#0B0B0F" }}>
            Top Queries
          </h2>
            {isLoading && <LoadingSkeleton width="100px" height="1.5rem" />}
          </div>
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
                </tr>
              </thead>
              <tbody>
                {data.topQueries.length === 0 ? (
                  <tr>
                    <td
                      colSpan={2}
                      style={{
                        padding: "3rem",
                        textAlign: "center",
                        color: "rgba(11,11,15,0.62)",
                      }}
                    >
                      <p style={{ fontSize: "1.125rem", marginBottom: "0.5rem", margin: 0 }}>No queries yet</p>
                      <p style={{ fontSize: "0.875rem", margin: 0 }}>Queries will appear here once users start using the concierge.</p>
                    </td>
                  </tr>
                ) : (
                  paginatedTopQueries.map((query, idx) => {
                    const globalIdx = (topQueriesPage - 1) * itemsPerPage + idx;
                    return (
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
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {/* Pagination for Top Queries */}
            {totalQueriesPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", borderTop: "1px solid rgba(11,11,15,0.12)", backgroundColor: "#F9FAFB" }}>
                <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  Showing {((topQueriesPage - 1) * itemsPerPage) + 1} to {Math.min(topQueriesPage * itemsPerPage, data.topQueries.length)} of {data.topQueries.length} queries
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button
                    onClick={() => setTopQueriesPage(p => Math.max(1, p - 1))}
                    disabled={topQueriesPage === 1}
                        style={{
                      padding: "0.5rem 1rem",
                      background: topQueriesPage === 1 ? "#F9FAFB" : "#FFFFFF",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "6px",
                      cursor: topQueriesPage === 1 ? "not-allowed" : "pointer",
                      fontSize: "0.875rem",
                      opacity: topQueriesPage === 1 ? 0.5 : 1,
                    }}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: "0.875rem", color: "#0B0B0F", fontWeight: "500" }}>
                    Page {topQueriesPage} of {totalQueriesPages}
                  </span>
                  <button
                    onClick={() => setTopQueriesPage(p => Math.min(totalQueriesPages, p + 1))}
                    disabled={topQueriesPage === totalQueriesPages}
                        style={{
                      padding: "0.5rem 1rem",
                      background: topQueriesPage === totalQueriesPages ? "#F9FAFB" : "#FFFFFF",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "6px",
                      cursor: topQueriesPage === totalQueriesPages ? "not-allowed" : "pointer",
                      fontSize: "0.875rem",
                      opacity: topQueriesPage === totalQueriesPages ? 0.5 : 1,
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
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
                    Actions
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
                      colSpan={6}
                      style={{
                        padding: "3rem",
                        textAlign: "center",
                        color: "rgba(11,11,15,0.62)",
                      }}
                    >
                      <p style={{ fontSize: "1.125rem", marginBottom: "0.5rem", margin: 0 }}>No products yet</p>
                      <p style={{ fontSize: "0.875rem", margin: 0 }}>Products will appear here once users start clicking on recommendations.</p>
                    </td>
                  </tr>
                ) : (
                  paginatedTopProducts.map((product, idx) => {
                    const globalIdx = (topProductsPage - 1) * itemsPerPage + idx;
                    return (
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
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                          {product.imageUrl && (
                            <img
                              src={product.imageUrl}
                              alt={product.title}
                              style={{
                                width: "40px",
                                height: "40px",
                                objectFit: "cover",
                                borderRadius: "6px",
                                border: "1px solid rgba(11,11,15,0.12)",
                              }}
                            />
                          )}
                          <span>{product.title}</span>
                        </div>
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
                      <td
                        style={{
                          borderBottom: "1px solid rgba(11,11,15,0.08)",
                          padding: "0.75rem 1rem",
                          textAlign: "right",
                        }}
                      >
                        <a
                          href={`https://${data.shopDomain}/products/${product.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            padding: "0.375rem 0.75rem",
                            background: "#7C3AED",
                            color: "#FFFFFF",
                            textDecoration: "none",
                            borderRadius: "6px",
                            fontSize: "0.75rem",
                            fontWeight: "500",
                            display: "inline-block",
                            transition: "all 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#6D28D9";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "#7C3AED";
                          }}
                        >
                          View Product
                        </a>
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {/* Pagination for Top Products */}
            {totalProductsPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", borderTop: "1px solid rgba(11,11,15,0.12)", backgroundColor: "#F9FAFB" }}>
                <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                  Showing {((topProductsPage - 1) * itemsPerPage) + 1} to {Math.min(topProductsPage * itemsPerPage, data.topProducts.length)} of {data.topProducts.length} products
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button
                    onClick={() => setTopProductsPage(p => Math.max(1, p - 1))}
                    disabled={topProductsPage === 1}
                    style={{
                      padding: "0.5rem 1rem",
                      background: topProductsPage === 1 ? "#F9FAFB" : "#FFFFFF",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "6px",
                      cursor: topProductsPage === 1 ? "not-allowed" : "pointer",
                      fontSize: "0.875rem",
                      opacity: topProductsPage === 1 ? 0.5 : 1,
                    }}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: "0.875rem", color: "#0B0B0F", fontWeight: "500" }}>
                    Page {topProductsPage} of {totalProductsPages}
                  </span>
                  <button
                    onClick={() => setTopProductsPage(p => Math.min(totalProductsPages, p + 1))}
                    disabled={topProductsPage === totalProductsPages}
                    style={{
                      padding: "0.5rem 1rem",
                      background: topProductsPage === totalProductsPages ? "#F9FAFB" : "#FFFFFF",
                      border: "1px solid rgba(11,11,15,0.12)",
                      borderRadius: "6px",
                      cursor: topProductsPage === totalProductsPages ? "not-allowed" : "pointer",
                      fontSize: "0.875rem",
                      opacity: topProductsPage === totalProductsPages ? 0.5 : 1,
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

