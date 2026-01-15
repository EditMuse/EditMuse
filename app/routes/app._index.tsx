import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { withQuery } from "~/utils/redirect.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Redirect to dashboard as the new default landing page
  return redirect(withQuery(request, "/app/dashboard"));
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
