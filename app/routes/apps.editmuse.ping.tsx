import type { LoaderFunctionArgs } from "react-router";
import { proxyPingLoader } from "~/app-proxy-ping.server";

const ROUTE_PATH = "/apps/editmuse/ping";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return proxyPingLoader(request, ROUTE_PATH);
};

