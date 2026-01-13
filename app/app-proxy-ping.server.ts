/**
 * Shared ping handler for app proxy routes
 * @param request - The incoming request
 * @param routePath - The route path for logging (e.g., "/apps/editmuse/ping" or "/ping")
 */
export async function proxyPingLoader(
  request: Request,
  routePath: string
): Promise<Response> {
  console.log(`[App Proxy] GET ${routePath}`);
  return Response.json({ ok: true, route: "ping" });
}
