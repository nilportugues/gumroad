// Renders a registered page (pages.ts) into the Inertia page object.
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { type InertiaPage, loadPage, type LoadPageOptions } from "./load-page.ts";
import { PAGES } from "./pages.ts";
import { PAGE_URL_HEADER } from "./render-state.ts";

// App Router hands dynamic segments percent-encoded (an external id ends in `==`); Rails sees them decoded.
const decodeParam = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export async function renderPage(pattern: string, encodedParams: Record<string, string>, options: Omit<LoadPageOptions, "url" | "mobileAppWebView" | "analyticsEnabled" | "buyerCurrencyFooter"> = {}): Promise<InertiaPage> {
  const spec = PAGES[pattern];
  if (!spec) throw new Error(`No page is registered for ${pattern}`);
  const params = Object.fromEntries(Object.entries(encodedParams).map(([name, value]) => [name, decodeParam(value)]));
  // The proxy's x-gr-page-url overrides this; it only matters for renders that bypass it.
  const url = pattern.replace(/:(\w+)/g, (_, name: string) => params[name] ?? "");
  // The proxy answers these with Rails' own status first (proxy.ts, via inertia-page.ts); a page can only send 307/404.
  // A page's `guard` ran there too, before the render.
  if (spec.redirect) {
    const requestHeaders = await headers();
    const host = requestHeaders.get("x-forwarded-host")?.split(/,\s?/).at(-1) ?? requestHeaders.get("host") ?? "localhost";
    const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
    const redirected = await spec.redirect(params, { url: new URL(requestHeaders.get(PAGE_URL_HEADER) ?? url, `${protocol}://${host}`), headers: requestHeaders });
    if (redirected) {
      if ("notFound" in redirected) notFound();
      redirect(redirected.location);
    }
  }
  return loadPage(spec.component, (action) => spec.props(params, action), { ...options, url, mobileAppWebView: spec.mobileAppWebView ?? false, analyticsEnabled: spec.analyticsEnabled, buyerCurrencyFooter: spec.buyerCurrencyFooter ?? false });
}
