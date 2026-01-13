import type { LoaderFunctionArgs } from "react-router";
import { proxyPingLoader } from "~/app-proxy-ping.server";

/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /ping when Shopify app proxy forwards requests
 * without the full path prefix. Uses the same shared handler as the full path route.
 * 
 * This file uses .server.tsx extension to mark it as server-only, preventing React Router
 * from trying to bundle it for the client.
 */
const ROUTE_PATH = "/ping";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return proxyPingLoader(request, ROUTE_PATH);
};

