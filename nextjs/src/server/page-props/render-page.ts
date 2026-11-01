// Renders a registered page (pages.ts) into the Inertia page object.
import { redirect } from "next/navigation";

import { type InertiaPage, loadPage, type LoadPageOptions } from "./load-page.ts";
import { PAGES } from "./pages.ts";

export function renderPage(pattern: string, params: Record<string, string>, options: Omit<LoadPageOptions, "url" | "mobileAppWebView"> = {}): Promise<InertiaPage> {
  const spec = PAGES[pattern];
  if (!spec) throw new Error(`No page is registered for ${pattern}`);
  // The proxy answers these with Rails' own status first (proxy.ts, via inertia-page.ts); a page can only send 307.
  // A page's `guard` ran there too, before the render.
  const redirected = spec.redirect?.(params);
  if (redirected) redirect(redirected.location);
  // The proxy's x-gr-page-url overrides this; it only matters for renders that bypass it.
  const url = pattern.replace(/:(\w+)/g, (_, name: string) => params[name] ?? "");
  return loadPage(spec.component, (action) => spec.props(params, action), { ...options, url, mobileAppWebView: spec.mobileAppWebView ?? false });
}
