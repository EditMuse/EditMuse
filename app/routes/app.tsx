import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", pathname: url.pathname };
};

// Breadcrumb component
function Breadcrumbs() {
  // Get pathname from loader data (SSR-safe)
  const loaderData = useLoaderData<typeof loader>();
  const pathname = loaderData.pathname || "";

  const breadcrumbMap: Record<string, { label: string; path: string }[]> = {
    "/app/dashboard": [{ label: "Dashboard", path: "/app/dashboard" }],
    "/app/experiences": [{ label: "Experiences", path: "/app/experiences" }],
    "/app/experiences/new": [
      { label: "Experiences", path: "/app/experiences" },
      { label: "New Experience", path: "/app/experiences/new" },
    ],
    "/app/usage": [{ label: "Usage", path: "/app/usage" }],
    "/app/billing": [{ label: "Billing", path: "/app/billing" }],
    "/app/diagnose": [{ label: "Diagnose", path: "/app/diagnose" }],
  };

  // Handle dynamic routes (e.g., /app/experiences/:id)
  let breadcrumbs = breadcrumbMap[pathname];
  if (!breadcrumbs) {
    // Try to match dynamic routes
    if (pathname.startsWith("/app/experiences/") && pathname !== "/app/experiences/new") {
      breadcrumbs = [
        { label: "Experiences", path: "/app/experiences" },
        { label: "Edit Experience", path: pathname },
      ];
    } else {
      breadcrumbs = [];
    }
  }

  if (breadcrumbs.length === 0) return null;

  return (
    <div
      style={{
        padding: "0.75rem 1rem",
        backgroundColor: "#F9FAFB",
        borderBottom: "1px solid rgba(11,11,15,0.12)",
        fontSize: "0.875rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <Link
        to="/app/dashboard"
        style={{
          color: "rgba(11,11,15,0.62)",
          textDecoration: "none",
        }}
      >
        Home
      </Link>
      {breadcrumbs.map((crumb, idx) => (
        <span key={crumb.path}>
          <span style={{ color: "rgba(11,11,15,0.4)", margin: "0 0.5rem" }}>/</span>
          {idx === breadcrumbs.length - 1 ? (
            <span style={{ color: "#0B0B0F", fontWeight: "500" }}>{crumb.label}</span>
          ) : (
            <Link
              to={crumb.path}
              style={{
                color: "rgba(11,11,15,0.62)",
                textDecoration: "none",
              }}
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/dashboard">Dashboard</s-link>
        <s-link href="/app/experiences">Experiences</s-link>
        <s-link href="/app/usage">Usage</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/diagnose">Diagnose</s-link>
      </s-app-nav>
      <Breadcrumbs />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
