import { AppProvider } from "@shopify/shopify-app-react-router/react";
import createApp from "@shopify/app-bridge";
import { Redirect } from "@shopify/app-bridge/actions";
import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

import { login } from "~/shopify.server";

function loginErrorMessage(loginErrors: LoginError): { shop?: string } {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Please enter your shop domain to log in" };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "Please enter a valid shop domain to log in" };
  }

  return {};
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const loginResult = await login(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  
  // If login returns a redirect to OAuth, extract the URL to break out of iframe
  if (loginResult instanceof Response && loginResult.status >= 300 && loginResult.status < 400) {
    const location = loginResult.headers.get("Location");
    if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
      // Return the redirect URL so we can break out of iframe client-side
      return { redirectUrl: location, host, apiKey, errors: {} };
    }
    // For other redirects, return the Response directly
    return loginResult;
  }
  
  const errors = loginErrorMessage(loginResult);
  return { errors, host, apiKey };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const loginResult = await login(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  
  // If login returns a redirect to OAuth, extract the URL to break out of iframe
  if (loginResult instanceof Response && loginResult.status >= 300 && loginResult.status < 400) {
    const location = loginResult.headers.get("Location");
    if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
      // Return the redirect URL so we can break out of iframe client-side
      return { redirectUrl: location, host, apiKey, errors: {} };
    }
    // For other redirects, return the Response directly
    return loginResult;
  }
  
  const errors = loginErrorMessage(loginResult);
  return { errors, host, apiKey };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const [showFallback, setShowFallback] = useState(false);
  const errors = (actionData || loaderData)?.errors || {};
  const redirectUrl = (actionData || loaderData)?.redirectUrl;
  const host = (actionData || loaderData)?.host as string | null | undefined;
  const apiKey = (actionData || loaderData)?.apiKey as string | undefined;

  // Break out of iframe when redirecting to OAuth
  useEffect(() => {
    if (redirectUrl) {
      setShowFallback(false);

      if (host && apiKey) {
        try {
          const app = createApp({ apiKey, host, forceRedirect: true });
          Redirect.create(app).dispatch(Redirect.Action.REMOTE, redirectUrl);
          return;
        } catch (error) {
          setShowFallback(true);
          return;
        }
      }

      setShowFallback(true);
    }
  }, [redirectUrl, host, apiKey]);

  return (
    <AppProvider embedded={false}>
      <s-page>
        {redirectUrl ? (
          <s-section heading="Redirecting…">
            <p>Redirecting to Shopify to complete installation.</p>
            {showFallback && (
              <s-button
                type="button"
                onClick={() => {
                  if (window.top && window.top !== window) {
                    window.top.location.href = redirectUrl;
                  } else {
                    window.location.href = redirectUrl;
                  }
                }}
              >
                Continue
              </s-button>
            )}
          </s-section>
        ) : (
        <Form method="post">
        <s-section heading="Log in">
          <s-text-field
            name="shop"
            label="Shop domain"
            details="example.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            autocomplete="on"
            error={"shop" in errors && typeof errors.shop === "string" ? errors.shop : undefined}
          ></s-text-field>
          <s-button type="submit">Log in</s-button>
        </s-section>
        </Form>
        )}
      </s-page>
    </AppProvider>
  );
}
