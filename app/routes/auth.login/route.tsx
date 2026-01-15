import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BreakoutRedirect } from "~/components/BreakoutRedirect";
import { login } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const loginResult = await login(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  
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
