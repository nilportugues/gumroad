// Server-side equivalent of `render inertia: "Component", props: ...` in a Rails controller action:
// runs the ApplicationController before_actions that shape props, the action, then inertia_share.
import { headers } from "next/headers";

import { getRequestContext, type RequestContext } from "@/server/auth/context";

import type { RenderState } from "../controllers/application-controller.ts";
import { promoteVisitedNavItem } from "../controllers/signed-in-filters.ts";
import { domainConfig, type DomainConfig } from "./domain.ts";
import { type PartialRequest, resolveLazyProps } from "./lazy-props.ts";
import { MetaTagBuilder } from "./meta-tags.ts";
import { sharedPropsPorts } from "./ports.ts";
import { decodeRenderState, PAGE_URL_HEADER, RENDER_STATE_HEADER, renderStatePort } from "./render-state.ts";
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
  // What the Rails chain left in the session for this render (null when a page renders without the proxy).
  renderState: RenderState | null;
  // What the controller's filters worked out for the action (ActionOptions.filters).
  state: Record<string, unknown>;
};

// The request's host and non-default port, except on the discover host, where Rails pins DOMAIN.
export function defaultUrlOptions(url: URL, config: DomainConfig): ActionContext["urlOptions"] {
  if (url.hostname === config.validDiscoverRequestHost) return { protocol: config.protocol, host: config.domain };
  return { protocol: config.protocol, host: url.host };
}

// The page object inertia_rails renders into `data-page` or a JSON response, in its key order.
// `href` is the absolute request URL, which the shared AppWrapper needs while rendering on the server.
export type InertiaPage = {
  component: string;
  props: Record<string, unknown>;
  url: string;
  version: string | null;
  encryptHistory: boolean;
  clearHistory: boolean;
  // Props left out of the first response, by group: the client fetches each group with a partial reload.
  deferredProps?: Record<string, string[]>;
  // Props the client appends to what it holds (`InertiaRails.merge`); absent when there are none.
  mergeProps?: string[];
  href: string;
  // Starts the data of each deferred prop. A server render streams it to the client after the shell, where
  // Rails' client would ask for it with a second request; the X-Inertia JSON never calls these.
  deferredLoaders?: Record<string, () => Promise<unknown>>;
};

export type LoadPageOptions = {
  // The page's URL as Rails saw it (path and query), used for page.url and query-dependent props.
  // The proxy's x-gr-page-url wins; this is the fallback for renders that bypass it.
  url: string;
  mobileAppWebView?: boolean;
  analyticsEnabled?: boolean;
  // Session state from the Rails chain, when the caller ran it itself (the X-Inertia route handler).
  renderState?: RenderState;
};

// inertia_rails' partial reloads: X-Inertia-Partial-Data / -Except name dotted prop paths, and apply
// only when X-Inertia-Partial-Component is the component being rendered. `errors` is always kept.
export function filterPartialProps(props: Record<string, unknown>, component: string, requestHeaders: Headers, alwaysKeys: readonly string[] = []): Record<string, unknown> {
  if (requestHeaders.get("x-inertia-partial-component") !== component) return props;
  const keys = (name: string) => (requestHeaders.get(name) ?? "").split(",").filter((key) => key !== "");
  const only = keys("x-inertia-partial-data");
  const except = keys("x-inertia-partial-except");
  if (only.length === 0 && except.length === 0) return props;

  const walk = (hash: Record<string, unknown>, parent: string[]): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(hash)) {
      const path = [...parent, key];
      if (path.join(".") === "errors" || (parent.length === 0 && alwaysKeys.includes(key))) {
        kept[key] = value;
        continue;
      }
      if (isHash(value) && Object.keys(value).length > 0) {
        const nested = walk(value, path);
        if (Object.keys(nested).length > 0) kept[key] = nested;
        continue;
      }
      const prefixes = path.map((_, i) => path.slice(0, i + 1).join("."));
      if (only.length > 0 && !prefixes.some((prefix) => only.includes(prefix))) continue;
      if (except.length > 0 && prefixes.some((prefix) => except.includes(prefix))) continue;
      kept[key] = value;
    }
    return kept;
  };
  return walk(props, []);
}

// The partial reload this request asks of `component`, which inertia_rails only honours when the
// X-Inertia-Partial-Component header names the component being rendered.
export function partialRequest(component: string, requestHeaders: Headers): PartialRequest {
  if (requestHeaders.get("x-inertia-partial-component") !== component) return null;
  const keys = (name: string) => (requestHeaders.get(name) ?? "").split(",").filter((key) => key !== "");
  return { only: keys("x-inertia-partial-data"), except: keys("x-inertia-partial-except"), reset: keys("x-inertia-reset") };
}

async function requestUrl(path: string, requestHeaders: Headers, config: DomainConfig): Promise<URL> {
  const host = requestHeaders.get("x-forwarded-host")?.split(/,\s?/).at(-1) ?? requestHeaders.get("host") ?? config.domain;
  const protocol = requestHeaders.get("x-forwarded-proto") ?? config.protocol;
  return new URL(path, `${protocol}://${host}`);
}

export async function loadPage(
  component: string,
  action: (action: ActionContext) => Promise<Record<string, unknown>> | Record<string, unknown>,
  { url, mobileAppWebView = false, analyticsEnabled, renderState }: LoadPageOptions,
): Promise<InertiaPage> {
  const config = domainConfig(process.env);
  const requestHeaders = await headers();
  const context = await getRequestContext();
  const state = renderState ?? decodeRenderState(requestHeaders.get(RENDER_STATE_HEADER));
  const ports = state ? { ...sharedPropsPorts(), session: renderStatePort(state) } : sharedPropsPorts();
  const fullpath = requestHeaders.get(PAGE_URL_HEADER) ?? url;
  const meta = new MetaTagBuilder();
  const csrfToken = await authenticityToken(ports);
  const request = { headers: requestHeaders, url: await requestUrl(fullpath, requestHeaders, config) };

  await applicationMetaTags(meta, { context, config, csrfToken, ports, analyticsEnabled });
  const actionProps = await action({ context, config, meta, url: request.url, headers: requestHeaders, urlOptions: defaultUrlOptions(request.url, config), state: state?.pageState ?? {}, renderState: state });
  const { props: pageProps, mergeProps, alwaysKeys, deferredProps, deferredLoaders } = await resolveLazyProps(actionProps, partialRequest(component, requestHeaders));
  const shared = await sharedProps({ context, config, request, meta, csrfToken, ports, mobileAppWebView });
  const errors = await ports.session.consumeInertiaErrors();
  // promote_visited_nav_item runs after Rails renders, so the props above do not list the visit.
  if (state?.promoteNavItemPath && context.loggedInUser) await promoteVisitedNavItem(context.loggedInUser, state.promoteNavItemPath);

  // config.deep_merge_shared_data: page props win, nested hashes merge.
  const props = filterPartialProps({ errors, ...deepMerge(shared, pageProps) }, component, requestHeaders, alwaysKeys);
  props._inertia_meta = meta.toJSON();
  // No asset version is configured, so Rails sends null.
  return {
    component,
    props,
    url: fullpath,
    version: null,
    encryptHistory: false,
    clearHistory: state?.clearHistory ?? false,
    ...(Object.keys(deferredProps).length > 0 ? { deferredProps } : {}),
    ...(mergeProps.length > 0 ? { mergeProps } : {}),
    href: request.url.href,
    ...(Object.keys(deferredLoaders).length > 0 ? { deferredLoaders } : {}),
  };
}
