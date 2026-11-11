import { readFileSync } from "node:fs";
import path from "node:path";

import { it } from "vitest";

import { compileRouteTable } from "@/lib/navigation/proxy/route-table";

// The routes Rack::Attack throttles (config/initializers/rack_attack.rb). A Node answer would skip the counter in Rails' Redis, so routes.json
// does not list them and Rails serves them whole; src/server/controllers/rack-attack-throttles.test.ts keeps it that way. The fixtures recorded
// for the ported handlers stay as the oracle for the day the counter is shared, but the replays have nothing to compare: they skip them here,
// and rack-attack-routes.replay.test.ts proves the request reaches Rails whole.
export const RAILS_ONLY_KEYS = [
  "/signup",
  "POST /settings/totp/confirm",
  "POST /settings/passkeys/registration_options",
  "POST /settings/passkeys",
  "seller:/",
  "product:/",
  "/discover",
  "/purchases",
  "/charge_data",
  "/license_key_lookup_data",
  "/paypal_charge_data",
  "/offer_codes/compute_discount",
  "/mobile/url_redirects/download/:token/:product_file_id",
  "seller:/.well-known/acme-challenge/:token",
  "product:/.well-known/acme-challenge/:token",
  "api:/v2/sales",
  "/api/v2/sales",
  "PUT api:/v2/user/custom_html",
  "PUT /api/v2/user/custom_html",
  "PATCH api:/v2/user/custom_html",
  "PATCH /api/v2/user/custom_html",
  "POST api:/v2/user/preview_custom_html",
  "POST /api/v2/user/preview_custom_html",
  "POST /products/:product_id/marketing_actions/:id/execute.json",
] as const;

const routesJson = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "..", "routes.json"), "utf8"),
) as Record<string, unknown>;
const listed = RAILS_ONLY_KEYS.filter((key) => key in routesJson);
if (listed.length > 0) throw new Error(`routes.json lists a route Rack::Attack throttles: ${listed.join(", ")}`);

// The one route whose host scope is an entry property rather than a key prefix.
const API_HOST_KEYS: readonly string[] = ["/mobile/url_redirects/download/:token/:product_file_id"];

const compiled = RAILS_ONLY_KEYS.map((key) => ({
  key,
  route: compileRouteTable({
    [key]: { flag: "rails_only", ...(API_HOST_KEYS.includes(key) ? { hosts: "api" as const } : {}) },
  })[0]!,
}));

const GUMROAD_HOSTS = new Set(["app.test.gumroad.com", "test.gumroad.com"]);

type FixtureRequest = { method?: unknown; path?: unknown; headers?: Record<string, unknown> };

// The key of the route that Rails serves for this recorded request, if any. A controller spec records `/v2/sales.json`, which the replays
// send as `/api/v2/sales`.
export function railsOnlyKey(request: FixtureRequest): string | null {
  if (typeof request.method !== "string" || typeof request.path !== "string") return null;
  const host = String(request.headers?.host ?? "").replace(/:\d+$/u, "");
  const raw = request.path.split("?")[0]!;
  const paths = new Set([
    raw,
    raw.replace(/\.json$/u, ""),
    raw.replace(/\.json$/u, "").replace(/^\/v2\//u, "/api/v2/"),
  ]);
  const found = compiled.find(({ route }) => {
    if (!route.methods.includes(request.method as string)) return false;
    const onGumroad = GUMROAD_HOSTS.has(host);
    if (route.hosts === "gumroad" && !onGumroad) return false;
    if (route.hosts === "api" && !host.startsWith("api.")) return false;
    if ((route.hosts === "seller" || route.hosts === "product") && (onGumroad || host.startsWith("api."))) return false;
    return [...paths].some((candidate) => route.regexp.test(candidate));
  });
  return found?.key ?? null;
}

export const RAILS_ONLY_REASON = "Rack::Attack throttles the route, so Rails serves it whole";

// Drops the cases whose last recorded request is a Rails-only route and lists them as skipped. A case is [name, fixture path, exchange index].
export function withoutRailsOnly<T extends readonly [string, string, number, ...unknown[]]>(
  cases: readonly T[],
  requestOf: (entry: T) => FixtureRequest,
): T[] {
  const [skipped, served] = [
    cases.filter((entry) => railsOnlyKey(requestOf(entry)) !== null),
    cases.filter((entry) => railsOnlyKey(requestOf(entry)) === null),
  ];
  it.skip.each(skipped.map(([name]) => [`${name} (${RAILS_ONLY_REASON})`]))("%s", () => undefined);
  return served;
}
