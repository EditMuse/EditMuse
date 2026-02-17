import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { appProxySessionStart } from "~/app-proxy-session-start.server";

export async function loader(args: LoaderFunctionArgs) {
  return appProxySessionStart(args);
}

export async function action(args: ActionFunctionArgs) {
  return appProxySessionStart(args);
}

