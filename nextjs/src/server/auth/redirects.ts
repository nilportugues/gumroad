// Only same-origin targets, returned as a path, like Rails' url_from and safe_redirect_path.
export function safeRedirectPath(target: string | null | undefined, origin: string, fallback = "/"): string {
  if (!target) return fallback;
  try {
    const url = new URL(target, origin);
    if (url.origin !== origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

// Logout CSRF guard. Rails checks an authenticity token on DELETE /logout; Auth.js's own CSRF token
// only covers its signout endpoint. Browsers send Origin on every cross-site POST, and
// Sec-Fetch-Site on same-origin ones, so requiring either to say "same origin" blocks forgeries.
export function isSameOriginRequest(request: Request, origin: string): boolean {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null) return requestOrigin === origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}
