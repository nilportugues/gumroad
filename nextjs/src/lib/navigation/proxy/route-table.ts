// nextjs/routes.json: which paths Next.js may serve, each behind a Flipper flag. Anything unmatched
// goes to Rails, so an empty table is a valid (all-Rails) deployment.
import type { HostClassification } from "./hosts";

export type HostScope =
  // GumroadDomainConstraint: gumroad.com / app.gumroad.com. Almost every dashboard page lives here.
  | "gumroad"
  // Seller subdomains and custom domains (UserCustomDomainConstraint / ProductCustomDomainConstraint).
  | "seller"
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
  inertia?: boolean;
};

export type RouteTable = Record<string, string | RouteEntry>;

export type CompiledRoute = Required<Omit<RouteEntry, "flag">> & { flag: string | null; pattern: string; regexp: RegExp };

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
    return {
      pattern,
      regexp: patternToRegExp(pattern),
      flag: entry.flag,
      hosts: entry.hosts ?? "gumroad",
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
  return !host.gumroad && (host.sellerSubdomain !== null || host.customDomainLookup !== null);
}

export function matchRoute(routes: CompiledRoute[], method: string, pathname: string, host: HostClassification): CompiledRoute | null {
  return (
    routes.find((route) => route.methods.includes(method.toUpperCase()) && hostMatches(route.hosts, host) && route.regexp.test(pathname)) ??
    null
  );
}
