import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { useEffect } from "react";

export default function App() {
  // Initialize Sentry on client side (lazy-loaded to avoid build errors)
  useEffect(() => {
    if (typeof window !== "undefined") {
      import("./utils/sentry.client").then(({ initSentry }) => {
        initSentry();
      }).catch(() => {
        // Sentry not available, skip initialization
      });
    }
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
