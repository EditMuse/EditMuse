import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // Check connectivity: call ping handler directly (server-side)
  let connectivityStatus: "ok" | "fail" = "fail";
  try {
    const { proxyPingLoader } = await import("~/app-proxy-ping.server");
    const mockRequest = new Request("http://localhost/apps/editmuse/ping");
    const response = await proxyPingLoader(mockRequest, "/apps/editmuse/ping");
    
    if (response.ok) {
      const data = await response.json();
      if (data.ok === true) {
        connectivityStatus = "ok";
      }
    }
  } catch (error) {
    console.error("[Onboarding] Connectivity check failed:", error);
    connectivityStatus = "fail";
  }

  // Check extension installation: fetch storefront HTML and check for markers
  let extensionStatus: "ok" | "fail" = "fail";
  let extensionError: string | null = null;
  let lastChecked: string | null = null;

  if (shop.storefrontTestUrl) {
    try {
      const testUrl = shop.storefrontTestUrl.trim();
      if (testUrl) {
        lastChecked = new Date().toISOString();

        // Fetch HTML with 5s timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await fetch(testUrl, {
            signal: controller.signal,
            headers: {
              "User-Agent": "EditMuse-Onboarding-Check/1.0",
            },
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            extensionError = `HTTP ${response.status}: ${response.statusText}`;
          } else {
            const html = await response.text();

            // Check for markers:
            // 1. 'editmuse-concierge-root' class
            // 2. '<editmuse-concierge' tag (custom element)
            // 3. 'shopify-app-block' with editmuse identifier
            const hasEditmuseConciergeRoot = html.includes('editmuse-concierge-root');
            const hasEditmuseConciergeTag = html.includes('<editmuse-concierge') || html.includes('data-editmuse-concierge');
            const hasShopifyAppBlock = html.includes('shopify-app-block') && (html.includes('editmuse') || html.includes('editmuse_concierge'));

            if (hasEditmuseConciergeRoot || hasEditmuseConciergeTag || hasShopifyAppBlock) {
              extensionStatus = "ok";
            } else {
              extensionError = "Extension markers not found in HTML";
            }
          }
        } catch (fetchError: any) {
          clearTimeout(timeoutId);
          if (fetchError.name === "AbortError") {
            extensionError = "Request timeout (5s)";
          } else {
            extensionError = fetchError.message || "Failed to fetch storefront";
          }
        }
      }
    } catch (error: any) {
      console.error("[Onboarding] Extension check failed:", error);
      extensionError = error.message || "Unknown error";
    }
  }

  return Response.json({
    connectivity: connectivityStatus,
    extension: extensionStatus,
    extensionError: extensionError || undefined,
    lastChecked: lastChecked || undefined,
  });
};

