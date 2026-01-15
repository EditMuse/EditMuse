import { AppProvider } from "@shopify/shopify-app-react-router/react";
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
  
  // If login returns a redirect to OAuth, extract the URL to break out of iframe
  if (loginResult instanceof Response && loginResult.status >= 300 && loginResult.status < 400) {
    const location = loginResult.headers.get("Location");
    if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
      // Return the redirect URL so we can break out of iframe client-side
      return { redirectUrl: location, errors: {} };
    }
    // For other redirects, return the Response directly
    return loginResult;
  }
  
  const errors = loginErrorMessage(loginResult);
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const loginResult = await login(request);
  
  // If login returns a redirect to OAuth, extract the URL to break out of iframe
  if (loginResult instanceof Response && loginResult.status >= 300 && loginResult.status < 400) {
    const location = loginResult.headers.get("Location");
    if (location && (location.includes("accounts.shopify.com") || location.includes("admin.shopify.com"))) {
      // Return the redirect URL so we can break out of iframe client-side
      return { redirectUrl: location, errors: {} };
    }
    // For other redirects, return the Response directly
    return loginResult;
  }
  
  const errors = loginErrorMessage(loginResult);
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = (actionData || loaderData)?.errors || {};
  const redirectUrl = (actionData || loaderData)?.redirectUrl;

  // Break out of iframe when redirecting to OAuth
  useEffect(() => {
    if (redirectUrl) {
      // Force redirect to break out of iframe
      // This is necessary because Shopify's OAuth pages block iframe embedding
      if (window.top && window.top !== window) {
        // We're in an iframe - redirect the top-level window
        window.top.location.href = redirectUrl;
      } else {
        // Not in iframe - normal redirect
        window.location.href = redirectUrl;
      }
    }
  }, [redirectUrl]);

  return (
    <AppProvider embedded={false}>
      <s-page>
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
      </s-page>
    </AppProvider>
  );
}
