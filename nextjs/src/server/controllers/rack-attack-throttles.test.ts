import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compileRouteTable, type RouteTable } from "../../lib/navigation/proxy/route-table.ts";

// config/initializers/rack_attack.rb counts requests in Rails' Redis. A Node answer never reaches that counter, and counting in Node as well would
// count every request handed back twice, so a route Rack::Attack throttles must stay out of routes.json and be served by Rails whole. This test fails
// when a routes.json entry matches a throttled path and method without an entry in ALLOWED below that says why it is safe.
//
// RULES mirrors the path and method of every rule in the Ruby file. The path literals are read back from rack_attack.rb, so a rule that
// is added, removed or re-pathed there fails "mirrors every path rack_attack.rb throttles" until RULES follows. A method condition changed inside an
// existing rule is not seen; keep RULES honest when editing one. `invalid_params` (every path, but only for params Rack cannot parse) has no path
// literal and is not modelled.

const nextjsRoot = process.cwd();
const rackAttack = readFileSync(path.join(nextjsRoot, "..", "config", "initializers", "rack_attack.rb"), "utf8");
const routeTable = JSON.parse(readFileSync(path.join(nextjsRoot, "routes.json"), "utf8")) as RouteTable;

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
    source: ["\\A(?:/oauth/token|/(?:muse|claude|chatgpt)/v1/oauth2/token)(?:\\.[^/]+)?\\z"],
    methods: ANY,
    samples: ["/oauth/token", "/muse/v1/oauth2/token", "/claude/v1/oauth2/token", "/chatgpt/v1/oauth2/token"],
  },
  {
    source: ["\\A/(?:muse|claude|chatgpt)/v1/oauth2/register(?:\\.[^/]+)?\\z"],
    methods: ["POST"],
    samples: ["/claude/v1/oauth2/register"],
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
    source: ["\\A/(purchases|service_charges)/.+/resend_receipt\\z"],
    methods: ["POST"],
    samples: ["/purchases/p/resend_receipt", "/service_charges/s/resend_receipt"],
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

const GROUPED_REASON =
  "public-handlers.ts counts the route in Rack::Attack's own Redis keys (controllers/rack-attack.ts groupedReceiptThrottles: `/ip:<path>`, 3 in 20 seconds, and the shared per-recipient email budget) before it answers, uncounts a request it hands back, and answers 429 past the limit";
const groupedCheck = (route: string) => () => {
  expect(rackAttack).toContain("%w[/charge_data /license_key_lookup_data /paypal_charge_data]");
  expect(rackAttack).toMatch(
    /throttle_with_exponential_backoff\(name: "\/ip:#\{path\}", requests: 3, period: 20\.seconds\)/u,
  );
  expect(rackAttack).toMatch(/name: "\/params:grouped_receipt:email", requests: 6, period: 60\.seconds, max_level: 6/u);
  expect(readFileSync(path.join(nextjsRoot, "src/server/controllers/public-handlers.ts"), "utf8")).toContain(
    `groupedReceiptThrottles("${route}")`,
  );
};

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
    route: "/charge_data",
    rule: "grouped:/charge_data",
    reason: GROUPED_REASON,
    check: groupedCheck("/charge_data"),
  },
  {
    route: "/license_key_lookup_data",
    rule: "grouped:/license_key_lookup_data",
    reason: GROUPED_REASON,
    check: groupedCheck("/license_key_lookup_data"),
  },
  {
    route: "/paypal_charge_data",
    rule: "grouped:/paypal_charge_data",
    reason: GROUPED_REASON,
    check: groupedCheck("/paypal_charge_data"),
  },
  {
    route: "/offer_codes/compute_discount",
    rule: "/offer_codes/compute_discount",
    reason:
      "public-handlers.ts counts the route in Rack::Attack's own Redis keys (controllers/rack-attack.ts: same name, window, expiry and limits) before it answers, uncounts a request it hands back, and answers 429 past the limit",
    check: () => {
      expect(rackAttack).toMatch(
        /throttle_by_ip path: "\/offer_codes\/compute_discount",\s+requests: 60, +period: 30\.seconds/u,
      );
      expect(readFileSync(path.join(nextjsRoot, "src/server/controllers/public-handlers.ts"), "utf8")).toContain(
        'throttleByIp("/offer_codes/compute_discount", 60, 30)',
      );
    },
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
  const allowed = (hit: { route: string; literal: string }) =>
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

// One list per kind of route, so a reviewer sees what each decision covered. Each key was in routes.json before Node learned that a Node
// answer skips the Rails counter; the generic test above also catches them, but a failure here names the group.
const GROUPS: Record<string, string[]> = {
  "login and signup (/login, /signup)": ["POST /login", "/signup"],
  "two-factor (per-user rules)": [
    "POST /two-factor",
    "POST /two-factor/resend_authentication_token",
    "POST /two-factor/switch_to_email",
    "POST /two-factor/switch_to_recovery",
    "POST /two-factor/switch_to_authenticator",
    "/two-factor/verify",
  ],
  "password reset (password_reset/ip, password_reset/email)": ["POST /users/forgot_password"],
  "settings writes (/settings PUT, totp confirm, passkeys)": [
    "PUT /settings",
    "POST /settings/totp/confirm",
    "POST /settings/passkeys",
    "POST /settings/passkeys/registration_options",
  ],
  "pages (/ on seller hosts, /discover, /purchases, landing/products, products/search)": [
    "seller:/",
    "product:/",
    "/discover",
    "/purchases",
    "/:username/landing/products",
    "seller:/landing/products",
    "/products/search",
  ],
  "mobile download token": ["/mobile/url_redirects/download/:token/:product_file_id"],
  "ACME challenge": ["seller:/.well-known/acme-challenge/:token", "product:/.well-known/acme-challenge/:token"],
  "API v2 (sales index past page 10, user custom HTML writes and previews)": [
    "api:/v2/sales",
    "/api/v2/sales",
    "PUT api:/v2/user/custom_html",
    "PUT /api/v2/user/custom_html",
    "PATCH api:/v2/user/custom_html",
    "PATCH /api/v2/user/custom_html",
    "POST api:/v2/user/preview_custom_html",
    "POST /api/v2/user/preview_custom_html",
  ],
  "buyer and community writes (resend_receipt, comments, chat messages, marketing execute)": [
    "POST /purchases/:id/resend_receipt",
    "POST seller:/posts/:post_id/comments",
    "PUT seller:/posts/:post_id/comments/:id",
    "POST /communities/:community_id/chat_messages",
    "POST /products/:product_id/marketing_actions/:id/execute.json",
  ],
};

describe("routes Rack::Attack throttles stay in Rails", () => {
  for (const [group, keys] of Object.entries(GROUPS)) {
    it(`leaves ${group} unregistered`, () => {
      expect(keys.filter((key) => key in routeTable)).toEqual([]);
    });
  }

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
