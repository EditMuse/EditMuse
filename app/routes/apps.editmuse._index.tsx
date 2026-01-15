import type { LoaderFunctionArgs } from "react-router";
import { getShopFromAppProxy } from "~/app-proxy.server";
import { withProxyLogging } from "~/utils/proxy-logging.server";

/**
 * App Proxy Index Route
 * Handles GET/HEAD requests to /apps/editmuse
 * Returns 200 OK with JSON response for health checks
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const query = url.searchParams;
  const shopDomain = getShopFromAppProxy(query) || query.get("shop") || undefined;

  return withProxyLogging(
    async () => {
      const method = request.method;

      return Response.json({
        ok: true,
        route: "apps/editmuse",
        method: method,
        message: "EditMuse App Proxy is active",
        availableEndpoints: [
          "/apps/editmuse/session/start",
          "/apps/editmuse/session",
          "/apps/editmuse/ping",
        ],
      }, { status: 200 });
    },
    request,
    "/apps/editmuse",
    shopDomain
  );
};

