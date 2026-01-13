import type { LoaderFunctionArgs } from "react-router";

const ROUTE_PATH = "/apps/editmuse/ping";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { proxyPingLoader } = await import("~/app-proxy-ping.server");
  return proxyPingLoader(request, ROUTE_PATH);
};

