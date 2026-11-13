import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compileRouteTable, type RouteTable } from "../../lib/navigation/proxy/route-table.ts";

import { RACK_ATTACK_RULES, RACK_ATTACK_RULE_NAMES } from "./rack-attack.ts";

// config/initializers/rack_attack.rb counts requests in Rails' Redis. Node counts what it answers itself (rack-attack.ts, one counter ahead of the
// action chain, hand-backs un-counted), so a route Rack::Attack throttles may be in routes.json only if Node counts it: a mutation, a handler, a
// redirect or an Inertia page (processAction and pageEnvelope). This test fails when a routes.json entry matches a throttled path and method and
// is neither counted in Node nor in ALLOWED below with a reason.
//
// RULES mirrors the path and method of every rule in the Ruby file. The path literals are read back from rack_attack.rb, so a rule that
// is added, removed or re-pathed there fails "mirrors every path rack_attack.rb throttles" until RULES follows. A method condition changed inside an
// existing rule is not seen; keep RULES honest when editing one. `invalid_params` (every path, but only for params Rack cannot parse) has no path
// literal; rack-attack-rules.test.ts checks it against the golden.

const nextjsRoot = process.cwd();
const rackAttack = readFileSync(path.join(nextjsRoot, "..", "config", "initializers", "rack_attack.rb"), "utf8");
const routeTable = JSON.parse(readFileSync(path.join(nextjsRoot, "routes.json"), "utf8")) as RouteTable;

