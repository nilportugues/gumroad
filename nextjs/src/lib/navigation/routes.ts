// Port of the js-routes helpers (`Routes.*`) the shared components call. Rails generates the full
// table with `rake js:export`; only the helpers reached by converted pages are listed here, and
// each must match its line in config/routes.rb. Add helpers as pages are converted.
//
// This module ships to the browser, so it must not import server config (which reads files with
// node:fs). PROTOCOL is inlined at build time by next.config.ts, as Vite does; DOMAIN is only
// set on the server, so the browser falls back to window.location.host just like the Vite bundle.
const getConfig = (name: "DOMAIN" | "PROTOCOL"): string | undefined =>
  name === "PROTOCOL" ? process.env.PROTOCOL : process.env.DOMAIN;

type Segment = string | number | { to_param?: () => string; id?: string | number };
type RouteOptions = {
  host?: string;
  protocol?: string;
  port?: string | number;
  anchor?: string;
  format?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

// js-routes options that shape the URL instead of becoming query parameters.
const RESERVED_OPTIONS = new Set(["host", "protocol", "port", "anchor", "format", "params", "subdomain", "trailing_slash", "script_name"]);

function toParam(value: Segment | unknown): string {
  if (value && typeof value === "object") {
    const object = value as { to_param?: () => string; id?: string | number };
    if (typeof object.to_param === "function") return object.to_param();
    if (object.id !== undefined) return String(object.id);
  }
  return String(value);
}

// Rails' `to_query`: nested hashes as `a[b]=`, arrays as `a[]=`, keys sorted.
function toQuery(params: Record<string, unknown>, prefix?: string): string[] {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(`${name}[]`)}=${encodeURIComponent(toParam(item ?? ""))}`);
    } else if (value && typeof value === "object" && !("to_param" in value)) {
      parts.push(...toQuery(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value === null ? "" : toParam(value))}`);
    }
  }
  return parts;
}

// js-routes bakes Rails' `default_url_options` (PROTOCOL, DOMAIN) in at generation time. Here the
// page props' domain_settings set them, so server and browser render identical absolute URLs.
const defaults: { protocol?: string; host?: string } = {};

export function configureRouteDefaults(protocol: string, host: string) {
  defaults.protocol = protocol;
  defaults.host = host;
}

function defaultHost() {
  return defaults.host ?? getConfig("DOMAIN") ?? (typeof window !== "undefined" ? window.location.host : "localhost:3000");
}

function defaultProtocol() {
  return defaults.protocol ?? getConfig("PROTOCOL") ?? "http";
}

// `spec` is the Rails route pattern, e.g. "/help/category/:slug(.:format)".
export function buildRoute(spec: string, args: unknown[], absolute: boolean): string {
  const required = [...spec.replace(/\([^)]*\)/g, "").matchAll(/[:*](\w+)/g)].map((m) => m[1] as string);
  const last = args[args.length - 1];
  const hasOptions = args.length > required.length && last !== null && typeof last === "object";
  const options: RouteOptions = hasOptions ? { ...(last as RouteOptions) } : {};
  const positional = hasOptions ? args.slice(0, -1) : args;
  const values: Record<string, unknown> = { ...options.params };
  required.forEach((name, index) => {
    if (index < positional.length) values[name] = positional[index];
    else if (options[name] !== undefined) values[name] = options[name];
    else throw new Error(`Route ${spec} is missing required parameter :${name}`);
  });
  if (options.format !== undefined) values.format = options.format;

  const used = new Set<string>();
  const fill = (pattern: string): string | null => {
    let missing = false;
    const filled = pattern.replace(/([:*])(\w+)/g, (_, kind: string, name: string) => {
      const value = values[name];
      if (value === undefined || value === null || value === "") {
        missing = true;
        return "";
      }
      used.add(name);
      return kind === "*" ? toParam(value).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(toParam(value));
    });
    return missing ? null : filled;
  };
  // Optional groups are dropped unless every parameter inside them is given.
  const path = spec.replace(/\(([^()]*)\)/g, (_, group: string) => fill(group) ?? "");
  const resolved = fill(path) ?? path;

  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!RESERVED_OPTIONS.has(key) && !used.has(key) && !required.includes(key)) query[key] = value;
  }
  const queryString = toQuery(query).join("&");
  let url = resolved + (queryString ? `?${queryString}` : "") + (options.anchor ? `#${options.anchor}` : "");
  if (absolute) {
    const host = options.host ?? defaultHost();
    const port = options.port ? `:${options.port}` : "";
    url = `${options.protocol ?? defaultProtocol()}://${host}${port}${url}`;
  }
  return url;
}

type RouteHelper = (...args: unknown[]) => string;
const path = (spec: string): RouteHelper => (...args) => buildRoute(spec, args, false);
const url = (spec: string): RouteHelper => (...args) => buildRoute(spec, args, true);

// Help center (config/routes.rb `namespace :help_center, path: "help"`).
export const help_center_root_path = path("/help(.:format)");
export const help_center_root_url = url("/help(.:format)");
export const help_center_articles_path = path("/help/article(.:format)");
export const help_center_article_path = path("/help/article/:slug(.:format)");
export const help_center_article_url = url("/help/article/:slug(.:format)");
export const help_center_category_path = path("/help/category/:slug(.:format)");
export const help_center_category_url = url("/help/category/:slug(.:format)");
export const help_center_contact_path = path("/help/contact(.:format)");

// Dashboard navigation (components/client-components/Nav).
export const root_url = url("/");
export const dashboard_url = url("/dashboard(.:format)");
export const discover_url = url("/discover(.:format)");
export const agent_url = url("/agent(.:format)");
export const profile_url = url("/profile(.:format)");
export const pages_url = url("/pages(.:format)");
export const products_url = url("/products(.:format)");
export const collaborators_url = url("/collaborators(.:format)");
export const checkout_discounts_url = url("/checkout/discounts(.:format)");
export const checkout_form_url = url("/checkout/form(.:format)");
export const checkout_upsells_url = url("/checkout/upsells(.:format)");
export const emails_url = url("/emails(.:format)");
export const followers_url = url("/followers(.:format)");
export const workflows_url = url("/workflows(.:format)");
export const customers_url = url("/customers(.:format)");
export const sales_dashboard_url = url("/dashboard/sales(.:format)");
export const audience_dashboard_url = url("/dashboard/audience(.:format)");
export const dashboard_utm_links_url = url("/dashboard/utm_links(.:format)");
export const churn_dashboard_url = url("/dashboard/churn(.:format)");
export const affiliates_url = url("/affiliates(.:format)");
export const balance_url = url("/payouts(.:format)");
export const communities_path = path("/communities(.:format)");
export const library_url = url("/library(.:format)");
export const wishlists_url = url("/wishlists(.:format)");
export const reviews_url = url("/reviews(.:format)");
export const settings_main_url = url("/settings(.:format)");
export const settings_team_url = url("/settings/team(.:format)");
export const logout_url = url("/logout(.:format)");
export const sellers_switch_path = path("/sellers/switch(.:format)");
export const sellers_brand_accounts_path = path("/sellers/brand_accounts(.:format)");
export const dashboard_path = path("/dashboard(.:format)");
