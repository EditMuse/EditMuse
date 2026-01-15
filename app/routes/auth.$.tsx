import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { BreakoutRedirect } from "~/components/BreakoutRedirect";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  try {
    const authResult = await authenticate.admin(request);
    
    // If authenticate returns a redirect Response to Shopify OAuth, convert it to JSON
    if (authResult instanceof Response && authResult.status >= 300 && authResult.status < 400) {
      const location = authResult.headers.get("Location");
      if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
        // Return JSON instead of Response to break out of iframe client-side
        return { redirectUrl: location, host, apiKey };
      }
      // For other redirects, return the Response directly
      return authResult;
    }

    // Authentication succeeded, no redirect needed
    return { redirectUrl: null, host, apiKey };
  } catch (error) {
    // authenticate.admin() may throw a redirect Response - catch it
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      const location = error.headers.get("Location");
      if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
        // Return JSON instead of throwing Response to break out of iframe client-side
        return { redirectUrl: location, host, apiKey };
      }
      // Re-throw other redirects
      throw error;
    }
    // Re-throw non-redirect errors
    throw error;
  }
};

export default function AuthCallback() {
  const { redirectUrl, host, apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded={false}>
      <s-page>
        {redirectUrl ? (
          <BreakoutRedirect redirectUrl={redirectUrl} host={host} apiKey={apiKey} />
        ) : (
          <s-section heading="Authenticated">
            <p>Authentication successful.</p>
          </s-section>
        )}
      </s-page>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
