import { useEffect } from "react";
import createApp from "@shopify/app-bridge";
import { Redirect } from "@shopify/app-bridge/actions";

interface BreakoutRedirectProps {
  redirectUrl: string;
  host: string | null | undefined;
  apiKey: string | undefined;
}

export function BreakoutRedirect({ redirectUrl, host, apiKey }: BreakoutRedirectProps) {
  useEffect(() => {
    // Determine host from props or URLSearchParams fallback
    const resolvedHost = host || new URLSearchParams(window.location.search).get("host");
    const resolvedApiKey = apiKey;

    if (resolvedHost && resolvedApiKey) {
      try {
        const app = createApp({ apiKey: resolvedApiKey, host: resolvedHost, forceRedirect: true });
        Redirect.create(app).dispatch(Redirect.Action.REMOTE, redirectUrl);
        return;
      } catch (error) {
        // Fall through to top-level navigation
      }
    }

    // Use top-level navigation as fallback
    if (window.top && window.top !== window) {
      window.top.location.assign(redirectUrl);
    } else {
      window.location.assign(redirectUrl);
    }
  }, [redirectUrl, host, apiKey]);

  return (
    <s-section heading="Redirecting…">
      <p>Redirecting to Shopify to complete installation.</p>
      <a href={redirectUrl} target="_top" rel="noreferrer">
        Continue
      </a>
    </s-section>
  );
}