// The rules Node counts itself (rack-attack.ts) on the same Redis keys, by the literal of rack_attack.rb they come from and the rule names they
// are (with their /2../6 tiers). A route that matches one of these literals is counted before its action runs (countsInNode) and un-counted
// when it is handed back, so Rails and Node together count each request once.
const COUNTED_IN_NODE: Record<string, string[]> = {
  "/login": ["/ip:/login:post"],
  "/login.json": ["/ip:/login.json", "logins/login"],
  "/settings": ["/ip:/settings:put"],
  "/two-factor": ["/params:/two-factor:post"],
  "/two-factor/resend_authentication_token": ["/params:/two-factor/resend_authentication_token:post"],
  "/two-factor/verify": ["/params:/two-factor/verify"],
  "/two-factor/switch_to_email": ["/params:/two-factor/switch_to_email:post"],
  "/two-factor/switch_to_recovery": ["/params:/two-factor/switch_to_recovery:post"],
  "/two-factor/switch_to_authenticator": ["/params:/two-factor/switch_to_authenticator:post"],
  "\\A/(?:users|mobile)/forgot_password(?:\\.[^/]+)?\\z": ["password_reset/ip", "password_reset/email"],
  "\\A/products/search(?:\\.[^/]+)?\\z": ["products_search/ip"],
  "\\A(/(?:purchases|service_charges)/[^/]+/resend_receipt)(?:\\.[^/]+)?\\z": ["/ip:resend_receipt"],
  "\\A/communities/[^/]+/chat_messages\\z": ["/ip/period:(?-mix:\\A\\/communities\\/[^\\/]+\\/chat_messages\\z):post"],
  "\\A/posts/.+/comments\\z": ["/ip:(?-mix:\\A\\/posts\\/.+\\/comments\\z):post"],
  "\\A/posts/.+/comments/.+\\z": ["/ip:(?-mix:\\A\\/posts\\/.+\\/comments\\/.+\\z):put"],
  "\\A/(?:[^/]+/)?landing/products\\z": ["/ip/params:(?-mix:\\A\\/(?:[^\\/]+\\/)?landing\\/products\\z):get"],
  "/offer_codes/compute_discount": ["/ip:/offer_codes/compute_discount"],
  "grouped:/charge_data": ["/ip:/charge_data", "/params:grouped_receipt:email"],
  "grouped:/license_key_lookup_data": ["/ip:/license_key_lookup_data", "/params:grouped_receipt:email"],
  "grouped:/paypal_charge_data": ["/ip:/paypal_charge_data"],
  "/follow": ["/ip:/follow:post", "/ip/params:/follow:post"],
  "/follow_from_embed_form": ["/ip:/follow_from_embed_form", "/ip/params:/follow_from_embed_form"],
  // Served by an api-v2 or mobile handler, which also runs through processAction.
  "\\A/(?:muse|claude|chatgpt|cursor|antigravity)/v1/oauth2/register(?:\\.[^/]+)?\\z": [
    "oauth_dynamic_registration/ip",
  ],
  "ends_with:/v2/sales": ["/api/v2/sales"],
  "\\A/(api/)?v2/user/custom_html(\\.\\w+)?\\z": [
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z):put",
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z):patch",
    "/params:(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z):put",
    "/params:(?-mix:\\A\\/(api\\/)?v2\\/user\\/custom_html(\\.\\w+)?\\z):patch",
  ],
  "\\A/(api/)?v2/user/preview_custom_html(\\.\\w+)?\\z": [
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/user\\/preview_custom_html(\\.\\w+)?\\z):post",
    "/params:(?-mix:\\A\\/(api\\/)?v2\\/user\\/preview_custom_html(\\.\\w+)?\\z):post",
  ],
  "\\A/(?:api/)?mobile/url_redirects/download/(?<token>[^/]+)/(?<file>[^/.]+)": ["mobile_url_redirect_download/token"],
  "/": ["/ip:/"],
  "/api/mobile/purchases/index.json": ["/ip:/api/mobile/purchases/index.json"],
  "/mobile/purchases/index.json": ["/ip:/mobile/purchases/index.json"],
  "/discover": ["/ip:/discover"],
  "/discover_search": ["/ip:/discover_search"],
  "/purchases": ["/ip:/purchases", "/ip/period:/purchases"],
  "/stripe/setup_intents": ["/ip:/stripe/setup_intents"],
  "/settings/credit_card": ["/ip:/settings/credit_card"],
  "/signup": ["/ip:/signup"],
  "/signup.json": ["/ip:/signup.json"],
  "/users/auth/facebook": ["/ip:/users/auth/facebook"],
  "/sellers/brand_accounts": ["/ip:/sellers/brand_accounts:post"],
  "/sellers/brand_accounts.json": ["/ip:/sellers/brand_accounts.json:post"],
  "\\A/help/contact(?:\\.[^/]+)?\\z": ["help_center_contact/ip"],
  "\\A/oauth/device/code(?:\\.[^/]+)?\\z": ["oauth_device_code/ip"],
  "\\A/oauth/device(?:\\.[^/]+)?\\z": [
    "oauth_device_authorization_lookup/ip",
    "oauth_device_authorization_decision/ip",
  ],
  "\\A(?:/oauth/token|/(?:muse|claude|chatgpt|cursor|antigravity)/v1/oauth2/token)(?:\\.[^/]+)?\\z": ["oauth_token/ip"],
  "\\A/oauth/token(?:\\.[^/]+)?\\z": ["oauth_device_token/ip/device_code"],
  "/settings/totp/confirm": ["/params:/settings/totp/confirm:post"],
  "\\A/settings/passkeys/registration_options(?:\\.[^/]+)?\\z": [
    "/params:/settings/passkeys/registration_options:POST",
  ],
  "\\A/settings/passkeys(?:\\.[^/]+)?\\z": ["/params:/settings/passkeys:POST"],
  "\\A/products/[^/]+/marketing_actions/[^/]+/execute(?:\\.[^/]+)?\\z": [
    "/params:/products/:id/marketing_actions/:id/execute:POST",
  ],
  "\\A/login/passkey/options(?:\\.[^/]+)?\\z": ["/ip:/login/passkey/options:POST"],
  "\\A/login/passkey(?:\\.[^/]+)?\\z": ["/ip:/login/passkey:POST"],
  "\\A/[[:alnum:]]+/affiliate_requests\\z": ["/ip:(?-mix:\\A\\/[[:alnum:]]+\\/affiliate_requests\\z):post"],
  "/internal/ai_product_details_generations": ["/ip/period:/internal/ai_product_details_generations:post"],
  "\\A/\\.well-known/acme-challenge/": ["/ip/period:(?-mix:\\A\\/\\.well-known\\/acme-challenge\\/)"],
  "\\A/(api/)?v2/products(\\.\\w+)?\\z": ["/ip:(?-mix:\\A\\/(api\\/)?v2\\/products(\\.\\w+)?\\z):post"],
  "\\A/(api/)?v2/products/comps(\\.\\w+)?\\z": [
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/products\\/comps(\\.\\w+)?\\z):get",
    "/params:(?-mix:\\A\\/(api\\/)?v2\\/products\\/comps(\\.\\w+)?\\z):get",
  ],
  "\\A/(api/)?v2/products/[^/]+(\\.\\w+)?\\z": ["put", "patch"].flatMap((verb) =>
    ["/ip", "/params", "/vip/ip", "/vip/params"].map(
      (prefix) => `${prefix}:(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+(\\.\\w+)?\\z):${verb}`,
    ),
  ),
  "\\A/(api/)?v2/products/[^/]+/preview_custom_html(\\.\\w+)?\\z": [
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+\\/preview_custom_html(\\.\\w+)?\\z):post",
    "/params:(?-mix:\\A\\/(api\\/)?v2\\/products\\/[^\\/]+\\/preview_custom_html(\\.\\w+)?\\z):post",
  ],
  "\\A/(api/)?v2/media(\\.\\w+)?\\z": [
    "/ip:(?-mix:\\A\\/(api\\/)?v2\\/media(\\.\\w+)?\\z):post",
    "media_uploads/token",
  ],
};

