import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /session/start when Shopify app proxy forwards requests
 * without the full path prefix. Uses the same shared handlers as the full path route.
 * 
 * Uses dynamic imports to prevent React Router from analyzing server-only modules during build.
 */
const ROUTE_PATH = "/session/start";

// Lazy-load server-only module to avoid build-time analysis
// Using Function constructor to prevent static analysis
const getHandlers = () => {
  const modulePath = "~/app-proxy-session-start.server";
  return import(/* @vite-ignore */ modulePath);
};

// Handle OPTIONS for CORS preflight (POST requests trigger this)
export const options = async ({ request }: LoaderFunctionArgs) => {
  const { proxySessionStartOptions } = await getHandlers();
  return proxySessionStartOptions(request, ROUTE_PATH);
};

// Add loader to handle GET requests (for health checks / debugging)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { proxySessionStartLoader } = await getHandlers();
  return proxySessionStartLoader(request, ROUTE_PATH);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { proxySessionStartAction } = await getHandlers();
  return proxySessionStartAction(request, ROUTE_PATH);
};

