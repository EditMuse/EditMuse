import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export async function loader(args: LoaderFunctionArgs) {
  const { proxySessionStartLoader } = await import("~/app-proxy-session-start.server");
  return proxySessionStartLoader(args.request, "/apps/editmuse/session/start");
}

export async function action(args: ActionFunctionArgs) {
  const { proxySessionStartAction } = await import("~/app-proxy-session-start.server");
  return proxySessionStartAction(args.request, "/apps/editmuse/session/start");
}

