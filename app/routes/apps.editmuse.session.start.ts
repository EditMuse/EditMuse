import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export async function loader(args: LoaderFunctionArgs) {
  const { proxySessionStartLoader } = await import("~/app-proxy-session-start.server");
  return proxySessionStartLoader(args.request, "/apps/editmuse/session/start");
}

export async function action(args: ActionFunctionArgs) {
  const { proxySessionStartAction } = await import("~/app-proxy-session-start.server");
  const { withProxyLogging } = await import("~/utils/proxy-logging.server");
  const { getShopFromAppProxy } = await import("~/app-proxy.server");
  
  const url = new URL(args.request.url);
  const query = url.searchParams;
  const shopDomain = getShopFromAppProxy(query) || query.get("shop") || undefined;
  
  return withProxyLogging(
    async () => {
  return proxySessionStartAction(args.request, "/apps/editmuse/session/start");
    },
    args.request,
    "/apps/editmuse/session/start",
    shopDomain
  );
}

