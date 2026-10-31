// Server-side equivalent of `render inertia: "Component", props: ...` in a Rails controller action:
// runs the ApplicationController before_actions that shape props, the action, then inertia_share.
import { headers } from "next/headers";

import { getRequestContext, type RequestContext } from "@/server/auth/context";

import { domainConfig, type DomainConfig } from "./domain.ts";
import { MetaTagBuilder } from "./meta-tags.ts";
import { sharedPropsPorts } from "./ports.ts";
import { applicationMetaTags, authenticityToken, sharedProps } from "./shared.ts";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// ActiveSupport's Hash#deep_merge: nested hashes merge, everything else (arrays, nil) is replaced.
export function deepMerge(base: Record<string, unknown>, other: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(other)) {
    const current = result[key];
    result[key] = isHash(current) && isHash(value) ? deepMerge(current, value) : value;
  }
  return result;
}

export type ActionContext = {
  context: RequestContext;
  config: DomainConfig;
  meta: MetaTagBuilder;
  url: URL;
  headers: Headers;
  // ApplicationController#default_url_options, for `*_url` helpers called in the action.
  urlOptions: { protocol: string; host: string };
};

// The request's host and non-default port, except on the discover host, where Rails pins DOMAIN.
export function defaultUrlOptions(url: URL, config: DomainConfig): ActionContext["urlOptions"] {
  if (url.hostname === config.validDiscoverRequestHost) return { protocol: config.protocol, host: config.domain };
  return { protocol: config.protocol, host: url.host };
}

// `href` is the absolute request URL, which the shared AppWrapper needs while rendering on the server.
export type InertiaPage = { component: string; props: Record<string, unknown>; href: string };

export type LoadPageOptions = {
  // The page's URL as Rails saw it (path and query), used for page.url and query-dependent props.
  url: string;
  mobileAppWebView?: boolean;
};

async function requestUrl(path: string, requestHeaders: Headers, config: DomainConfig): Promise<URL> {
  const host = requestHeaders.get("x-forwarded-host")?.split(/,\s?/).at(-1) ?? requestHeaders.get("host") ?? config.domain;
  const protocol = requestHeaders.get("x-forwarded-proto") ?? config.protocol;
  return new URL(path, `${protocol}://${host}`);
}

export async function loadPage(
  component: string,
  action: (action: ActionContext) => Promise<Record<string, unknown>> | Record<string, unknown>,
  { url, mobileAppWebView = false }: LoadPageOptions,
): Promise<InertiaPage> {
  const config = domainConfig(process.env);
  const requestHeaders = await headers();
  const context = await getRequestContext();
  const ports = sharedPropsPorts();
  const meta = new MetaTagBuilder();
  const csrfToken = await authenticityToken(ports);
  const request = { headers: requestHeaders, url: await requestUrl(url, requestHeaders, config) };

  await applicationMetaTags(meta, { context, config, csrfToken, ports });
  const pageProps = await action({ context, config, meta, url: request.url, headers: requestHeaders, urlOptions: defaultUrlOptions(request.url, config) });
  const shared = await sharedProps({ context, config, request, meta, csrfToken, ports, mobileAppWebView });
  const errors = await ports.session.consumeInertiaErrors();

  // config.deep_merge_shared_data: page props win, nested hashes merge.
  const props = deepMerge(shared, pageProps);
  props._inertia_meta = meta.toJSON();
  props.errors = errors;
  return { component, props, href: request.url.href };
}
