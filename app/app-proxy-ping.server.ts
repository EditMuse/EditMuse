/**
 * Unified handler for ping route
 * @param args - React Router LoaderFunctionArgs
 */
export async function appProxyPing(
  args: { request: Request }
): Promise<Response> {
  const { request } = args;
  const routePath = "/ping";
  console.log(`[App Proxy] GET ${routePath}`);
  return Response.json({ ok: true, route: "ping" });
}

/**
 * Shared ping handler for app proxy routes
 * @param request - The incoming request
 * @param routePath - The route path for logging (e.g., "/apps/editmuse/ping" or "/ping")
 */
export async function proxyPingLoader(
  request: Request,
  routePath: string
): Promise<Response> {
  const { withProxyLogging } = await import("~/utils/proxy-logging.server");
  const { getShopFromAppProxy } = await import("~/app-proxy.server");
  
  const url = new URL(request.url);
  const query = url.searchParams;
  const shopDomain = getShopFromAppProxy(query) || query.get("shop") || undefined;

  return withProxyLogging(
    async () => {
      return Response.json({ ok: true, route: "ping" });
    },
    request,
    routePath,
    shopDomain
  );
}
