// Audits the API routes in config/routes.rb (v2, mobile, internal) against nextjs/routes.json and the controllers Node serves, and writes
// docs/nextjs-rewrite/api-coverage.md.
// Run from nextjs/: node scripts/api-coverage.ts [--check] [--stdout]
//   --check   exit 1 when the committed doc is stale (does not write)
//   --stdout  print the document instead of writing it
//
// Ruby is parsed, not executed (`rails routes` needs a Ruby install). The route DSL in the audited blocks is rubocop-formatted, so a block
// opens on a line ending in `do` and closes on `end`. Only the DSL forms below are understood; any other statement or block inside an
// audited namespace is reported as `unresolved` (with its source line) instead of being guessed, and so is every route nested under it:
//   scope / namespace / devise_scope, resources / resource (only, except, path, param, controller), collection / member (also `{ }`),
//   get / post / put / patch / delete / match with a string or symbol path and `to:` / `action:` / `on:` / `via:`.
//
// Status of a route:
//   native          routes.json lists it with a handler (or `mutation`), and the pattern is a string literal in src/server
//   hands back      routes.json lists it but nothing serves it natively, so the proxy sends it to Rails
//   not registered  routes.json has no entry; Rails serves it, the flag never applies
//   unresolved      the script could not turn the Ruby into a route
// "fixture" is y when a recorded exchange under nextjs/parity/fixtures requests this method and path (the most specific route wins).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const ROUTES_RB = join(repoRoot, "config/routes.rb");
const ROUTES_JSON = join(repoRoot, "nextjs/routes.json");
const FIXTURES_DIR = join(repoRoot, "nextjs/parity/fixtures");
const SERVER_DIR = join(repoRoot, "nextjs/src/server");
const OUTPUT = join(repoRoot, "docs/nextjs-rewrite/api-coverage.md");

type Namespace = "v2" | "mobile" | "internal-api-host" | "internal-gumroad";
type Route = { method: string; path: string; controller: string; action: string; unresolved: string | null };
type Entry = { flag: string | null; handler?: string; hosts?: string; mutation?: boolean };

// ---- config/routes.rb ----

const RESTFUL: Record<string, [string[], string, boolean]> = {
  // action: [methods, suffix, member?]
  index: [["GET"], "", false],
  create: [["POST"], "", false],
  new: [["GET"], "/new", false],
  show: [["GET"], "", true],
  edit: [["GET"], "/edit", true],
  update: [["PATCH", "PUT"], "", true],
  destroy: [["DELETE"], "", true],
};
const COLLECTION_ACTIONS = ["index", "create", "new"];
const SINGULAR_ACTIONS = ["show", "new", "create", "edit", "update", "destroy"];
const CANONICAL_ACTIONS = ["index", "create", "new", "show", "update", "destroy"];
const VERBS = ["get", "post", "put", "patch", "delete"];

type Frame = {
  kind: "scope" | "resources" | "resource" | "member" | "collection" | "other";
  path: string;
  module: string;
  // resources / resource only
  collectionPath?: string;
  memberPath?: string;
  nestedPrefix?: string;
  controller?: string;
  singular?: boolean;
  unresolved: string | null;
};

const singularize = (word: string) => (word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("s") ? word.slice(0, -1) : word);
const pluralize = (word: string) => (/[^aeiou]y$/u.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);
const join2 = (...parts: string[]) => parts.filter((part) => part !== "").join("/");
const absolute = (path: string) => `/${path.replace(/^\/+/u, "")}`.replace(/\/+$/u, "") || "/";

function parseArgs(rest: string): { positional: string | null; symbol: string | null; options: Record<string, string> } {
  const trimmed = rest.replace(/^\(/u, "").replace(/\)\s*(do.*)?$/u, "").trim();
  let positional: string | null = null;
  let symbol: string | null = null;
  const first = /^(?:"([^"]*)"|'([^']*)'|:(\w+))\s*(,|$)/u.exec(trimmed);
  if (first) {
    positional = first[1] ?? first[2] ?? null;
    symbol = first[3] ?? null;
  }
  const options: Record<string, string> = {};
  for (const match of trimmed.matchAll(/(\w+):\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|:\w+|true|false|[A-Za-z_][\w:.]*(?:\([^)]*\))?|\{[^}]*\})/gu)) {
    options[match[1]!] = match[2]!;
  }
  return { positional, symbol, options };
}

