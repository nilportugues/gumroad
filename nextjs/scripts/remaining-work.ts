// Inventory of what is left to port, route by route, written to docs/nextjs-rewrite/remaining-work.md.
// Run from nextjs/: node scripts/remaining-work.ts [--check] [--stdout]
//   --check   exit 1 when the committed doc is stale (does not write)
//   --stdout  print the document instead of writing it
//
// Counted from the repo (deterministic): every route in config/routes.rb and config/routes/admin.rb, matched against nextjs/routes.json and the
// string literals under src/server and src/app; Rails Inertia pages against the page props registered in Node; Sidekiq classes against
// registry.generated.ts. Estimated by hand (the tables below): the difficulty weight of each controller and its workstream.
//
// Ruby is parsed, not executed. routes.rb uses more DSL than api-coverage.ts audits (helper methods drawn twice, `if`, `constraints`,
// `%w[...].each`, `=> "c#a"`, redirects, `devise_for`, `use_doorkeeper`), so `preprocess` first rewrites the file into the subset
// api-coverage.ts's `parseBlock` understands. Anything it still cannot read is listed as unresolved, never guessed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { blockEnd, parseBlock, type Route } from "./api-coverage.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const ROUTES_RB = join(repoRoot, "config/routes.rb");
const ADMIN_RB = join(repoRoot, "config/routes/admin.rb");
const ROUTES_JSON = join(repoRoot, "nextjs/routes.json");
const SERVER_DIR = join(repoRoot, "nextjs/src/server");
const APP_DIR = join(repoRoot, "nextjs/src/app");
const REGISTRY = join(repoRoot, "nextjs/src/server/jobs/registry.generated.ts");
const OUTPUT = join(repoRoot, "docs/nextjs-rewrite/remaining-work.md");

// ---- config/routes.rb ----

const indentOf = (line: string) => /^\s*/u.exec(line)![0].length;
const stripComment = (line: string) => line.replace(/^\s*#.*$/u, "").replace(/\s+#\s.*$/u, "");

// Joins statements split over lines by a trailing comma or an open `(`.
function joinContinuations(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const unbalanced = (text: string) => (text.match(/\(/gu) ?? []).length > (text.match(/\)/gu) ?? []).length;
    while ((/,\s*$/u.test(line) || /\(\s*$/u.test(line) || unbalanced(line)) && i + 1 < lines.length) {
      i++;
      line = `${line.replace(/\s+$/u, "")} ${lines[i]!.trim()}`;
    }
    out.push(line);
  }
  return out;
}

// Macros are `def name ... end` helper methods of the draw block; their calls are replaced by their bodies.
function extractMacros(lines: string[]): { body: string[]; macros: Map<string, string[]> } {
  const macros = new Map<string, string[]>();
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const def = /^(\s*)def (\w+)/u.exec(lines[i]!);
    if (!def) {
      body.push(lines[i]!);
      continue;
    }
    const end = blockEnd(lines, i);
    macros.set(def[2]!, lines.slice(i + 1, end));
    i = end;
  }
  return { body, macros };
}

function expand(lines: string[], macros: Map<string, string[]>, depth = 0): string[] {
  if (depth > 5) throw new Error("macro expansion too deep");
  const out: string[] = [];
  for (const line of lines) {
    const call = /^\s*(\w+)(\(.*\))?\s*$/u.exec(line);
    const macro = call ? macros.get(call[1]!) : undefined;
    if (macro) out.push(...expand(joinContinuations(macro), macros, depth + 1));
    else out.push(line);
  }
  return out;
}

// `%w[a b].each do |x| ... end`: the body once per item, with `#{x}` replaced.
function expandEach(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const each = /^\s*%w\[([^\]]*)\]\.each do \|(\w+)\|\s*$/u.exec(lines[i]!);
    if (!each) {
      out.push(lines[i]!);
      continue;
    }
    const end = blockEnd(lines, i);
    const inner = lines.slice(i + 1, end);
    for (const item of each[1]!.split(/\s+/u).filter(Boolean))
      out.push(...inner.map((line) => line.replaceAll(`#{${each[2]!}}`, item)));
    i = end;
  }
  return out;
}

// Routes the DSL parser cannot see because Devise, Doorkeeper and `mount` generate them. Enumerated by hand from the gems' route tables
// and the controllers named in routes.rb; the parser reports the originating statements as "synthetic" so they cannot be missed.
// `omniauth_providers` of the User model: Devise draws one authorize (GET and POST) and one callback (GET and POST) route per provider.
const OMNIAUTH_PROVIDERS = ["twitter", "stripe_connect", "google_oauth2", "youtube", "instagram", "tiktok", "apple"];

const SYNTHETIC: Route[] = [
  ...[
    ["GET", "/users/forgot_password/new", "user/passwords", "new"],
    ["GET", "/users/forgot_password/edit", "user/passwords", "edit"],
    ["POST", "/users/forgot_password", "user/passwords", "create"],
    ["PATCH", "/users/forgot_password", "user/passwords", "update"],
    ["POST", "/users/sign_in", "logins", "create"],
    ["DELETE", "/users/sign_out", "logins", "destroy"],
    ["GET", "/users/confirmation", "confirmations", "show"],
    ["POST", "/users/confirmation", "confirmations", "create"],
    ["GET", "/users/confirmation/new", "confirmations", "new"],
    ...OMNIAUTH_PROVIDERS.flatMap((provider) => [
      ["GET", `/users/auth/${provider}`, "user/omniauth_callbacks", "passthru"],
      ["POST", `/users/auth/${provider}`, "user/omniauth_callbacks", "passthru"],
      ["GET", `/users/auth/${provider}/callback`, "user/omniauth_callbacks", provider],
      ["POST", `/users/auth/${provider}/callback`, "user/omniauth_callbacks", provider],
    ]),
    ["GET", "/oauth/authorize", "oauth/authorizations", "new"],
    ["POST", "/oauth/authorize", "oauth/authorizations", "create"],
    ["DELETE", "/oauth/authorize", "oauth/authorizations", "destroy"],
    ["POST", "/oauth/token", "oauth/tokens", "create"],
    ["POST", "/oauth/revoke", "oauth/tokens", "revoke"],
    ["POST", "/oauth/introspect", "oauth/tokens", "introspect"],
    ["GET", "/oauth/token/info", "doorkeeper/token_info", "show"],
    ["GET", "/oauth/applications", "oauth/applications", "index"],
    ["POST", "/oauth/applications", "oauth/applications", "create"],
    ["GET", "/oauth/applications/new", "oauth/applications", "new"],
    ["GET", "/oauth/applications/:id", "oauth/applications", "show"],
    ["GET", "/oauth/applications/:id/edit", "oauth/applications", "edit"],
    ["PATCH", "/oauth/applications/:id", "oauth/applications", "update"],
    ["DELETE", "/oauth/applications/:id", "oauth/applications", "destroy"],
    ["GET", "/oauth/authorized_applications", "oauth/authorized_applications", "index"],
    ["DELETE", "/oauth/authorized_applications/:id", "oauth/authorized_applications", "destroy"],
    ["POST", "/internal/admin/auth/exchange", "api/internal/admin/auth", "exchange"],
    ["POST", "/internal/admin/auth/revoke", "api/internal/admin/auth", "revoke"],
    ["POST", "/internal/admin/auth/rotate", "api/internal/admin/auth", "rotate"],
    ["GET", "/bundles/:id/edit/content", "redirects", "redirect"],
    ["GET", "/bundles/:id/edit/share", "redirects", "redirect"],
    ["GET", "/affiliate_requests/onboarding_form", "redirects", "redirect"],
    ["GET", "/admin/sidekiq", "admin/sidekiq_web", "mount"],
    ["GET", "/admin/features", "admin/flipper_ui", "mount"],
  ].map(([method, path, controller, action]) => ({
    method: method!,
    path: path!,
    controller: controller!,
    action: action!,
    unresolved: null,
  })),
];

