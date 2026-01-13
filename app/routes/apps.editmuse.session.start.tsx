import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  proxySessionStartLoader,
  proxySessionStartAction,
  proxySessionStartOptions,
} from "~/app-proxy-session-start.server";

const ROUTE_PATH = "/apps/editmuse/session/start";

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

