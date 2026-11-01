// Whether Rails would redirect instead of rendering a converted page. A page's redirect() can only
// send 307/308 and a response the proxy builds itself gets a body from Next.js, so the redirects
// Rails sends (302 from rescue_from, 301 from a before_action) are answered by the /gr-inertia route
// handler, with the rest of what Rails' controller sends alongside them (processAction). The
// redirects themselves live with the page, in page-props/pages.ts.
import { matchPagePath, PAGES } from "./page-props/pages.ts";

export function redirectsBeforeRendering(pattern: string, url: URL): boolean {
  return !!PAGES[pattern]?.redirect?.(matchPagePath(url.pathname)?.params ?? {});
}