const ANY = "any";
type Methods = typeof ANY | readonly string[];
type Rule = {
  // The literals as rack_attack.rb writes them (see literalsIn).
  source: string[];
  methods: Methods;
  // Concrete paths the rule counts. They also stand in for the throttled side when a route's `:param` could be any of them.
  samples: string[];
};

const RULES: Rule[] = [
  // Production only, but that is where Node would serve.
  { source: ["/login"], methods: ["POST"], samples: ["/login"] },
  {
    source: ["/login.json", "/signup", "/signup.json"],
    methods: ANY,
    samples: ["/login.json", "/signup", "/signup.json"],
  },
  { source: ["/follow"], methods: ["POST"], samples: ["/follow"] },
  {
    source: ["/follow_from_embed_form", "/users/auth/facebook"],
    methods: ANY,
    samples: ["/follow_from_embed_form", "/users/auth/facebook"],
  },
  { source: ["/settings"], methods: ["PUT"], samples: ["/settings"] },
  {
    source: ["/sellers/brand_accounts", "/sellers/brand_accounts.json"],
    methods: ["POST"],
    samples: ["/sellers/brand_accounts"],
  },

  {
    source: [
      "/",
      "/api/mobile/purchases/index.json",
      "/mobile/purchases/index.json",
      "/discover",
      "/discover_search",
      "/offer_codes/compute_discount",
    ],
    methods: ANY,
    samples: [
      "/",
      "/api/mobile/purchases/index.json",
      "/mobile/purchases/index.json",
      "/discover",
      "/discover_search",
      "/offer_codes/compute_discount",
    ],
  },
  {
    source: ["/purchases", "/stripe/setup_intents", "/settings/credit_card"],
    methods: ANY,
    samples: ["/purchases", "/stripe/setup_intents", "/settings/credit_card"],
  },
  {
    source: ["\\A/(?:api/)?mobile/url_redirects/download/(?<token>[^/]+)/(?<file>[^/.]+)"],
    methods: ["GET", "HEAD"],
    samples: ["/mobile/url_redirects/download/token/file", "/api/mobile/url_redirects/download/token/file.json"],
  },
  { source: ["\\A/help/contact(?:\\.[^/]+)?\\z"], methods: ["POST"], samples: ["/help/contact", "/help/contact.xml"] },
  {
    source: ["grouped:/charge_data", "grouped:/license_key_lookup_data", "grouped:/paypal_charge_data"],
    methods: ANY,
    samples: ["/charge_data", "/license_key_lookup_data.json", "/paypal_charge_data"],
  },
  { source: ["\\A/oauth/device/code(?:\\.[^/]+)?\\z"], methods: ["POST"], samples: ["/oauth/device/code"] },
  { source: ["\\A/oauth/device(?:\\.[^/]+)?\\z"], methods: ["GET", "HEAD", "POST"], samples: ["/oauth/device"] },
  {
    source: ["\\A(?:/oauth/token|/(?:muse|claude|chatgpt|cursor|antigravity)/v1/oauth2/token)(?:\\.[^/]+)?\\z"],
    methods: ANY,
    samples: [
      "/oauth/token",
      "/muse/v1/oauth2/token",
      "/claude/v1/oauth2/token",
      "/chatgpt/v1/oauth2/token",
      "/cursor/v1/oauth2/token",
      "/antigravity/v1/oauth2/token",
    ],
  },
  {
    source: ["\\A/(?:muse|claude|chatgpt|cursor|antigravity)/v1/oauth2/register(?:\\.[^/]+)?\\z"],
    methods: ["POST"],
    samples: ["/claude/v1/oauth2/register", "/cursor/v1/oauth2/register"],
  },
  { source: ["\\A/oauth/token(?:\\.[^/]+)?\\z"], methods: ["POST"], samples: ["/oauth/token"] },
  {
    source: ["\\A/(?:[^/]+/)?landing/products\\z"],
    methods: ["GET"],
    samples: ["/landing/products", "/seller/landing/products"],
  },
  { source: ["\\A/products/search(?:\\.[^/]+)?\\z"], methods: ["GET", "HEAD"], samples: ["/products/search"] },
  {
    source: [
      "/two-factor",
      "/two-factor/resend_authentication_token",
      "/two-factor/switch_to_email",
      "/two-factor/switch_to_recovery",
      "/two-factor/switch_to_authenticator",
      "/settings/totp/confirm",
    ],
    methods: ["POST"],
    samples: [
      "/two-factor",
      "/two-factor/resend_authentication_token",
      "/two-factor/switch_to_email",
      "/two-factor/switch_to_recovery",
      "/two-factor/switch_to_authenticator",
      "/settings/totp/confirm",
    ],
  },
  { source: ["/two-factor/verify"], methods: ANY, samples: ["/two-factor/verify"] },
  {
    source: [
      "\\A/settings/passkeys/registration_options(?:\\.[^/]+)?\\z",
      "\\A/settings/passkeys(?:\\.[^/]+)?\\z",
      "\\A/products/[^/]+/marketing_actions/[^/]+/execute(?:\\.[^/]+)?\\z",
      "\\A/login/passkey/options(?:\\.[^/]+)?\\z",
      "\\A/login/passkey(?:\\.[^/]+)?\\z",
      "\\A/(?:users|mobile)/forgot_password(?:\\.[^/]+)?\\z",
    ],
    methods: ["POST"],
    samples: [
      "/settings/passkeys/registration_options",
      "/settings/passkeys",
      "/products/p/marketing_actions/m/execute.json",
      "/login/passkey/options",
      "/login/passkey",
      "/users/forgot_password",
      "/mobile/forgot_password",
    ],
  },
  { source: ["ends_with:/v2/sales"], methods: ANY, samples: ["/v2/sales", "/api/v2/sales"] },
  { source: ["\\A/[[:alnum:]]+/affiliate_requests\\z"], methods: ["POST"], samples: ["/seller/affiliate_requests"] },
  { source: ["\\A/posts/.+/comments\\z"], methods: ["POST"], samples: ["/posts/p/comments"] },
  { source: ["\\A/posts/.+/comments/.+\\z"], methods: ["PUT"], samples: ["/posts/p/comments/c"] },
  {
    source: ["\\A(/(?:purchases|service_charges)/[^/]+/resend_receipt)(?:\\.[^/]+)?\\z"],
    methods: ["POST"],
    samples: ["/purchases/p/resend_receipt", "/service_charges/s/resend_receipt.json"],
  },
  {
    source: ["\\A/purchases/[^/]+/refund_request(?:\\.[^/]+)?\\z"],
    methods: ["POST"],
    samples: ["/purchases/p/refund_request", "/purchases/p/refund_request.json"],
  },
  { source: ["\\A/communities/[^/]+/chat_messages\\z"], methods: ["POST"], samples: ["/communities/c/chat_messages"] },
  {
    source: ["/internal/ai_product_details_generations"],
    methods: ["POST"],
    samples: ["/internal/ai_product_details_generations"],
  },
  { source: ["\\A/\\.well-known/acme-challenge/"], methods: ANY, samples: ["/.well-known/acme-challenge/token"] },
  { source: ["\\A/(api/)?v2/products(\\.\\w+)?\\z"], methods: ["POST"], samples: ["/v2/products", "/api/v2/products"] },
  {
    source: ["\\A/(api/)?v2/products/comps(\\.\\w+)?\\z"],
    methods: ["GET"],
    samples: ["/v2/products/comps", "/api/v2/products/comps"],
  },
  {
    source: ["\\A/(api/)?v2/products/[^/]+(\\.\\w+)?\\z"],
    methods: ["PUT", "PATCH"],
    samples: ["/v2/products/p", "/api/v2/products/p"],
  },
  {
    source: ["\\A/(api/)?v2/products/[^/]+/preview_custom_html(\\.\\w+)?\\z"],
    methods: ["POST"],
    samples: ["/v2/products/p/preview_custom_html", "/api/v2/products/p/preview_custom_html"],
  },
  {
    source: ["\\A/(api/)?v2/user/custom_html(\\.\\w+)?\\z"],
    methods: ["PUT", "PATCH"],
    samples: ["/v2/user/custom_html", "/api/v2/user/custom_html"],
  },
  {
    source: ["\\A/(api/)?v2/user/preview_custom_html(\\.\\w+)?\\z"],
    methods: ["POST"],
    samples: ["/v2/user/preview_custom_html", "/api/v2/user/preview_custom_html"],
  },
  { source: ["\\A/(api/)?v2/media(\\.\\w+)?\\z"], methods: ["POST"], samples: ["/v2/media", "/api/v2/media"] },
];

