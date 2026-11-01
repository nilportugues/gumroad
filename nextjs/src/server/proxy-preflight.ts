// Whether Rails would redirect (or 404) instead of rendering a converted page. A page's redirect() can only
// send 307/308 and a response the proxy builds itself gets a body from Next.js, so the redirects
// Rails sends (302 from rescue_from, 301 from a before_action) are answered by the /gr-inertia route
// handler, with the rest of what Rails' controller sends alongside them (processAction). The
// redirects themselves live with the page, in page-props/pages.ts.
import { resolveRequestAuth } from "./controllers/signed-in-filters.ts";
import { railsRequest } from "./controllers/rails-request.ts";
import { domainConfig } from "./page-props/domain.ts";
import { matchPagePath, PAGES } from "./page-props/pages.ts";
import { defaultUrlOptions } from "./page-props/load-page.ts";

export async function redirectsBeforeRendering(pattern: string, url: URL, request: Request): Promise<boolean> {
  const spec = PAGES[pattern];
  const params = matchPagePath(url.pathname)?.params ?? {};
  if (await spec?.redirect?.(params, { url, headers: request.headers })) return true;
  if (!spec?.guard) return false;

  const config = domainConfig(process.env);
  const auth = await resolveRequestAuth(railsRequest(new Request(url, { headers: request.headers })), new Date());
  // The chain ends the session itself (a redirect to the login page).
  if (auth.effects.signOut) return true;
  return (await spec.guard({ context: auth.context, config, url, urlOptions: defaultUrlOptions(url, config) })) !== null;
}
