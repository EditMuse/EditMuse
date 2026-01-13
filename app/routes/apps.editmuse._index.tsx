import type { LoaderFunctionArgs } from "react-router";

/**
 * App Proxy Index Route
 * Handles GET/HEAD requests to /apps/editmuse
 * Returns 200 OK with JSON response for health checks
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[App Proxy] GET /apps/editmuse");
  
  const method = request.method;
  const url = new URL(request.url);
  const query = url.searchParams;
  
  console.log("[App Proxy] Index route - Method:", method, "Query params:", {
    shop: query.get("shop"),
    signature: query.has("signature") ? "present" : "missing",
  });

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
};

