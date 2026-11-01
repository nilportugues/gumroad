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
};

export type RouteTable = Record<string, string | RouteEntry>;

// `pattern` is the table key (and the key of the page in pages.ts); `path` is the URL pattern. They differ
// for a route that only exists on seller or product-domain hosts, whose key is prefixed with the scope
// ("seller:/affiliates") because the same path can also be a Gumroad-domain page.
export type CompiledRoute = Required<Omit<RouteEntry, "flag">> & { flag: string | null; pattern: string; path: string; regexp: RegExp };

const SCOPE_PREFIXES: Record<string, HostScope> = { "seller:": "seller", "product:": "product" };

export function splitScopedPattern(key: string): { scope: HostScope | null; path: string } {
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
      methods: entry.methods ?? DEFAULT_METHODS,
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

export function matchRoute(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute | null {
  return (
    routes.find((route) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname)) ??
    null
  );
}