const stringOf = (value: string | undefined) => (value === undefined ? undefined : value.replace(/^["':]|["']$/gu, ""));
const listOf = (value: string | undefined) => (value === undefined ? undefined : [...value.matchAll(/:(\w+)/gu)].map((match) => match[1]!).concat(value.startsWith(":") ? [] : []));

function onlyList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.startsWith("[") ? listOf(value) : [stringOf(value)!];
}

function parseBlock(lines: string[], start: number, end: number, initialModule: string, initialPath: string): Route[] {
  const routes: Route[] = [];
  const stack: Frame[] = [{ kind: "scope", path: initialPath, module: initialModule, unresolved: null }];
  const top = () => stack[stack.length - 1]!;
  const unresolved = (path: string, source: string, frame: Frame) => routes.push({ method: "?", path, controller: "?", action: "?", unresolved: frame.unresolved ?? source });
  const controllerOf = (frame: Frame, name: string) => (name.startsWith("/") ? name.slice(1) : join2(frame.module, name));

  const addRoutes = (methods: string[], path: string, controller: string, action: string, frame: Frame, source: string) => {
    for (const method of methods) routes.push({ method, path: absolute(path), controller, action, unresolved: frame.unresolved === null ? null : frame.unresolved || source });
  };

  const resourceRoutes = (frame: Frame, name: string, args: ReturnType<typeof parseArgs>, singular: boolean, source: string): Frame => {
    const options = args.options;
    const pathName = stringOf(options.path) ?? name;
    const controllerName = stringOf(options.controller) ?? (singular ? pluralize(name) : name);
    const controller = controllerOf(frame, controllerName);
    const param = stringOf(options.param) ?? "id";
    let base = frame.path;
    if (frame.kind === "resources") base = frame.nestedPrefix!;
    else if (frame.kind === "member") base = frame.memberPath!;
    else if (frame.kind === "collection") base = frame.collectionPath!;
    else if (frame.kind === "resource") base = join2(frame.path, frame.collectionPath!.split("/").pop()!);
    const collectionPath = `${base}/${pathName}`;
    const memberPath = singular ? collectionPath : `${collectionPath}/:${param}`;
    const only = onlyList(options.only);
    const except = onlyList(options.except) ?? [];
    const defaults = singular ? SINGULAR_ACTIONS : Object.keys(RESTFUL);
    const actions = (only ?? defaults).filter((action) => !except.includes(action));
    for (const action of actions) {
      const spec = RESTFUL[action];
      if (!spec) {
        routes.push({ method: "?", path: absolute(collectionPath), controller, action, unresolved: `unknown action ${action}: ${source}` });
        continue;
      }
      const [methods, suffix, member] = spec;
      const path = singular || !member ? `${collectionPath}${suffix}` : `${memberPath}${suffix}`;
      addRoutes(methods, path, controller, action, frame, source);
    }
    return {
      kind: singular ? "resource" : "resources",
      path: collectionPath,
      module: frame.module,
      collectionPath,
      memberPath,
      nestedPrefix: singular ? collectionPath : `${memberPath.replace(`:${param}`, `:${singularize(name)}_${param}`)}`,
      controller,
      singular,
      unresolved: frame.unresolved,
    };
  };

  const verb = (frame: Frame, method: string, args: ReturnType<typeof parseArgs>, source: string, nameOverride?: string) => {
    const { positional, symbol, options } = args;
    const name = positional ?? symbol;
    const to = options.to;
    const toValue = to?.startsWith('"') || to?.startsWith("'") ? stringOf(to) : undefined;
    const via = options.via ? listOf(options.via)!.map((verbName) => verbName.toUpperCase()) : [method.toUpperCase()];
    if (name === null || name === undefined) return unresolved("?", `no path: ${source}`, frame);
    if (to !== undefined && toValue === undefined) return unresolved(name, `non-controller target (${to}): ${source}`, frame);
    const on = stringOf(options.on);
    let basePath: string;
    let controller: string | undefined;
    let action: string | undefined = stringOf(options.action);
    const inResource = frame.kind === "resources" || frame.kind === "resource" || frame.kind === "member" || frame.kind === "collection";
    if (inResource) {
      const asMember = frame.kind === "member" || on === "member";
      const asCollection = frame.kind === "collection" || on === "collection";
      // Rails' canonical actions get no path suffix inside member/collection (`put :update, on: :member` is PUT /emails/:email_id).
      const suffix = symbol !== null && CANONICAL_ACTIONS.includes(symbol) ? "" : `/${name}`;
      if (asMember) basePath = `${frame.memberPath}${suffix}`;
      else if (asCollection) basePath = `${frame.collectionPath}${suffix}`;
      else basePath = `${frame.nestedPrefix ?? frame.path}/${name}`;
      controller = frame.controller;
      action ??= name.split("/").pop();
      if (symbol === null && action === name.split("/").pop() && name.includes("/") && options.action === undefined) {
        return unresolved(basePath, `path with no action: ${source}`, frame);
      }
    } else {
      basePath = `${frame.path}/${name}`;
    }
    if (toValue !== undefined) {
      const [target, targetAction] = toValue.split("#");
      if (targetAction === undefined) return unresolved(basePath, `target without an action: ${source}`, frame);
      controller = controllerOf(frame, target!);
      action = targetAction;
    }
    if (controller === undefined || action === undefined) return unresolved(basePath, `no controller: ${source}`, frame);
    void nameOverride;
    addRoutes(via, basePath.replace(/\/+/gu, "/"), controller, action, frame, source);
  };

  for (let i = start; i <= end; i++) {
    const raw = lines[i]!;
    const text = raw.replace(/\s+#\s.*$/u, "").trim();
    if (text === "" || text.startsWith("#")) continue;
    if (text === "end") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const frame = top();
    const opens = /\bdo(\s*\|[^|]*\|)?$/u.test(text);
    const brace = /^(collection|member)\s*\{\s*(.*?)\s*\}$/u.exec(text);
    const keyword = /^(\w+)\b\s*(.*)$/u.exec(text);
    if (!keyword) {
      unresolved("?", text, { ...frame, unresolved: `unparsed: ${text}` });
      if (opens) stack.push({ ...frame, kind: "other", unresolved: `unparsed block: ${text}` });
      continue;
    }
    const [, word, rest] = keyword as unknown as [string, string, string];
    const args = parseArgs(rest.replace(/\s*do(\s*\|[^|]*\|)?$/u, ""));
    const push = (next: Frame) => {
      if (opens) stack.push(next);
    };

    if (brace) {
      const kind = brace[1] as "collection" | "member";
      const inner = /^(\w+)\b\s*(.*)$/u.exec(brace[2]!);
      const nested: Frame = { ...frame, kind };
      if (frame.kind !== "resources" && frame.kind !== "resource") unresolved("?", `${kind} outside resources: ${text}`, { ...frame, unresolved: "" });
      else if (inner && VERBS.includes(inner[1]!)) verb(nested, inner[1]!, parseArgs(inner[2]!), text);
      else unresolved("?", text, { ...frame, unresolved: "" });
      continue;
    }
    if (word === "scope" || word === "namespace") {
      const name = word === "namespace" ? (args.symbol ?? args.positional) : args.positional;
      const module = word === "namespace" ? name : stringOf(args.options.module);
      const path = word === "namespace" ? name : args.positional;
      // A scope without a path inside resources keeps the nesting (`scope module: :x do resources :y`).
      const keepsNesting = !path && (frame.kind === "resources" || frame.kind === "resource");
      push({ ...frame, kind: keepsNesting ? frame.kind : "scope", path: path ? `${frame.path}/${path}` : frame.path, module: module ? join2(frame.module, module) : frame.module, unresolved: frame.unresolved });
    } else if (word === "devise_scope") {
      push({ ...frame, kind: "scope" });
    } else if ((word === "resources" || word === "resource") && args.symbol !== null) {
      const next = resourceRoutes(frame, args.symbol, args, word === "resource", text);
      push(next);
    } else if ((word === "collection" || word === "member") && (frame.kind === "resources" || frame.kind === "resource")) {
      push({ ...frame, kind: word });
    } else if (VERBS.includes(word)) {
      verb(frame, word, args, text);
      if (opens) stack.push({ ...frame, kind: "other", unresolved: `block under a route: ${text}` });
    } else if (word === "match") {
      if (args.options.via === undefined) unresolved(args.positional ?? "?", `match without via: ${text}`, { ...frame, unresolved: "" });
      else verb(frame, "match", args, text);
    } else {
      unresolved("?", text, { ...frame, unresolved: "" });
      if (opens) stack.push({ ...frame, kind: "other", unresolved: `inside unsupported block: ${text}` });
    }
  }
  return routes;
}

function blockEnd(lines: string[], start: number): number {
  const indent = /^\s*/u.exec(lines[start]!)![0].length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i]!.trim() === "end" && /^\s*/u.exec(lines[i]!)![0].length === indent) return i;
  throw new Error(`no end for the block at line ${start + 1}`);
}

function railsRoutes(): Record<Namespace, Route[]> {
  const lines = readFileSync(ROUTES_RB, "utf8").split("\n");
  const find = (pattern: RegExp, from = 0) => {
    const index = lines.findIndex((line, i) => i >= from && pattern.test(line));
    if (index < 0) throw new Error(`routes.rb no longer has ${pattern}`);
    return index;
  };
  const v2 = find(/^\s*scope "v2", module: "v2"/u);
  const mobile = find(/^\s*scope "mobile", module: "mobile"/u);
  const internalApi = find(/^\s*namespace :internal do/u);
  const internalGumroad = find(/^\s*namespace :internal do/u, internalApi + 1);
  const run = (start: number, module: string) => parseBlock(lines, start, blockEnd(lines, start), module, "");
  return { v2: run(v2, "api"), mobile: run(mobile, "api"), "internal-api-host": run(internalApi, "api"), "internal-gumroad": run(internalGumroad, "api") };
}

// ---- Node side ----

const normalizeParams = (path: string) => path.replace(/:\w+/gu, ":p").replace(/\/\*\w+/gu, "/*p");

function sourceLiterals(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        for (const match of readFileSync(full, "utf8").matchAll(/["'`](\/[A-Za-z0-9_:*./-]*)["'`]/gu)) found.add(normalizeParams(match[1]!));
      }
    }
  };
  walk(SERVER_DIR);
  return found;
}

type Fixture = { method: string; path: string; host: string };

function fixtureRequests(): Fixture[] {
  const found: Fixture[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".json")) {
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/"source": "(?:request|controller)",\s*"method": "(\w+)",\s*"path": "([^"?]+)/gu)) {
          const ahead = text.slice(match.index!, match.index! + 1200);
          found.push({ method: match[1]!, path: match[2]!, host: /"host": "([^"]+)"/u.exec(ahead)?.[1] ?? "" });
        }
      }
    }
  };
  walk(FIXTURES_DIR);
  return found;
}