// `devise_for` and `use_doorkeeper` are replaced by SYNTHETIC; `mount` lines likewise.
// `if`/`unless` blocks: the development-only block goes, otherwise the first branch stays and the else branch (a named/unnamed variant
// of the same routes in routes.rb) goes. Keeping both would double-count nothing but breaks the member/collection nesting they sit in.
function resolveConditionals(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*(if|unless)\b/u.test(line)) {
      out.push(line);
      continue;
    }
    const end = blockEnd(lines, i);
    if (/Rails\.env/u.test(line)) {
      i = end;
      continue;
    }
    const indent = indentOf(line);
    let elseAt = end;
    for (let j = i + 1; j < end; j++)
      if (indentOf(lines[j]!) === indent && /^\s*(else|elsif)\b/u.test(lines[j]!)) {
        elseAt = j;
        break;
      }
    out.push(...resolveConditionals(lines.slice(i + 1, elseAt)));
    i = end;
  }
  return out;
}

export function preprocess(source: string, admin: string): string[] {
  let lines = source.split("\n");
  const start = lines.findIndex((line) => /^Rails\.application\.routes\.draw do/u.test(line));
  if (start < 0) throw new Error("routes.rb no longer has Rails.application.routes.draw");
  lines = lines.slice(start + 1, blockEnd(lines, start));
  lines = lines.map(stripComment).filter((line) => line.trim() !== "");
  lines = joinContinuations(lines);

  const adminBody = joinContinuations(
    admin
      .split("\n")
      .map(stripComment)
      .filter((line) => line.trim() !== "" && !line.startsWith("#")),
  );
  lines = lines.flatMap((line) => (/^\s*draw\(:admin\)\s*$/u.test(line) ? adminBody : [line]));

  const { body, macros } = extractMacros(lines);
  lines = expandEach(expand(body, macros));

  lines = resolveConditionals(lines);

  // devise_for and use_doorkeeper (and the `controllers ...` lines inside it) become SYNTHETIC; mount lines too.
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*use_doorkeeper do\s*$/u.test(line)) {
      i = blockEnd(lines, i);
      continue;
    }
    if (/^\s*devise_for\(/u.test(line) || /^\s*mount\b/u.test(line)) continue;
    kept.push(line);
  }

  const out: string[] = [];
  let inAuth = false;
  for (const raw of kept) {
    let line = raw;
    if (/^\s*\w+ = /u.test(line)) continue;
    // `namespace :auth do post :exchange end` names no controller; Rails resolves it to AuthController
    if (/^\s*namespace :auth do$/u.test(line)) {
      inAuth = true;
      out.push('scope "auth" do');
      continue;
    }
    if (inAuth && /^\s*post :(\w+)$/u.test(line)) {
      const action = /post :(\w+)/u.exec(line)![1]!;
      out.push(`post "${action}", to: "auth#${action}"`);
      continue;
    }
    if (inAuth && /^\s*end$/u.test(line)) inAuth = false;
    // parseBlock reads `only: [:a]` but not the `%i[a b]` spelling, so those resources got every RESTful action (phantom new/edit routes)
    line = line.replace(
      /%i\[([^\]]*)\]/gu,
      (_m, items: string) =>
        `[${items
          .split(/\s+/u)
          .filter(Boolean)
          .map((item) => `:${item}`)
          .join(", ")}]`,
    );
    // routes written with `controller:`/`action:` options instead of `to:`
    line = line.replace(/^(\s*\w+ "[^"]*"), controller: "(\w+)", action: "(\w+)"/u, '$1, to: "$2#$3"');
    // a nested path with `to:` that parseBlock reads as a path with no action; both are duplicated or listed in SYNTHETIC
    if (
      /^\s*get "\/:id\/(cancel|confirm)", to: "followers#/u.test(line) ||
      /^\s*get "edit\/(content|share)"/u.test(line) ||
      /^\s*get :show, to: redirect\("\/affiliates\/onboarding"\)/u.test(line)
    )
      continue;
    // redirect targets have no controller: give them one so they count as (trivial) routes
    line = line.replace(/(to:|=>)\s*redirect\b.*$/u, '$1 "/redirects#redirect"');
    line = line.replace(/^(\s*)(get|post|put|patch|delete|match)\s+("[^"]*")\s*=>\s*(.*)$/u, "$1$2 $3, to: $4");
    line = line.replace(/^(\s*)(get|post|put|patch|delete|match)\s+(:\w+)\s*=>\s*(.*)$/u, "$1$2 $3, to: $4");
    line = line.replace(/^(\s*)root to: (.*)$/u, '$1get "/", to: $2');
    line = line.replace(
      /^(\s*)resources? "(\w+)"/u,
      (m, ws: string) =>
        `${ws}${m.trim().startsWith("resource ") ? "resource" : "resources"} :${/"(\w+)"/u.exec(m)![1]}`,
    );
    // `namespace :x, path: "p"` and `scope path: "p", module: :m` keep their path in an option the parser does not read
    line = line.replace(/^(\s*)namespace :(\w+), path: "([^"]*)" do$/u, '$1scope "$3", module: "$2" do');
    line = line.replace(
      /^(\s*)scope (?!")(.*)\bpath: "([^"]*)"(.*) do$/u,
      (_m, ws: string, before: string, path: string, after: string) => {
        const module = /module: (?::(\w+)|"(\w+)")/u.exec(`${before}${after}`);
        return `${ws}scope "${path}"${module ? `, module: "${module[1] ?? module[2]}"` : ""} do`;
      },
    );
    line = line.replace(/^(\s*)resource :settings, only: \[\] do$/u, '$1scope "settings" do');
    line = line.replace(/^(\s*)scope (?:format|module): .* do$/u, (m, ws: string) => {
      const module = /module: (?::(\w+)|"(\w+)")/u.exec(m);
      return module ? `${ws}scope module: "${module[1] ?? module[2]}" do` : `${ws}scope do`;
    });
    // `resource :payments` pluralizes to `paymentses` in parseBlock; Rails keeps `payments`
    line = line.replace(
      /^(\s*)resource :(\w+s)(,|\s+do|$)(?!.*controller:)/u,
      (_m, ws: string, name: string, tail: string) =>
        `${ws}resource :${name}, controller: :${name}${tail === "," ? "," : tail}`,
    );
    // constraints and conditionals are transparent: both branches count, duplicates collapse later
    if (/^\s*constraints\b.*\bdo\s*$/u.test(line)) line = line.replace(/^(\s*)constraints\b.*$/u, "$1scope do");
    else if (/^\s*(if|unless)\b/u.test(line) && !/\bdo\s*$/u.test(line))
      line = line.replace(/^(\s*)(if|unless)\b.*$/u, "$1scope do");
    else if (/^\s*(else|elsif\b.*)$/u.test(line))
      line = `${/^\s*/u.exec(line)![0]}end\n${/^\s*/u.exec(line)![0]}scope do`;
    out.push(...line.split("\n"));
  }
  return out;
}

type Parsed = { routes: Route[]; unresolved: string[] };

export function parseRoutes(): Parsed {
  const lines = preprocess(readFileSync(ROUTES_RB, "utf8"), readFileSync(ADMIN_RB, "utf8"));
  const all = parseBlock(lines, 0, lines.length - 1, "", "");
  const unresolved = [...new Set(all.filter((route) => route.unresolved !== null).map((route) => route.unresolved!))];
  // `f(x)` and `f(x).f(x)` drawn on several hosts, `if`/`else` branches and PUT+PATCH twins collapse to one logical route
  const seen = new Map<string, Route>();
  for (const route of [...all.filter((route) => route.unresolved === null), ...SYNTHETIC]) {
    const method = route.method === "PUT" ? "PATCH" : route.method;
    const key = `${method} ${route.path.replace(/^\/api(?=\/)/u, "").replace(/\(\.:format\)$/u, "")} ${route.controller}#${route.action}`;
    if (!seen.has(key)) seen.set(key, { ...route, method });
  }
  return { routes: [...seen.values()], unresolved };
}

// ---- Node side ----

// Rails and routes.json spell the same route differently: the param name (`:id`, `:product_id`), a glob (`*url`) against a plain param, a
// format suffix on the key (`.json`, `.smil`) that Rails leaves implicit. All collapse to one placeholder so the two sides meet.
export const normalizeParams = (path: string) =>
  path
    .replace(/\.(json|txt|xml|smil)$/u, "")
    .replace(/\(\.:format\)$/u, "")
    .replace(/\.:format$/u, "")
    .replace(/:\w+(\([^)]*\))?/gu, ":p")
    .replace(/\/\*\w+/gu, "/:p");

// Routes Rails never had: the probe of the Node process (src/app/api/health), which is not a port of anything.
const NODE_ONLY_PATHS = new Set(["/api/health"]);

// The forms a Rails path can be registered under in routes.json: an optional trailing group (`/play/:grant(/*path)`) is two entries, and a
// param constrained to `/.*/` (`:url`) is a trailing glob (`*url`) there, because Next.js needs the glob to capture slashes.
export function pathForms(path: string): string[] {
  const optional = /^(.*)\((\/[^()]*)\)$/u.exec(path);
  const bases = optional ? [optional[1]!, optional[1]! + optional[2]!] : [path];
  return bases.flatMap((base) => (base.endsWith("/:p") ? [base, base.replace(/:p$/u, "*p")] : [base]));
}

// Path strings that interpolate a name (`${PAGES_PATH}/:slug`, `/${client}/v1/oauth2/authorize`): a constant of the same file with a plain
// string value is substituted, any other interpolation matches one path segment.
const templatePatterns: RegExp[] = [];
const INTERPOLATION = "\u0000";

function sourceLiterals(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, appDir: boolean) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, appDir);
      else if ((full.endsWith(".ts") || full.endsWith(".tsx")) && !full.endsWith(".test.ts")) {
        const text = readFileSync(full, "utf8");
        // A route key may carry the host scope Rails' constraints give it: `seller:/subscribe`.
        for (const match of text.matchAll(
          /["'`](?:(?:seller|product|api|discover|analytics):)?(\/[A-Za-z0-9_:*./()[\]+=-]*)["'`]/gu,
        ))
          found.add(normalizeParams(match[1]!));
        // Dispatch tables keyed by a regex (`/^\/media_urls\/([^/.]+)(?:\.json)?$/u`) are routes too: read the capture groups as parameters.
        for (const match of text.matchAll(/\/\^((?:\\\/(?:[\w-]+|\(\[\^\/\.\]\+\)))+)(?:\(\?:\\\.json\)\?)?\$\/u/gu))
          found.add(match[1]!.replace(/\\\//gu, "/").replace(/\(\[\^\/\.\]\+\)/gu, ":p"));
        // omniauth-phases.ts builds each strategy's callback path from its `name`, which no literal or template above can resolve.
        if (full.endsWith("omniauth-phases.ts"))
          for (const match of text.matchAll(/^ {4}name: "(\w+)",$/gmu)) found.add(`/users/auth/${match[1]!}/callback`);
        const constants = new Map(
          [...text.matchAll(/^(?:export )?const (\w+) = ["'`]([^"'`$]*)["'`]/gmu)].map((match) => [
            match[1]!,
            match[2]!,
          ]),
        );
        for (const match of text.matchAll(/`([^`\s]*\$\{[^`\s]*)`/gu)) {
          const resolved = match[1]!
            .replace(/\$\{(\w+)\}/gu, (whole, name: string) => constants.get(name) ?? whole)
            .replace(/\$\{[^}]*\}/gu, INTERPOLATION);
          if (!resolved.startsWith("/")) continue;
          const segments = normalizeParams(resolved).split(INTERPOLATION);
          // `/${x}` alone would match every one-segment route.
          if (segments.length > 1 && !segments.some((part) => /[A-Za-z0-9]/u.test(part))) continue;
          if (segments.length === 1) found.add(segments[0]!);
          else
            templatePatterns.push(
              new RegExp(
                `^${segments.map((part) => part.replace(/[.*+?^$|()[\]{}\\]/gu, "\\$&")).join("[^/]+")}$`,
                "u",
              ),
            );
        }
      }
    }
  };
  walk(SERVER_DIR, false);
  // App Router files: the directory path is the route (`[id]` is a parameter, `(app)` a group)
  const walkApp = (dir: string, segments: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (/^\(.*\)$/u.test(name)) walkApp(full, segments);
        else walkApp(full, [...segments, /^\[(\.\.\.)?(\w+)\]$/u.test(name) ? ":p" : name]);
      } else if (name === "page.tsx" || name === "route.ts")
        // A `builds.json` directory serves `/products/:id/builds(.json)`; routes.json and the Rails parse are compared without the format.
        found.add(normalizeParams(`/${segments.join("/")}`));
    }
  };
  walkApp(APP_DIR, []);
  return found;
}

const GENERIC_HANDLERS = new Set(["api-v2", "mobile", "internal", "internal-admin", "url_redirects"]);

function readAllServerText(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) text += readAllServerText(full);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) text += readFileSync(full, "utf8");
  }
  return text;
}

type Entry = {
  flag: string | null;
  handler?: string;
  mutation?: boolean;
  inertia?: boolean | string;
  redirect?: unknown;
  redirectReplace?: unknown;
  hosts?: string;
  methods?: string[];
};

type Registered = { methods: string[]; path: string; entry: Entry };

function registeredRoutes(): Registered[] {
  const table = JSON.parse(readFileSync(ROUTES_JSON, "utf8")) as Record<string, Entry | string>;
  return Object.entries(table).map(([key, value]) => {
    const entry: Entry = typeof value === "string" ? { flag: value } : value;
    const method = /^(GET|POST|PUT|PATCH|DELETE)\s+/u.exec(key);
    const rest = key
      .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/u, "")
      .replace(/^(seller|product|api|discover|analytics):/u, (_m, scope: string) => (scope === "api" ? "" : ""));
    return {
      methods: entry.methods ?? (method ? [method[1]!] : ["GET"]),
      path: normalizeParams(
        rest.replace(/^\/api(?=\/(?:v2|internal|mobile)\/)/u, "").replace(/\.(json|txt|xml|smil)$/u, ""),
      ),
      entry,
    };
  });
}

// ---- weights and workstreams (estimated by hand) ----

// 1 read-only DB; 2 DB writes; 3 external service (Stripe, PayPal, S3, Elasticsearch, mail, Sidekiq enqueue, LLM, DNS); 4 money movement
// or a complex multi-model flow. A route's weight is the verb default (GET 1, anything else 2) raised by its controller's floor below, and
// a few actions are overridden. The floors are judgements from reading the controllers, not measurements.
type Rule = { match: RegExp; workstream: string; floor: number };
const CONTROLLER_RULES: Rule[] = [
  { match: /^redirects$/u, workstream: "Redirect-only routes (no controller)", floor: 1 },
  { match: /^foreign_webhooks$/u, workstream: "WS-21 Payment processors", floor: 4 },
  { match: /^instant_payouts$/u, workstream: "WS-23 Balances and payouts", floor: 4 },
  {
    match: /^(connections|integrations\/|user_pages|seller_plan|instagram_callbacks|tiktok_callbacks|custom_domain\/)/u,
    workstream: "WS-10 Settings and account",
    floor: 1,
  },
  { match: /^(piracy_reports|purchase_custom_fields)$/u, workstream: "WS-12 Products and bundles", floor: 1 },
  { match: /^(comments|shipments)$/u, workstream: "WS-13 Audience, emails, workflows", floor: 2 },
  { match: /^(public|acme_challenges|test)$/u, workstream: "WS-11 Help, pages, blog, profiles", floor: 1 },
  { match: /^(secure_redirect)$/u, workstream: "WS-16 Library and content delivery", floor: 1 },
  { match: /^balance$/u, workstream: "WS-23 Balances and payouts", floor: 1 },
  { match: /^api\/internal\/admin\//u, workstream: "WS-18 Admin", floor: 3 },
  { match: /^admin\//u, workstream: "WS-18 Admin", floor: 1 },
  {
    match: /^api\/mobile\/(sales|purchases|subscriptions|preorders|commissions)/u,
    workstream: "WS-17 Public and mobile API",
    floor: 3,
  },
  {
    match: /^api\/v2\/(sales|payouts|licenses|subscribers|resource_subscriptions)/u,
    workstream: "WS-17 Public and mobile API",
    floor: 2,
  },
  {
    match: /^api\/v2\/(mcp|emails|marketing_actions|files|direct_uploads)/u,
    workstream: "WS-19 AI, MCP and moderation",
    floor: 3,
  },
  { match: /^api\/(v2|mobile|internal)\//u, workstream: "WS-17 Public and mobile API", floor: 1 },
  { match: /^api\//u, workstream: "WS-17 Public and mobile API", floor: 1 },
  {
    match: /^(orders|checkout|customer_surcharge|braintree|paypal|stripe|offer_codes|events)\b/u,
    workstream: "WS-20 Checkout and orders",
    floor: 3,
  },
  { match: /^purchases\b/u, workstream: "WS-20 Checkout and orders", floor: 3 },
  {
    match:
      /^(settings\/payments|settings\/stripe|settings\/billing|settings\/beneficial_owners|settings\/guardians|payouts|balances|oauth_completions|tax_center)\b/u,
    workstream: "WS-23 Balances and payouts",
    floor: 3,
  },
  {
    match: /^(settings|user|users|logins|signup|confirmations|two_factor_authentication|sellers|oauth|doorkeeper)\b/u,
    workstream: "WS-10 Settings and account",
    floor: 1,
  },
  {
    match:
      /^(help_center|gumroad_blog|home|pages|profile_sections|github_stars|favicons|robots|llms|indexnow_keys|mcp_connectors|gumclaw|embedded_javascripts|redirects|third_party_analytics|application|healthcheck|test_pings)\b/u,
    workstream: "WS-11 Help, pages, blog, profiles",
    floor: 1,
  },
  {
    match:
      /^(links|products|bundles|collaborators|affiliate|affiliates|global_affiliates|tags|product_|asset_previews|thumbnails|recommended_products|wishlists|reviews|product_reviews|offer_code|upsells|variant|custom_fields|cart_items_count|licenses|calls|commissions|review_videos)/u,
    workstream: "WS-12 Products and bundles",
    floor: 1,
  },
  {
    match:
      /^(followers|installments|posts|workflows|emails|audience|imported_customers|utm_link|affiliate_requests|communities|community)/u,
    workstream: "WS-13 Audience, emails, workflows",
    floor: 2,
  },
  { match: /^(discover|search)/u, workstream: "WS-14 Discover and search", floor: 1 },
  {
    match: /^(analytics|dashboard|customers|exports|churn|sales)/u,
    workstream: "WS-15 Analytics and exports",
    floor: 1,
  },
  {
    match: /^(library|url_redirects|dropbox_files|s3_utility|zip|media_|consumption|direct_upload)/u,
    workstream: "WS-16 Library and content delivery",
    floor: 1,
  },
  { match: /^(subscriptions|preorders)/u, workstream: "WS-20 Checkout and orders", floor: 3 },
  { match: /^(agent|ai|mcp)/u, workstream: "WS-19 AI, MCP and moderation", floor: 3 },
];
const FALLBACK_WORKSTREAM = "Unassigned (no rule matched)";

// Per action overrides of the floor: money leaves the building or a refund/charge is created.
const MONEY_ACTIONS =
  /^(refund|refund_taxes|refund_for_fraud|refund_all_for_fraud|refund_balance|charge_preorder|complete|issue|execute|add_credit|create_comment_and_refund|finalize|confirm|prepare|payout|pay)$/u;
const MONEY_CONTROLLERS =
  /^(orders|purchases|api\/internal\/admin\/(payouts|purchases|scheduled_payouts)|api\/v2\/sales|checkout|api\/mobile\/(purchases|sales))$/u;

function classify(route: Route): { workstream: string; weight: number } {
  const rule = CONTROLLER_RULES.find((candidate) => candidate.match.test(route.controller));
  const verbBase = route.method === "GET" ? 1 : 2;
  let weight = Math.max(verbBase, rule?.floor ?? 1);
  if (MONEY_ACTIONS.test(route.action) && MONEY_CONTROLLERS.test(route.controller)) weight = 4;
  if (route.controller === "orders" || route.controller === "customer_surcharge")
    weight = Math.max(weight, route.method === "GET" ? 3 : 4);
  if (/^(integrations\/|custom_domain\/)/u.test(route.controller)) weight = Math.max(weight, 3);
  if (/^(redirects)$/u.test(route.controller)) weight = 1;
  return { workstream: rule?.workstream ?? FALLBACK_WORKSTREAM, weight };
}

const classOf = (controller: string) =>
  `${controller
    .split("/")
    .map((part) => part.replace(/(^|_)(\w)/gu, (_, __, letter: string) => letter.toUpperCase()))
    .join("::")}Controller`;

// ---- the report ----

export type Row = Route & { status: "native" | "hands back" | "not registered"; workstream: string; weight: number };

export function rows(parsed: Parsed): Row[] {
  const registered = registeredRoutes();
  const literals = sourceLiterals();
  const serverText = readAllServerText(SERVER_DIR);
  return parsed.routes.map((route) => {
    const forms = pathForms(normalizeParams(route.path));
    const hit = registered.find(
      (candidate) =>
        forms.includes(candidate.path) &&
        (candidate.methods.includes(route.method) || (route.method === "PATCH" && candidate.methods.includes("PUT"))),
    );
    // Served natively when routes.json lists it and Node has code for it: a redirect entry, a literal pattern in src/server or an App Router
    // page/route file for the path, or (for the one-off handlers such as `favicon`) the handler name registered in src/server. A listed route
    // with none of these hands back.
    const served =
      hit !== undefined &&
      ((hit.entry.redirect ?? hit.entry.redirectReplace) !== undefined ||
        literals.has(hit.path) ||
        templatePatterns.some((pattern) => pattern.test(hit.path)) ||
        (hit.entry.handler !== undefined &&
          !GENERIC_HANDLERS.has(hit.entry.handler) &&
          new RegExp(`\\b${hit.entry.handler}\\s*:`, "u").test(serverText)));
    const status = hit === undefined ? "not registered" : served ? "native" : "hands back";
    return { ...route, status, ...classify(route) };
  });
}

const pct = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

function sumBy<T>(items: T[], pick: (item: T) => number) {
  return items.reduce((total, item) => total + pick(item), 0);
}

export function pageStatus() {
  const railsPages = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".rb"))
        for (const match of readFileSync(full, "utf8").matchAll(
          /(?:render inertia: |inertia_render |inertia: )"([A-Za-z0-9_/]+)"/gu,
        ))
          railsPages.add(match[1]!);
    }
  };
  walk(join(repoRoot, "app"));
  const nodeLiterals = new Set<string>();
  const walkNode = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkNode(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        for (const match of readFileSync(full, "utf8").matchAll(/"([A-Z][A-Za-z]+(?:\/[A-Za-z0-9_]+)+)"/gu))
          nodeLiterals.add(match[1]!);
    }
  };
  walkNode(SERVER_DIR);
  const sorted = [...railsPages].sort();
  return {
    total: sorted.length,
    ported: sorted.filter((page) => nodeLiterals.has(page)),
    missing: sorted.filter((page) => !nodeLiterals.has(page)),
  };
}

function jobStatus() {
  const text = readFileSync(REGISTRY, "utf8");
  const node = [...text.matchAll(/"runtime": "node"/gu)].length;
  const ruby = [...text.matchAll(/"runtime": "ruby"/gu)].length;
  return { node, ruby, total: node + ruby };
}

function countLines(dir: string, keep: (name: string, full: string) => boolean): number {
  let total = 0;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) total += countLines(full, keep);
    else if (keep(name, full)) total += readFileSync(full, "utf8").split("\n").length;
  }
  return total;
}

function codeVolume() {
  const node =
    countLines(
      SERVER_DIR,
      (name, full) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.includes(".generated.") &&
        !full.includes("__fixtures__"),
    ) + countLines(join(repoRoot, "nextjs/src/worker"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const ruby = ["models", "controllers", "services", "sidekiq", "business", "presenters"].reduce(
    (total, dir) => total + countLines(join(repoRoot, "app", dir), (name) => name.endsWith(".rb")),
    0,
  );
  return { node, ruby };
}

function flagCount(): number {
  const table = JSON.parse(readFileSync(ROUTES_JSON, "utf8")) as Record<string, Entry | string>;
  return new Set(
    Object.values(table)
      .map((entry) => (typeof entry === "string" ? entry : entry.flag))
      .filter(Boolean),
  ).size;
}

// Written by hand from workstreams.md "Open items" and the stream rows, parity-debt.md section 4 and parity-tasks.md (state of 2026-11-10).
// These are runtime hand-backs inside routes this inventory counts as native, so they are not in any percentage.
const PARTIAL_HAND_BACKS = [
  "WS-20 `POST /customer_surcharge`: VAT ids (vendor validation), US taxable states and Canadian provinces (TaxJar), commission and renewal lines, Payment Element requests and buyer-currency sellers (Stripe FX) hand back.",
  "WS-20 `GET /offer_codes/compute_discount`: a malformed query hands back. `PurchasesController` actions other than `revoke_access`/`undo_revoke_access` (`change_can_contact`, `refund`, `update`, `resend_receipt`, `confirm`, preorder and subscription charges) hand back. Checkout is the empty-cart page only: there is no purchase path in Node.",
  'WS-20 `POST /orders`: one free line of a plain one-time USD product runs in Node; every paid order hands back whole before its first write. Rails\' order for a tokenized card purchase is recorded (`orders_paid_purchase_parity_spec.rb`, Stripe answered by VCR cassettes) and `Purchase#calculate_fees` is ported with a golden, but the Stripe calls (payment method read, payment intent create and confirm, charge read), the balance and the post-charge jobs are not, so nothing serves it. Detail in parity-debt.md, "paid purchase".',
  "WS-20 cart save (`nextjs_checkout_cart_save`): `PATCH` and `PUT /checkout` run in Node for plain lines (a cart created or updated by account or browser guid, lines created, updated or soft deleted, the three alert redirects). Handed back whole before any write: a line with an affiliate, an accepted offer (upsell or cross-sell), a call start time or installments, a product or variant that is not found, a quantity or price that is not a plain non-negative whole number, url parameters that are not strings, a new line without a referrer, discount codes outside the cart schema, a request with no guid cookie, and a browser with two live carts. Flash text of the alert redirects is not compared by the replay (it lives in the encrypted session).",
  "WS-20 buyer refund requests (`nextjs_purchase_refund_requests`): `GET /purchases/:purchase_id/refund_request` renders for a signed-out visitor and `POST` writes the request (`Purchases::RefundRequestsController`; the signed token, the `buyer_refund_requests` flag, the refund window, the one-request-per-purchase rescue, the message strip/cut and the two `MailDeliveryJob`s are recorded; the POST counts `purchase_refund_request/ip` in Node). Handed back whole before any write: a signed-in buyer, a renewal of a subscription (the page; its price carries a recurrence label), a preorder charge whose policy is on its authorization purchase, a reason or message that is not text or holds a NUL or a lone surrogate, and a purchase with no email (Rails answers 422).",
  "WS-20 checkout processor guards (`nextjs_checkout_processor_guards`, `nextjs_orders_validations`): `POST /orders/prepare` answers a bot and a cart above 50 lines; `POST /orders/:id/{confirm,finalize,confirm_error}` answer 404 for a token that is not an order's (another scope, garbled, or the order is gone); `POST /braintree/generate_transient_customer_token` answers `null` for a blank nonce. Every other request hands back before any write: a prepare past the guards (order, PaymentIntent), a real order token (reads or moves money at Stripe) and a Braintree nonce (tokenized with Braintree). `GET /braintree/client_token` (Braintree call) and `POST /stripe/setup_intents` (Stripe calls on every path past the card-parameter refusals; its Rack::Attack rule is not counted in Node) are not registered.",
  "WS-12 web build player (`nextjs_product_build_player_files`): `POST /d/:id/play/:grant/heartbeat` runs in Node for an open play session (404 for a grant that is not a heartbeat grant of this content-page token, or a session that does not exist or belongs to another purchase; 204 and the last beat moved forward with GREATEST otherwise). A session past its two-minute expiry hands back whole, because Rails starts or reuses a replacement session and issues a new heartbeat grant. `GET /agent` is a registered redirect to `/mcp`. The other 19 routes not registered stay in Rails: the eight named in the lane brief (partner products and creators, ping signing rotate/disable, `Products::BuildsController#create`, Stripe setup intents, Braintree client token), `GET /paypal/connect` and `POST /paypal/disconnect` (PayPal partner calls), `GET /_/test/outgoing_traffic` (reads a real S3 object by design), `GET /(*path)` (a catch-all 404 that would send every unregistered path to Node), `POST /v2/partner/migrations` and the seven `/partner_migration` routes (account creation, sessions and mail, with Rack::Attack limits not proven).",
  "WS-20 PayPal billing agreements (`nextjs_paypal_billing_agreements`): `POST /paypal/billing_agreement_token` and `POST /paypal/billing_agreement` run in Node on the Gumroad host and render what PayPal answered, including the null Rails renders for a refusal or an answer without a token or id. Handed back whole before any call: a PayPal call that fails below HTTP (socket, OAuth token), a `billing_agreement_token_id` that is missing or not text, and an answer with a fractional number. The seller-domain and custom-domain copies stay in Rails. `connect`, `disconnect` and both Braintree token routes are not registered.",
  "WS-23 payout guards (`nextjs_payouts_guards`): `POST /settings/stripe/disconnect`, `POST /instant_payouts`, `GET /payouts/taxes/:year/:form_type/download`, `POST /payouts/taxes/:year/transaction_report` and `GET /oauth_completions/stripe` answer sign-in, the tax center switch, Pundit refusals, a missing tax form or Stripe account and a missing OAuth session; a disconnect, an instant payout, a tax form that exists, a report that is available and an OAuth session with Stripe data hand back whole (the last has no recorded example: a request spec cannot seed `session[:stripe_connect_data]`).",
  "WS-20 write guards (`nextjs_checkout_write_guards`): discount create, update and destroy run in Node for a plain code (`assertPlainCode`/`assertPlainProducts`; a code with an upsell, exclusions, options, ownership products, customer limits, a duration, tiers, a per-cart rule or a cancellation role, a change of products or of universal, a deleted code, the default discount of a product, a product with options or a membership, and a request that carries listing params hand back before any write); upsells create/update, `POST /purchases/:purchase_id/pings` and `PATCH /purchases/:purchase_id/variants/:variant_id` answer the 404 and Pundit refusal; every request that passes hands back whole.",
  "WS-20 checkout return (`nextjs_checkout_returns_guards`): `GET /checkout/returns/:id` answers the 404s of an order token that opens no order, an order with no charge holding a PaymentIntent and a `payment_intent` that is not that charge's; a matching return hands back whole before any write, because finalizing reads the PaymentIntent from Stripe and charges, records and mails the purchases. The `Checkout/Returns/Pending` page is therefore still unported (it renders only after that Stripe read), as is a `payment_intent` that is not a plain string.",
  "WS-21 processor calls (Stripe, Braintree, PayPal) hand back everywhere except the webhook receivers (`nextjs_foreign_webhooks`: Stripe, Stripe Connect, PayPal, SendGrid, Resend and the two SNS endpoints, recorded in `foreign_webhooks_parity_spec`; a delivery with a fractional or unsafe number, a JSON body Rails would munge or reject, a Stripe timestamp written as hex and an SNS notification Ruby would raise on hand back whole); job guards and refund/dispute reads are ported besides.",
  "WS-22 tax: TaxJar, `ZipTaxRate` selection, GeoIP and the VAT validators (VIES, Vatstack, IRAS, Revenu Quebec) hand back.",
  "WS-23 payouts page: compliant daily-frequency sellers, US sellers with a seasoned account (Stripe instant eligibility), large sellers with a cached balance blob and PayPal Connect hand back; there is no payout execution in Node.",
  "WS-12 product page: products with asset previews, a product with sections of its own, uploaded and oEmbed covers and the `wanted` and `purchase_id` params hand back; `recommended_by=search|discover` is served (the `DiscoverSearch` click is written) and a storefront seller's page renders the catalogue below the product. The editor serves plain digital products only; `LinksController#update/publish/index/search/card/price_check/release_preorder`, thumbnails, asset previews, variants, builds, marketing actions, waitlist and call availabilities are not ported.",
  "WS-11 profiles: custom HTML pages, a nested visitor param other than the list and hash forms of `tags` and the list of `filetypes`, and a repeated nested key (Rack::Attack's parser refuses it) hand back; tiered-membership cards, unknown section types (the 500 Rails raises) and wishlist owners without a username (external id subdomain) run in Node. `GET /features.md` runs in Node for a cookie-less request; the other `home#*` ERB pages, the `/js/gumroad*` embeds and `POST /custom_domain/verify` are not ported.",
  "WS-14 discover: the root page's random `recommended_products`, curated lists for visitors with cart products or purchases and the Black Friday page hand back; one recommended-wishlists example is handed back by the replay (E6).",
  "WS-15 customers page: a commission completion in progress that holds a processor reference, and review videos with an unprocessed thumbnail variant, hand back.",
  "WS-16 content delivery: `stream`, `read`, `play` and `captions.vtt` past the access gate hand back; download pages that list files, rich content, posts, integrations, licenses or polls hand back; signed-URL bytes: the S3 presign of the test environment's minio and the CloudFront signature are reproduced byte for byte from Rails' fixtures (`signed-urls-fixtures.test.ts`), the Cloudflare `verify` token and the production bucket, key and distribution choice are not.",
  "WS-17 mobile and v2: mobile purchases index/search (with rows) and show/archive/unarchive/delete of a purchase with a preorder, subscription, refund, review, post, variants, rich content, stamped PDF or media location, sales show and the mobile writes except `POST /mobile/subscriptions/:id/cancel` and the archive, unarchive and delete of a plain purchase hand back; v2 `GET /v2/payouts/upcoming`, `include_transactions` and card or European bank destinations hand back; v2 licenses are not served in Node.",
  "WS-10 settings writes: a float or huge integer in a snippet `id` hands back; password, team invitations (the Gumroad account's team and mailboxes only Mail can parse), passkey registration, login/signup POSTs and OAuth callbacks are only partly ported (see the not registered rows). The authenticator app endpoints run whole in Node. Sign in with Apple creates and links accounts in Node except for guest purchases to attach and adopting an unconfirmed account; the Google and Twitter callbacks run in Node (Google from the code exchange to the sign-in, with its own guest-purchase attach and picture), the YouTube, Instagram and TikTok connect callbacks run in Node whatever code, redirect URI or XHR header they carry, a new passkey registers in Node when its attestation is the `none` format with an ES256 key, and the Stripe Connect callback that creates or links accounts still hands back. The cursor and antigravity connector aliases of the OAuth authorize and token routes run in Node like muse, claude and chatgpt. `POST /settings/advanced/rotate_ping_signing_secret` and `DELETE /settings/advanced/disable_ping_signing` run whole in Node (`nextjs_settings_ping_signing_writes`; `ping_signing_settings` through raw SQL, and the advanced page carries `ping_signing_secret`): pings are still delivered by the Rails worker, which reads the stored secret, so a secret written from Node signs them. The random secret is checked by shape and against the stored row, not byte for byte.",
  "WS-19 MCP: the tool bodies other than `get_account`, `list_payouts`, `get_customers`, `get_sales_totals`, `list_sales`, `list_products`, `get_product`, `list_files`, `get_analytics`, `get_subscriptions`, `publish_product`/`unpublish_product`, `create_draft_product` (digital drafts), `update_product` (name, description, price, permalink), `create_discount_code` and `update_discount_code` and `expire_discount_code` (plain codes) hand back, so do `add_cover`, `add_file`, the bundle tools, memberships in `create_draft_product` and `ProductFileIngest`; the moderation logic exists but is wired to no route.",
  "WS-13 receipt mailer: the first receipt of a membership and of its free trial (a dollar product that renews at the same price) is served; renewal receipts, fixed-length, installment-plan and gifted memberships, a renewal that costs more or less than the first charge, and a gift receiver with a price, a hidden recipient or a physical product hand back; posts and workflow emails with files that have thumbnails throw `NotPortedError`.",
  "WS-15 purchases export (`nextjs_purchases_export`, `GET|POST /purchases/export`): signed-out POSTs, the mobile `access_token` form, an `in_seller_time_zone` that is not a plain word or a seller zone ActiveSupport does not map, dates that are not `YYYY-MM-DD` (with an optional time of day) and any result holding a sale Rails reads in an unspecified order or raises on hand back whole: several variants, gifts, tips, licenses or UTM links on one sale, a product with several custom fields, a sale in several orders, a tier with two live buy prices for one recurrence, a subscription with two live original purchases, a licensed product's variant, a gift receiver in the export or on another subscription than the sender's, a custom field Ruby escapes in its inspect, and the sales Rails raises a NoMethodError on (a missing subscription row or payment option, a SKU of a tiered membership). Everything else runs in Node: variants, SKUs, tax, affiliates, tips, reviews, licenses, UTM links, upsells, gifts, pre-orders, carts, PayPal, Connect and buyer-currency sales, GeoIP states and countries, subscription charges and installment plans.",
  "WS-12 `GET /bundles/create_from_email` (`nextjs_bundles_create_from_email`): the policy refusal, a bundle type the marketing email never sends and a price under the currency minimum answer in Node; creating the bundle (Link, Price and bundle product rows) and a link with no whole-number price hand back.",
  "WS-11 third-party analytics host: `GET /profile/:username` (`nextjs_third_party_analytics_profile`) and `GET /:link_id` (`nextjs_third_party_analytics_index`; a request with a `purchase_id` stays in Rails) run in Node. `GET /users/confirmation/new` (Devise's view inside the application layout) and `GET /_/test/outgoing_traffic` (a probe that reads one S3 object to prove the Rails process has outbound traffic) stay in Rails.",
  "WS-30 jobs: most Node jobs hand individual runs back to Ruby, so the job count above is an upper bound on finished jobs.",
];

// Not code to port: unweighted and not in any percentage.
const NON_CODE_ITEMS = [
  "Flag rollout: every converted route is behind a Flipper flag and none is enabled in production (workstreams.md). Enabling each means the shadow period README.md requires, lowest blast radius first (reads, JSON writes, then the money flags).",
  "Shadow traffic: no GET mirroring or rolled-back write comparison has run in staging or production.",
  "Parity proof for money and security paths: the unproven items of parity-debt.md section 4 (Cloudflare signed URLs and the production key, bucket and distribution choice, receipt rental redirects, the `$` flags) are open even where the route is native.",
  "Open parity tasks (parity-tasks.md): E2 to E5 (customers-page and surcharge cases ported without a recording), E6 (taxonomy routing 404 for one discover example), E8 (lint debt), E9 (`api-coverage.test.ts` and `lint:baseline` in CI for every branch).",
  "Production cutover: per-route flag flips, a written rollback plan per money stream (WS-20 to WS-23), and the database, Redis and Sidekiq bridges under production load.",
  "WS-30: port every remaining Sidekiq class and cron entry, then remove the Sidekiq bridge; `critical` (receipts) moves last.",
  "WS-40 Rails removal: delete Rails, Ruby specs whose fixtures are captured and the Gemfile; Prisma Migrate takes over the schema from a baseline migration. Not started.",
  "WS-41 drop Inertia (after WS-40): pages become plain Server Components; `routes.ts`, the compat router and `app/javascript` go. Not started.",
];

function build(): string {
  const parsed = parseRoutes();
  const all = rows(parsed);
  const native = all.filter((row) => row.status === "native");
  const registered = all.filter((row) => row.status !== "not registered");
  const volume = codeVolume();
  const weightOf = (row: Row) => row.weight;
  const workstreams = [...new Set(all.map((row) => row.workstream))].sort();
  const pages = pageStatus();
  const jobs = jobStatus();

  const out: string[] = [
    "# Remaining work",
    "",
    "Generated by `nextjs/scripts/remaining-work.ts` (run `node scripts/remaining-work.ts` from `nextjs/`); do not edit by hand.",
    "It inventories every route of `config/routes.rb` and `config/routes/admin.rb`, not only the API namespaces of [api-coverage.md](api-coverage.md).",
    "",
    "## Headline",
    "",
    "| Measure | Done | Total | Share |",
    "| --- | ---: | ---: | ---: |",
    `| Routes served natively (counted, static check) | ${native.length} | ${all.length} | ${pct(native.length, all.length)} |`,
    `| Routes registered in routes.json (counted; upper bound, adds the ${all.filter((row) => row.status === "hands back").length} listed under "hands back") | ${registered.length} | ${all.length} | ${pct(registered.length, all.length)} |`,
    `| Routes weighted by difficulty (counted routes, estimated weights) | ${sumBy(native, weightOf)} | ${sumBy(all, weightOf)} | ${pct(sumBy(native, weightOf), sumBy(all, weightOf))} |`,
    `| Same, registered in routes.json (upper bound) | ${sumBy(registered, weightOf)} | ${sumBy(all, weightOf)} | ${pct(sumBy(registered, weightOf), sumBy(all, weightOf))} |`,
    `| Rails Inertia pages with Node props (counted, string match) | ${pages.ported.length} | ${pages.total} | ${pct(pages.ported.length, pages.total)} |`,
    `| Sidekiq job classes running in Node (counted) | ${jobs.node} | ${jobs.total} | ${pct(jobs.node, jobs.total)} |`,
    "",
    "## Method",
    "",
    "- Routes are parsed from `config/routes.rb` and `config/routes/admin.rb` (Ruby is not executed). Helper methods that the file draws twice (`api_routes`, `product_info_and_purchase_routes`), `if`/`else` branches and `constraints` blocks are expanded once; a route is one unique `verb path controller#action`, with PUT and PATCH twins merged. Host constraints are not modelled, so a path served on two hosts counts once.",
    "- `devise_for`, `use_doorkeeper` and the two `mount`s generate routes the parser cannot see; they are listed by hand in `SYNTHETIC` in the script (counted as routes, but the list is mine, not Rails').",
    "- native: `nextjs/routes.json` lists the route for that method and path, and Node has code for the path: a literal pattern in `src/server` or an App Router `page.tsx`/`route.ts` for it. It is a static test (api-coverage.md uses the same idea for its three namespaces, without the App Router and one-off handler checks): a native route can still hand individual requests back at runtime (see the partial hand-backs below).",
    "- hands back: routes.json lists the route but no Node code for the path was found. not registered: no routes.json entry, so Rails serves it.",
    "- Difficulty weight (estimated, not counted): 1 read-only DB; 2 DB writes; 3 external service (Stripe, PayPal, S3, Elasticsearch, mail, Sidekiq enqueue, LLM, DNS); 4 money movement or a complex multi-model flow. The default is the verb (GET 1, other verbs 2), raised to the floor of the controller's rule (`CONTROLLER_RULES` in the script) and to 4 for money actions (`MONEY_ACTIONS`). The weights and the controller-to-workstream mapping are my judgement from reading the controllers; change a rule and rerun to see the effect.",
    '- Inertia pages: the component names Rails renders (`render inertia: "X/Y"`) against the same names appearing as string literals under `src/server`. A page that only appears in a hand-back list still matches, so this overstates.',
    "- Jobs: `runtime` of each class in `registry.generated.ts`. Many Node jobs hand individual runs back to Ruby, so this overstates too.",
    "",
    "## How to read the percentages",
    "",
    "- The route share counts endpoints, and an endpoint is one row whether it is a health check or a purchase. The weighted share corrects that only as far as my weights are right.",
    '- Neither number measures the code under the routes. A route is counted native as soon as Node serves its common path, while its hard branches (see "Known partial hand-backs") still go to Rails. The shares therefore overstate how much of the work is finished, most for checkout, payouts, and the mobile and MCP APIs.',
    `- Code volume cross-check (counted, not a completion measure): Node has ${volume.node.toLocaleString("en-US")} non-test lines under \`src/server\` and \`src/worker\`; Rails has ${volume.ruby.toLocaleString("en-US")} lines in \`app/{models,controllers,services,sidekiq,business,presenters}\`. TypeScript is not the same size as Ruby, and Node also holds infrastructure Rails does not (the proxy, the Sidekiq bridge, the parity helpers).`,
    `- ${flagCount()} distinct rollout flags gate the routes in routes.json; none is enabled in production.`,
    "",
    "## By workstream",
    "",
    "| Workstream | Routes | Native | Hands back | Not registered | Native % | Weight | Native weight | Weighted % |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const workstream of workstreams) {
    const mine = all.filter((row) => row.workstream === workstream);
    const done = mine.filter((row) => row.status === "native");
    out.push(
      `| ${workstream} | ${mine.length} | ${done.length} | ${mine.filter((row) => row.status === "hands back").length} | ${mine.filter((row) => row.status === "not registered").length} | ${pct(done.length, mine.length)} | ${sumBy(mine, weightOf)} | ${sumBy(done, weightOf)} | ${pct(sumBy(done, weightOf), sumBy(mine, weightOf))} |`,
    );
  }
  out.push(
    `| **All** | ${all.length} | ${native.length} | ${all.filter((row) => row.status === "hands back").length} | ${all.filter((row) => row.status === "not registered").length} | ${pct(native.length, all.length)} | ${sumBy(all, weightOf)} | ${sumBy(native, weightOf)} | ${pct(sumBy(native, weightOf), sumBy(all, weightOf))} |`,
    "",
    "## Sensitivity to the weights",
    "",
    "The weights are the soft part of this inventory, so here is the headline under other schemes (native routes over all routes, same counted statuses).",
    "",
    "| Scheme | Native weight | Total weight | Share |",
    "| --- | ---: | ---: | ---: |",
  );
  const schemes: [string, (row: Row) => number][] = [
    ["Every route counts 1 (the plain route share)", () => 1],
    ["Verb only: GET 1, other verbs 2", (row) => (row.method === "GET" ? 1 : 2)],
    ["Rubric weights 1 to 4 (the headline)", weightOf],
    ["Rubric weights doubled per step: 1, 2, 4, 8", (row) => 2 ** (row.weight - 1)],
  ];
  for (const [name, weigh] of schemes)
    out.push(
      `| ${name} | ${sumBy(native, weigh)} | ${sumBy(all, weigh)} | ${pct(sumBy(native, weigh), sumBy(all, weigh))} |`,
    );
  out.push("", "## By weight", "", "| Weight | Routes | Native | Native % |", "| ---: | ---: | ---: | ---: |");
  for (const weight of [1, 2, 3, 4]) {
    const mine = all.filter((row) => row.weight === weight);
    const done = mine.filter((row) => row.status === "native");
    out.push(`| ${weight} | ${mine.length} | ${done.length} | ${pct(done.length, mine.length)} |`);
  }

  out.push(
    "",
    "## By controller",
    "",
    "Sorted by remaining weight (weight of the routes not native), largest first.",
    "",
    "| Controller | Workstream | Routes | Native | Hands back | Not registered | Weight | Remaining weight |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  const controllers = [...new Set(all.map((row) => row.controller))].map((controller) => {
    const mine = all.filter((row) => row.controller === controller);
    const remaining = sumBy(
      mine.filter((row) => row.status !== "native"),
      weightOf,
    );
    return { controller, mine, remaining };
  });
  controllers.sort((a, b) => b.remaining - a.remaining || a.controller.localeCompare(b.controller));
  for (const { controller, mine, remaining } of controllers) {
    const done = mine.filter((row) => row.status === "native");
    const weights = [...new Set(mine.map((row) => row.weight))].sort().join("/");
    out.push(
      `| \`${classOf(controller)}\` | ${mine[0]!.workstream} | ${mine.length} | ${done.length} | ${mine.filter((row) => row.status === "hands back").length} | ${mine.filter((row) => row.status === "not registered").length} | ${weights} (${sumBy(mine, weightOf)}) | ${remaining} |`,
    );
  }

  out.push("", "## Routes that hand back (listed in routes.json, no Node code found)", "");
  const handBacks = all.filter((row) => row.status === "hands back");
  if (handBacks.length === 0) out.push("None.");
  for (const row of handBacks)
    out.push(`- \`${row.method} ${row.path}\` (\`${classOf(row.controller)}#${row.action}\`)`);

  const railsKeys = new Set(
    parsed.routes.flatMap((route) => pathForms(normalizeParams(route.path)).map((path) => `${route.method} ${path}`)),
  );
  const orphans = registeredRoutes().filter(
    // A glob key (`/d/:id/play/:grant/*path`) also stands for Rails' optional segment `(/*path)`, which normalizes onto the shorter path.
    (entry) =>
      !NODE_ONLY_PATHS.has(entry.path) &&
      !entry.methods.some((method) =>
        [entry.path, entry.path.replace(/\/:p$/u, "")].some((path) =>
          railsKeys.has(`${method === "PUT" ? "PATCH" : method} ${path}`),
        ),
      ),
  );
  out.push(
    "",
    "## routes.json entries that match no parsed Rails route",
    "",
    "A diagnostic for the matcher: each is either a path the parser or the matcher missed (it would understate the native share) or a stale entry.",
    "",
  );
  if (orphans.length === 0) out.push("None.");
  for (const orphan of orphans) out.push(`- \`${orphan.methods.join("|")} ${orphan.path}\` (\`${orphan.entry.flag}\`)`);

  out.push("", "## Rails Inertia pages without Node props", "");
  for (const page of pages.missing) out.push(`- \`${page}\``);
  out.push(
    "",
    "## Known partial hand-backs (inside routes counted as native)",
    "",
    "Copied by hand from workstreams.md, parity-debt.md and parity-tasks.md as of 2026-11-10; not recomputed by the script and not in any percentage.",
    "",
  );
  for (const item of PARTIAL_HAND_BACKS) out.push(`- ${item}`);
  out.push(
    "",
    "## Frontend and pages",
    "",
    `- Inertia pages Rails renders: ${pages.total}. With Node props: ${pages.ported.length} (${pct(pages.ported.length, pages.total)}), counted by name; the ${pages.missing.length} under "Rails Inertia pages without Node props" are the unported ones.`,
    "- The React page components are not rewritten: they are reused unchanged from `app/javascript` through the Inertia compatibility layer, so there is no per-component port to count until WS-41. Porting a page means its props, route and guards, which is what the page count measures.",
    "",
  );
  out.push("## Non-code items (unweighted, not in any percentage)", "");
  for (const item of NON_CODE_ITEMS) out.push(`- ${item}`);
  out.push("");
  if (parsed.unresolved.length > 0) {
    out.push("", "## Unresolved route statements", "", "Not counted in any total above.", "");
    for (const line of parsed.unresolved.sort()) out.push(`- \`${line.replace(/`/gu, "'")}\``);
  }
  out.push("");
  return out.join("\n");
}

if (import.meta.main && process.argv.includes("--rows")) {
  for (const row of rows(parseRoutes())) process.stdout.write(`${JSON.stringify(row)}\n`);
} else if (import.meta.main) {
  const document = build();
  if (process.argv.includes("--stdout")) process.stdout.write(document);
  else if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== document) {
      console.error(
        "docs/nextjs-rewrite/remaining-work.md is stale; run `node scripts/remaining-work.ts` from nextjs/",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, document);
    process.stdout.write(`wrote ${OUTPUT}\n`);
  }
}
