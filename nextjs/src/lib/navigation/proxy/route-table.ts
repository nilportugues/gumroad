// nextjs/routes.json: which paths Next.js may serve, each behind a Flipper flag. Anything unmatched
// goes to Rails, so an empty table is a valid (all-Rails) deployment.
import type { HostClassification } from "./hosts";

export type HostScope =
  // GumroadDomainConstraint: gumroad.com / app.gumroad.com. Almost every dashboard page lives here.
  | "gumroad"
  // Seller subdomains and custom domains (UserCustomDomainConstraint / ProductCustomDomainConstraint).
  | "seller"
  // Only a custom domain that points at one product (ProductCustomDomainConstraint).
  | "product"
  // ApiDomainConstraint: api.gumroad.com (every host in development). The same API routes also live under /api on the Gumroad domain.
  | "api"
  // DiscoverDomainConstraint: the discover host (gumroad.com; app.gumroad.com is a Gumroad host but not this one).
  | "discover"
  | "any";

export type RouteEntry = {
  // Flipper feature that turns the route on; null means always served by Next (its own endpoints).
  flag: string | null;
  hosts?: HostScope;
  methods?: string[];
  // Only while the logged-in shared props (WS-03 policies, presenters) are unported.
  signedOutOnly?: boolean;
  // A page that needs a signed-in visitor (Devise's authenticate_user!): a signed-out request stays with Rails.
  signedInOnly?: boolean;
  // An Inertia page (server/page-props/pages.ts): Next.js also answers its X-Inertia requests,
  // with the JSON and 409 inertia_rails sends. Other routes' X-Inertia requests go to Rails.
  // "only": just those; the HTML page stays with Rails (its component cannot be rendered by Next.js yet).
  inertia?: boolean | "only";
  // A non-GET action ported to Node (server/controllers/mutation.ts), keyed "POST /emails". Its requests are answered by the
  // /gr-mutation handler, which hands whatever it cannot prove back to Rails with the body.
  mutation?: boolean;
  // A GET action that answers `format.json` (an `Accept: application/json` request, which `request()` in the app sends) from the
  // /gr-mutation handler. The same path is also the HTML page (`inertia`), or Rails when `inertia` is off: such a route never
  // takes a request that is not asking for JSON.
  jsonMutation?: boolean;
  // The path is only this route when the gate says so (`taxonomy`: DiscoverTaxonomyConstraint). Such a route
  // matches after every other, as a catch-all glob must.
  pathGate?: "taxonomy";
  // A route that is not a page: /gr-public/<handler> answers it (server/controllers/public-handlers.ts), whatever the method.
  handler?: string;
  // A router-level redirect (routes.rb `redirect`): a 301 to this path. No controller runs. `%{name}` is filled with the path
  // parameter of that name, escaped as Rails' `escape_path` does. The query string is dropped, as `redirect("/path")` drops it,
  // unless `redirectQuery` says otherwise.
  redirect?: string;
  // "keep": the block form that appends `request.query_string`. "to_query": the `redirect(path:)` form, which rebuilds the
  // query from `query_parameters.to_query` (sorted, re-escaped); a query it cannot rebuild the same way stays with Rails.
  redirectQuery?: string;
  // Parameter values that Rails routes ahead of this redirect claim (`/products/new` before `/products/:id`); they stay with Rails.
  redirectExcept?: Record<string, string[]>;
  // The target is the request's path and query with the first occurrence of `[from]` replaced by `[to]` (`req.fullpath.sub`).
  redirectReplace?: string[];
};

export type RouteTable = Record<string, string | RouteEntry>;

// `pattern` is the table key (and the key of the page in pages.ts); `path` is the URL pattern. They differ
// for a route that only exists on seller or product-domain hosts, whose key is prefixed with the scope
// ("seller:/affiliates") because the same path can also be a Gumroad-domain page.
export type CompiledRoute = Required<Omit<RouteEntry, "flag" | "pathGate" | "handler" | "redirect" | "redirectQuery" | "redirectReplace" | "redirectExcept">> & { pathGate: "taxonomy" | null; handler: string | null; redirect: string | null; redirectQuery: string | null; redirectReplace: [string, string] | null; redirectExcept: Record<string, string[]>; flag: string | null; pattern: string; path: string; regexp: RegExp };