const routeRegex = (path: string) =>
  new RegExp(`^${path.split("/").map((part) => (part.startsWith(":") ? "[^/]+" : part.startsWith("*") ? ".+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))).join("/")}/?$`, "u");
const paramCount = (path: string) => path.split("/").filter((part) => part.startsWith(":") || part.startsWith("*")).length;

// ---- the report ----

type Row = Route & { status: string; flag: string; fixture: string };

const TITLES: Record<Namespace, string> = {
  v2: "API v2 (`/v2` on the API host, `/api/v2` on the Gumroad domain)",
  mobile: "Mobile API (`/mobile` on the API host)",
  "internal-api-host": "Internal API, API host (`/internal`, includes `/internal/admin`)",
  "internal-gumroad": "Internal API, Gumroad domain (`/internal`, JSON for the React Router pages)",
};

function build(): string {
  const routes = railsRoutes();
  const table = JSON.parse(readFileSync(ROUTES_JSON, "utf8")) as Record<string, Entry>;
  const index = new Map<string, { key: string; entry: Entry }>();
  for (const [key, entry] of Object.entries(table)) index.set(normalizeParams(key), { key, entry });
  const literals = sourceLiterals();
  const fixtures = fixtureRequests();

  const lookup = (ns: Namespace, method: string, path: string) => {
    const prefix = method === "GET" ? "" : `${method} `;
    const candidates =
      ns === "v2" ? [`${prefix}api:${path}`, `${prefix}/api${path}`] : ns === "mobile" ? [`${prefix}${path}`] : [`${prefix}${path}`, `${prefix}api:${path}`, `${prefix}/api${path}`];
    for (const candidate of candidates) {
      const hit = index.get(normalizeParams(candidate));
      if (!hit) continue;
      const apiHost = hit.entry.hosts === "api" || hit.key.includes("api:") || hit.key.includes("/api/");
      if (ns === "internal-api-host" && !apiHost) continue;
      if (ns === "internal-gumroad" && hit.entry.hosts === "api") continue;
      return hit.entry;
    }
    return null;
  };

  const sections: string[] = [];
  const totals: Record<string, Record<string, number>> = {};
  const rowsByNs = {} as Record<Namespace, Row[]>;
  for (const ns of Object.keys(routes) as Namespace[]) {
    const nsRoutes = routes[ns].filter((route) => route.unresolved === null);
    const patternOf = (route: Route) => (ns === "v2" ? route.path : route.path);
    const own = (fixture: Fixture) => {
      const path = fixture.path.replace(/^\/api(?=\/(?:v2|internal|mobile)\/)/u, "");
      if (ns === "v2") return path.startsWith("/v2/") ? path : null;
      if (ns === "mobile") return path.startsWith("/mobile/") ? path : null;
      const apiHost = fixture.host.startsWith("api.") || fixture.path.startsWith("/api/");
      if (!path.startsWith("/internal/")) return null;
      return (ns === "internal-api-host") === apiHost ? path : null;
    };
    const covered = new Set<string>();
    for (const fixture of fixtures) {
      const path = own(fixture);
      if (path === null) continue;
      const matches = nsRoutes.filter((route) => route.method === fixture.method.toUpperCase() && routeRegex(patternOf(route)).test(path));
      if (matches.length === 0) continue;
      const fewest = Math.min(...matches.map((route) => paramCount(route.path)));
      for (const route of matches) if (paramCount(route.path) === fewest) covered.add(`${route.method} ${route.path}`);
    }
    const rows: Row[] = routes[ns].map((route) => {
      if (route.unresolved !== null) return { ...route, status: "unresolved", flag: "", fixture: "" };
      const entry = lookup(ns, route.method, route.path);
      const served = entry !== null && (entry.handler !== undefined || entry.mutation === true) && literals.has(normalizeParams(route.path));
      const status = entry === null ? "not registered" : served ? "native" : "hands back";
      return { ...route, status, flag: entry?.flag ?? "", fixture: covered.has(`${route.method} ${route.path}`) ? "y" : "n" };
    });
    rowsByNs[ns] = rows;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    totals[ns] = counts;
  }

  const classOf = (controller: string) => controller.split("/").map((part) => part.replace(/(^|_)(\w)/gu, (_, __, letter: string) => letter.toUpperCase())).join("::") + "Controller";
  const out: string[] = [
    "# API route coverage",
    "",
    "Generated by `nextjs/scripts/api-coverage.ts` (run `node scripts/api-coverage.ts` from `nextjs/`); do not edit by hand.",
    "It compares the `api/v2`, `mobile` and `internal` routes of `config/routes.rb` with `nextjs/routes.json` and the sources under `nextjs/src/server`.",
    "",
    "- native: routes.json lists the route with a handler (or `mutation`) and the pattern is a string literal in `src/server`.",
    "- hands back: routes.json lists the route but nothing serves it natively, so the proxy sends it to Rails.",
    "- not registered: no routes.json entry, Rails serves it and no flag applies.",
    "- unresolved: the parser could not turn the Ruby into a route; the source line is listed under the table.",
    "- fixture: a recorded exchange under `nextjs/parity/fixtures` requests this method and path. For the two internal tables the host of the recording tells them apart.",
    "- A native route can still hand an individual request back at runtime (`HandBackToRails`); this table does not count those.",
    "- `config/routes/admin.rb` (the web admin) and the aliases of WS-17c (`/ifttt`, `/muse`, `/claude`, `/chatgpt`, `/.well-known`, `/notion`) are outside this audit.",
    "",
    "## Summary",
    "",
    "| Namespace | Routes | Native | Hands back | Not registered | Unresolved |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const ns of Object.keys(routes) as Namespace[]) {
    const counts = totals[ns]!;
    const total = rowsByNs[ns].length;
    out.push(`| ${TITLES[ns]} | ${total} | ${counts.native ?? 0} | ${counts["hands back"] ?? 0} | ${counts["not registered"] ?? 0} | ${counts.unresolved ?? 0} |`);
  }
  for (const ns of Object.keys(routes) as Namespace[]) {
    out.push("", `## ${TITLES[ns]}`, "", "| Route | Ruby controller#action | Status | Flag | Fixture |", "| --- | --- | --- | --- | --- |");
    const resolved = rowsByNs[ns].filter((row) => row.unresolved === null);
    for (const row of resolved) out.push(`| \`${row.method} ${row.path}\` | \`${classOf(row.controller)}#${row.action}\` | ${row.status} | ${row.flag === "" ? "-" : `\`${row.flag}\``} | ${row.fixture} |`);
    const unresolvedRows = rowsByNs[ns].filter((row) => row.unresolved !== null);
    if (unresolvedRows.length > 0) {
      out.push("", "Unresolved:", "");
      for (const row of unresolvedRows) out.push(`- \`${row.unresolved!.replace(/`/gu, "'")}\``);
    }
  }
  out.push("");
  return out.join("\n");
}

const document = build();
if (process.argv.includes("--stdout")) process.stdout.write(document);
else if (process.argv.includes("--check")) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== document) {
    console.error("docs/nextjs-rewrite/api-coverage.md is stale; run `node scripts/api-coverage.ts` from nextjs/");
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, document);
  console.log(`wrote ${OUTPUT}`);
}
