import type { LoaderFunctionArgs } from "react-router";

/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /ping when Shopify app proxy forwards requests
 * without the full path prefix. Uses the same shared handler as the full path route.
 * 
 * Uses dynamic imports to prevent React Router from analyzing server-only modules during build.
 */
const ROUTE_PATH = "/ping";

// Lazy-load server-only module to avoid build-time analysis
// Using Function constructor to prevent static analysis
const getHandlers = () => {
  const modulePath = "~/app-proxy-ping.server";
  return import(/* @vite-ignore */ modulePath);
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { proxyPingLoader } = await getHandlers();
  return proxyPingLoader(request, ROUTE_PATH);
};

