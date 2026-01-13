import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export async function loader(args: LoaderFunctionArgs) {
  const { appProxySessionStart } = await import("~/app-proxy-session-start.server");
  return appProxySessionStart(args);
}

export async function action(args: ActionFunctionArgs) {
  const { appProxySessionStart } = await import("~/app-proxy-session-start.server");
  return appProxySessionStart(args);
}