const SCOPE_PREFIXES: Record<string, HostScope> = { "seller:": "seller", "product:": "product", "api:": "api", "discover:": "discover" };

// "POST /emails": a route for one HTTP method, the key of a mutation.
const METHOD_PREFIX = /^(POST|PUT|PATCH|DELETE) /u;

export function splitScopedPattern(key: string): { scope: HostScope | null; path: string } {
  key = key.replace(METHOD_PREFIX, "");
  for (const [prefix, scope] of Object.entries(SCOPE_PREFIXES)) if (key.startsWith(prefix)) return { scope, path: key.slice(prefix.length) };
  return { scope: null, path: key };
}

const DEFAULT_METHODS = ["GET", "HEAD"];

// `:name` matches one segment and `*name` the rest of the path, like Rails route patterns. Rails'
// default segment excludes "." (the format separator), so `/help/category/x.html` stays with Rails.
function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => {
      // `:key([a-zA-Z0-9-]{8,128}).txt`: a constrained parameter followed by a literal suffix, as Rails' `constraints: { key: /.../ }`.
      const constrained = /^:\w+\((.+)\)(.*)$/u.exec(segment);
      if (constrained) return `${constrained[1]}${constrained[2]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
      // `animation(*path)`: Rails' optional glob right after a literal, so `/animation`, `/animation/x` and `/animationx` all match.
      const optionalGlob = /^([^(*:]+)\(\*\w+\)$/u.exec(segment);
      if (optionalGlob) return `${optionalGlob[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*`;
      if (segment.startsWith(":")) return "[^/.?]+";
      if (segment.startsWith("*")) return ".+";
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}$`, "u");
}

export function compileRouteTable(table: RouteTable): CompiledRoute[] {
  return Object.entries(table).map(([pattern, value]) => {
    const entry: RouteEntry = typeof value === "string" ? { flag: value } : value;
    const { scope, path } = splitScopedPattern(pattern);
    return {
      pattern,
      path,
      regexp: patternToRegExp(path),
      flag: entry.flag,
      hosts: entry.hosts ?? scope ?? "gumroad",
      methods: entry.methods ?? (METHOD_PREFIX.test(pattern) ? [METHOD_PREFIX.exec(pattern)![1]!] : DEFAULT_METHODS),
      mutation: entry.mutation ?? false,
      jsonMutation: entry.jsonMutation ?? false,
      signedOutOnly: entry.signedOutOnly ?? false,
      signedInOnly: entry.signedInOnly ?? false,
      inertia: entry.inertia ?? false,
      pathGate: entry.pathGate ?? null,
      handler: entry.handler ?? null,
      redirect: entry.redirect ?? null,
      redirectQuery: entry.redirectQuery ?? null,
      redirectReplace: entry.redirectReplace ? [entry.redirectReplace[0] ?? "", entry.redirectReplace[1] ?? ""] : null,
      redirectExcept: entry.redirectExcept ?? {},
    };
  });
}

function hostMatches(scope: HostScope, host: HostClassification): boolean {
  if (scope === "any") return true;
  if (scope === "gumroad") return host.gumroad;
  if (scope === "discover") return host.discover;
  if (scope === "api") return host.api;
  if (scope === "product") return !host.gumroad && host.customDomainLookup !== null;
  return !host.gumroad && (host.sellerSubdomain !== null || host.customDomainLookup !== null);
}

// Every route a request matches, in table order: `seller:/` and `product:/` both match a custom domain's root,
// and only the host gate (a product on the domain or not) tells them apart.
export function matchRoutes(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute[] {
  const matched = routes.filter((route) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname));
  // A catch-all with a path gate (`/*taxonomy`) is every other route's last resort.
  return [...matched.filter((route) => route.pathGate === null), ...matched.filter((route) => route.pathGate !== null)];
}

export function matchRoute(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute | null {
  const matches = (route: CompiledRoute) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname);
  return routes.find((route) => route.pathGate === null && matches(route)) ?? routes.find((route) => route.pathGate !== null && matches(route)) ?? null;
}
