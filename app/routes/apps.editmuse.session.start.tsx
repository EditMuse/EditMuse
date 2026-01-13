import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const ROUTE_PATH = "/apps/editmuse/session/start";

// Handle OPTIONS for CORS preflight (POST requests trigger this)
export const options = async ({ request }: LoaderFunctionArgs) => {
  const { proxySessionStartOptions } = await import("~/app-proxy-session-start.server");
  return proxySessionStartOptions(request, ROUTE_PATH);
};

// Add loader to handle GET requests (for health checks / debugging)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { proxySessionStartLoader } = await import("~/app-proxy-session-start.server");
  return proxySessionStartLoader(request, ROUTE_PATH);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { proxySessionStartAction } = await import("~/app-proxy-session-start.server");
  return proxySessionStartAction(request, ROUTE_PATH);
};

