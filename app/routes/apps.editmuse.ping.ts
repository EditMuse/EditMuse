import type { LoaderFunctionArgs } from "react-router";

export async function loader(args: LoaderFunctionArgs) {
  const { proxyPingLoader } = await import("~/app-proxy-ping.server");
  return proxyPingLoader(args.request, "/apps/editmuse/ping");
}

