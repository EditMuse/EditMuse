import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { getEntitlements } from "~/models/billing.server";
import { PLAN_TIER } from "~/models/billing.server";

function safeJson(s: string | null) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  // Get entitlements for reporting gates
  // Note: Advanced reporting with orderId/customerId removed for PCD Level 0 compliance

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const rows = await prisma.usageEvent.findMany({
    where: { shopId: shop.id, createdAt: { gte: fromDate, lte: toDate } },
    orderBy: { createdAt: "desc" },
  });

  // Basic columns (always exported)
  // Note: orderId, customerId removed for PCD Level 0 compliance
  const basicHeader = ["createdAt", "eventType", "creditsBurned", "metadata"];

  const header = basicHeader.join(",");

  const lines = rows.map(r => {
    const metadata = safeJson(r.metadata);
    
    // Basic columns only (orderId, customerId removed for PCD Level 0 compliance)
    const basicCols = [
      r.createdAt.toISOString(),
      r.eventType,
      String(r.creditsBurned || 0),
      JSON.stringify(metadata || null).replaceAll('"', '""') // CSV escape
    ];

    return basicCols
      .map(v => `"${v}"`)
      .join(",");
  });

  const csv = [header, ...lines].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="editmuse-usage.csv"',
    },
  });
};