// Throttled, matched by a Node route, and still safe. Every entry must still match something, and say why the counter is not skipped.
const ALLOWED: { route: string; rule: string; reason: string; check?: () => void }[] = [
  {
    route: "api:/v2/products/:id",
    rule: "\\A/(api/)?v2/products/comps(\\.\\w+)?\\z",
    reason: "api-v2/links.ts hands `comps` back to Rails (loadProductOrComps), which counts it once",
    check: () =>
      expect(readFileSync(path.join(nextjsRoot, "src/server/controllers/api-v2/links.ts"), "utf8")).toContain(
        'input.routeParams.id === "comps"',
      ),
  },
  {
    route: "/api/v2/products/:id",
    rule: "\\A/(api/)?v2/products/comps(\\.\\w+)?\\z",
    reason: "api-v2/links.ts hands `comps` back to Rails (loadProductOrComps), which counts it once",
    check: () =>
      expect(readFileSync(path.join(nextjsRoot, "src/server/controllers/api-v2/links.ts"), "utf8")).toContain(
        'input.routeParams.id === "comps"',
      ),
  },
  {
    route: "/products/:id",
    rule: "\\A/products/search(?:\\.[^/]+)?\\z",
    reason: "the redirect leaves `search` with Rails (redirectExcept)",
    check: () =>
      expect(
        (routeTable["/products/:id"] as unknown as { redirectExcept: { id: string[] } }).redirectExcept.id,
      ).toContain("search"),
  },
  {
    route: "/*taxonomy",
    rule: "*",
    reason:
      "pathGate taxonomy passes only the path of a Taxonomy (discover-taxonomy.ts), and no throttled path is a taxonomy slug",
    check: () => {
      expect((routeTable["/*taxonomy"] as { pathGate: string }).pathGate).toBe("taxonomy");
      const seeds = readFileSync(
        path.join(nextjsRoot, "..", "db/seeds/010_development_staging_test/taxonomy_create.rb"),
        "utf8",
      );
      const slugs = new Set([...seeds.matchAll(/slug: "([^"]+)"/gu)].map((match) => match[1]));
      const first = throttles.flatMap(({ rule }) => rule.samples).map((sample) => sample.split("/")[1]);
      expect(first.filter((segment) => slugs.has(segment ?? ""))).toEqual([]);
    },
  },
];

// The path literals of rack_attack.rb, as RULES writes them: string paths, regexp bodies, the %w lists and the suffix check.
function literalsIn(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const found = new Set<string>();
  for (const match of code.matchAll(/\bpath: "([^"]+)"/gu)) found.add(match[1]!);
  for (const match of code.matchAll(/req\.path == "([^"]+)"/gu)) found.add(match[1]!);
  for (const match of code.matchAll(/req\.path\.ends_with\?\("([^"]+)"\)/gu)) found.add(`ends_with:${match[1]!}`);
  // GROUPED_RECEIPT_LOOKUP_PATHS: each word becomes \A<word>(?:\.[^/]+)?\z.
  for (const match of code.matchAll(/%w\[(\/[^\]]*)\]/gu))
    for (const word of match[1]!.split(/\s+/u)) found.add(`grouped:${word}`);
  for (const match of code.matchAll(/%r\{((?:[^{}\\]|\\.)*)\}/gu)) found.add(match[1]!);
  // A slash-delimited path regexp always opens with \A; the body keeps its \/ escapes in the file and loses them here.
  for (const match of code.matchAll(/(?<![\w)\]])\/(\\A(?:\\.|[^/\\\n])*)\/[a-z]*/gu))
    found.add(match[1]!.replace(/\\\//gu, "/"));
  // Not paths: the interpolated GROUPED_RECEIPT template and the Authorization header regexp.
  return [...found].filter((literal) => !literal.includes("#{") && !literal.startsWith("\\Abearer")).sort();
}

function matcher(literal: string): (pathname: string) => boolean {
  if (literal.startsWith("ends_with:")) return (pathname) => pathname.endsWith(literal.slice("ends_with:".length));
  if (literal.startsWith("grouped:")) {
    const exact = literal.slice("grouped:".length);
    return (pathname) =>
      pathname === exact || (pathname.startsWith(`${exact}.`) && !pathname.slice(exact.length + 1).includes("/"));
  }
  if (!literal.includes("\\A")) return (pathname) => pathname === literal;
  const body = literal
    .replace(/\\A/gu, "^")
    .replace(/\\z/gu, "$")
    .replace(/\[\[:alnum:\]\]/gu, "[A-Za-z0-9]");
  const regexp = new RegExp(body, "u");
  return (pathname) => regexp.test(pathname);
}

const throttles = RULES.flatMap((rule) => rule.source.map((literal) => ({ literal, rule, matches: matcher(literal) })));
const methodsOf = (rule: Rule, all: readonly string[]) =>
  rule.methods === ANY ? all : all.filter((method) => (rule.methods as readonly string[]).includes(method));

const routes = compileRouteTable(routeTable);

// The counter runs ahead of every way Node answers (rack-attack.ts): processAction for a mutation, a `handler` (api-v2, mobile, public), a redirect
// and an Inertia visit, and pageEnvelope for a full page load of an `inertia` page. A page marked `inertia: "only"` is Node's for Inertia visits
// alone, and Rails serves (and counts) its full page loads.
const countsInNode = (entry: unknown): boolean => {
  const { mutation, handler, inertia, redirect, redirectReplace } = (entry ?? {}) as {
    mutation?: boolean;
    handler?: string;
    inertia?: boolean | "only";
    redirect?: string;
    redirectReplace?: unknown;
  };
  return (
    mutation === true ||
    typeof handler === "string" ||
    inertia === true ||
    inertia === "only" ||
    typeof redirect === "string" ||
    redirectReplace !== undefined
  );
};

// A route's path with each `:param` filled by a value that cannot collide with a literal, then by the literals a throttle names.
function probes(routePath: string): string[] {
  const filled = (value: string) =>
    routePath
      .replace(/:\w+\(([^)]+)\)/gu, "abc12345")
      .replace(/\*\w+/gu, `${value}/${value}`)
      .replace(/:\w+/gu, value);
  return [...new Set([filled("abc123"), ...throttles.flatMap(({ rule }) => rule.samples)])];
}

