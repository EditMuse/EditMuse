import type { LoaderFunctionArgs } from "react-router";

export async function loader(args: LoaderFunctionArgs) {
  const { appProxyPing } = await import("~/app-proxy-ping.server");
  return appProxyPing(args);
}

