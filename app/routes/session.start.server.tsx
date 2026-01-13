import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  proxySessionStartLoader,
  proxySessionStartAction,
  proxySessionStartOptions,
} from "~/app-proxy-session-start.server";

/**
 * App Proxy Route - Handles requests when Shopify strips the /apps/editmuse prefix
 * 
 * This route handles /session/start when Shopify app proxy forwards requests
 * without the full path prefix. Uses the same shared handlers as the full path route.
 * 
 * This file uses .server.tsx extension to mark it as server-only, preventing React Router
 * from trying to bundle it for the client.
 */
const ROUTE_PATH = "/session/start";

// Handle OPTIONS for CORS preflight (POST requests trigger this)
export const options = async ({ request }: LoaderFunctionArgs) => {
  return proxySessionStartOptions(request, ROUTE_PATH);
};

// Add loader to handle GET requests (for health checks / debugging)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return proxySessionStartLoader(request, ROUTE_PATH);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return proxySessionStartAction(request, ROUTE_PATH);
};