describe("Rack::Attack throttles", () => {
  it("mirrors every path rack_attack.rb throttles", () => {
    expect(throttles.map(({ literal }) => literal).sort()).toEqual(literalsIn(rackAttack));
  });

  it("derives a matcher that matches each sample of its rule", () => {
    for (const { literal, rule, matches } of throttles) {
      if (rule.source.length === 1)
        expect(
          rule.samples.some((sample) => matches(sample)),
          literal,
        ).toBe(true);
    }
    for (const rule of RULES)
      for (const sample of rule.samples)
        expect(
          throttles.some((t) => t.rule === rule && t.matches(sample)),
          sample,
        ).toBe(true);
  });

  const hits = routes.flatMap((route) =>
    probes(route.path)
      .filter((probe) => route.regexp.test(probe))
      .flatMap((probe) =>
        throttles.flatMap(({ literal, rule, matches }) =>
          matches(probe)
            ? methodsOf(rule, route.methods)
                .filter((method) => route.methods.includes(method))
                .map((method) => ({ route: route.pattern, method, literal, probe }))
            : [],
        ),
      ),
  );
  const countedInNode = (hit: { route: string; literal: string }) =>
    countsInNode(routeTable[hit.route]) && (COUNTED_IN_NODE[hit.literal] ?? []).length > 0;
  const allowed = (hit: { route: string; literal: string }) =>
    countedInNode(hit) ||
    ALLOWED.some((entry) => entry.route === hit.route && (entry.rule === "*" || entry.rule === hit.literal));

  it("keeps routes.json free of throttled paths unless a reason allows them", () => {
    const unexplained = hits
      .filter((hit) => !allowed(hit))
      .map(
        (hit) =>
          `${hit.route.startsWith(`${hit.method} `) ? "" : `${hit.method} `}${hit.route} matches ${hit.literal} (${hit.probe})`,
      );
    expect(unexplained).toEqual([]);
  });

  it("counts in Node only rules that rack-attack.ts defines, with every backoff tier", () => {
    for (const [literal, names] of Object.entries(COUNTED_IN_NODE)) {
      expect(
        throttles.some((throttle) => throttle.literal === literal),
        literal,
      ).toBe(true);
      for (const name of names) expect(RACK_ATTACK_RULE_NAMES, `${literal}: ${name}`).toContain(name);
    }
  });

  it("defines each rule with the name, limit and period Rails registers", () => {
    const { throttles: registered } = JSON.parse(
      readFileSync(path.join(nextjsRoot, "parity/golden/rack-attack-throttles.json"), "utf8"),
    ) as { throttles: { name: string; limit: number; period: number }[] };
    for (const rule of RACK_ATTACK_RULES)
      expect(registered, rule.name).toContainEqual({ name: rule.name, limit: rule.limit, period: rule.period });
  });

  it("lists only allowed routes that still match a throttle", () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.length, entry.route).toBeGreaterThan(0);
      expect(
        hits.some((hit) => hit.route === entry.route && (entry.rule === "*" || hit.literal === entry.rule)),
        entry.route,
      ).toBe(true);
      entry.check?.();
    }
  });
});

