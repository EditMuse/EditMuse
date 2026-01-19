import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "~/shopify.server";
import { withQuery } from "~/utils/redirect.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Redirect to dashboard (settings page has been removed)
  return redirect(withQuery(request, "/app/dashboard"));
};

