import type { LoaderFunctionArgs } from "react-router";

/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /ping when Shopify app proxy forwards requests
 * without the full path prefix. Uses the same shared handler as the full path route.
 */
const ROUTE_PATH = "/ping";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { proxyPingLoader } = await import("~/app-proxy-ping.server");
  return proxyPingLoader(request, ROUTE_PATH);
};

