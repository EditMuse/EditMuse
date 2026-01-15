import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BreakoutRedirect } from "~/components/BreakoutRedirect";
import { login } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  try {
    const loginResult = await login(request);
    
    // If login returns a redirect Response, extract Location and return JSON to prevent iframe navigation
    if (loginResult instanceof Response && loginResult.status >= 300 && loginResult.status < 400) {
      const location = loginResult.headers.get("Location");
      if (location) {
        // Return JSON instead of Response to break out of iframe client-side
        return { redirectUrl: location, host, apiKey };
      }
    }
    
    // No redirect - return redirectUrl as null
    return { redirectUrl: null, host, apiKey };
  } catch (error) {
    // login() may throw a redirect Response - catch it
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      const location = error.headers.get("Location");
      if (location) {
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

export default function Auth() {
  const { redirectUrl, host, apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded={false}>
      <s-page>
        {redirectUrl ? (
          <BreakoutRedirect redirectUrl={redirectUrl} host={host} apiKey={apiKey} />
        ) : (
          <s-section heading="Log in">
            <p>Please access this app from the Shopify admin.</p>
          </s-section>
        )}
      </s-page>
    </AppProvider>
  );
}
