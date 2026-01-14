import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Redirect to dashboard as the new default landing page
  return redirect("/app/dashboard");
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
