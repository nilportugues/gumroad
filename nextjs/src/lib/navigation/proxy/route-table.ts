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
};

export type RouteTable = Record<string, string | RouteEntry>;

// `pattern` is the table key (and the key of the page in pages.ts); `path` is the URL pattern. They differ
// for a route that only exists on seller or product-domain hosts, whose key is prefixed with the scope
// ("seller:/affiliates") because the same path can also be a Gumroad-domain page.
export type CompiledRoute = Required<Omit<RouteEntry, "flag">> & { flag: string | null; pattern: string; path: string; regexp: RegExp };

const SCOPE_PREFIXES: Record<string, HostScope> = { "seller:": "seller", "product:": "product" };

// "POST /emails": a route for one HTTP method, the key of a mutation.
const METHOD_PREFIX = /^(POST|PUT|PATCH|DELETE) /;

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
      if (segment.startsWith(":")) return "[^/.?]+";
      if (segment.startsWith("*")) return ".+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}$`);
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
      signedOutOnly: entry.signedOutOnly ?? false,
      signedInOnly: entry.signedInOnly ?? false,
      inertia: entry.inertia ?? false,
    };
  });
}

function hostMatches(scope: HostScope, host: HostClassification): boolean {
  if (scope === "any") return true;
  if (scope === "gumroad") return host.gumroad;
  if (scope === "product") return !host.gumroad && host.customDomainLookup !== null;
  return !host.gumroad && (host.sellerSubdomain !== null || host.customDomainLookup !== null);
}

// Every route a request matches, in table order: `seller:/` and `product:/` both match a custom domain's root,
// and only the host gate (a product on the domain or not) tells them apart.
export function matchRoutes(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute[] {
  return routes.filter((route) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname));
}

export function matchRoute(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute | null {
  return (
    routes.find((route) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname)) ??
    null
  );
}