// One list per kind of route, so a reviewer sees what each decision covered. Each key left routes.json while Node could not count a request it
// answered; the single counter (rack-attack.ts) brought them back.
const GROUPS: Record<string, string[]> = {
  "signup (/signup)": ["/signup"],
  "settings writes (totp confirm, passkeys)": [
    "POST /settings/totp/confirm",
    "POST /settings/passkeys",
    "POST /settings/passkeys/registration_options",
  ],
  "pages (/ on seller and product hosts, /discover, /purchases)": ["seller:/", "product:/", "/discover", "/purchases"],
  "ACME challenge": ["seller:/.well-known/acme-challenge/:token", "product:/.well-known/acme-challenge/:token"],
  "marketing actions (per-user rule)": ["POST /products/:product_id/marketing_actions/:id/execute.json"],
};

describe("routes Rack::Attack throttles are served by Node and counted there", () => {
  for (const [group, keys] of Object.entries(GROUPS)) {
    it(`registers ${group} in a way the counter sees`, () => {
      expect(keys.filter((key) => !(key in routeTable))).toEqual([]);
      expect(keys.filter((key) => !countsInNode(routeTable[key]))).toEqual([]);
    });
  }

  it("serves the login and settings saves from Node, which counts their production-only rules", () => {
    for (const key of ["POST /login", "PUT /settings"])
      expect((routeTable[key] as { mutation?: boolean }).mutation, key).toBe(true);
  });

  it("keeps the unthrottled methods of a partly throttled path", () => {
    // Rack::Attack compares the method exactly: PATCH /settings, PUT and PATCH /users/forgot_password, DELETE and POST-less
    // chat message and comment routes are outside every rule.
    for (const key of [
      "PATCH /settings",
      "PUT /users/forgot_password",
      "PATCH /users/forgot_password",
      "DELETE seller:/posts/:post_id/comments/:id",
    ]) {
      expect(key in routeTable, key).toBe(true);
    }
  });
});
