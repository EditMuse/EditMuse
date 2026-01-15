/**
 * Preserves query parameters from the request URL when redirecting
 */
export function withQuery(request: Request, path: string): string {
  const url = new URL(request.url);
  return url.search ? `${path}${url.search}` : path;
}

