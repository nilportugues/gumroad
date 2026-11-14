import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";
import { setSubdomainRedirectorDepsForTesting } from "@/server/services/subdomain-redirector";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { inertiaPage } from "../src/http";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixture } from "../src/replay";

// Replays spec/controllers/help_center/{categories,articles}_controller_spec.rb against a running
// Next.js: the proxy attaches the Rails envelope (headers, cookies) and the App Router page renders
// the HTML whose `data-page` carries the Inertia component, props, url and version, so the whole
// response is compared. The legacy ".html" URLs never reach Next.js (route patterns exclude the
// format dot); the proxy test below checks they go to Rails.
const url = process.env.PARITY_DATABASE_URL;
const FIXTURE_DIRS = [
  "parity/fixtures/controllers/help_center/categories_controller_spec",
  "parity/fixtures/controllers/help_center/articles_controller_spec",
];
const ROUTE_FLAGS = "nextjs_help_center_category,nextjs_help_center_articles";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
// The recorded specs ran with the repo's .env.test, which the Next.js server does not load.
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8"))?.[1];

// A controller spec bypasses the Rack stack, so what the recorder saw differs from a served response:
//  - the session cookie and XSRF-TOKEN (set by middleware / inertia_rails' after_action) are not recorded;
//  - `link` preloads Vite's hashed assets, and Next.js ships its own;
//  - Next.js owns `vary` on rendered pages (it replaces whatever the proxy sets with its RSC list);
//  - csp_nonce and the CSRF tokens are random per response.
const COMPARE = {
  subset: ["response.cookies"],
  ignore: [
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    // _inertia_meta[2] is the csrf-token <meta>
    "response.inertia.props._inertia_meta.2.content",
  ],
};

const entries = FIXTURE_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ dir, file, exchange: loadFixture(path.join(dir, file)).exchanges[0]! })),
);
const served = entries.filter(({ exchange }) => !exchange.request.path.endsWith(".html"));
const legacyHtml = entries.filter(({ exchange }) => exchange.request.path.endsWith(".html"));

describe.skipIf(!url)("HelpCenter parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    server = await startNextServer({
      RAILS_ENV: "test",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      NEXTJS_ASSUME_SIGNED_OUT: "1",
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE: "parity-replay-secret-key-base",
      DATABASE_URL: url!,
      REDIS_HOST: process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await closeAllRedis();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures Next.js serves", () => {
    expect(served.length).toBe(entries.length - legacyHtml.length);
    expect(served.some(({ exchange }) => exchange.response.status === 200)).toBe(true);
  });

  it.each(served.map(({ dir, file }) => [path.basename(dir) + "/" + file, dir, file] as const))(
    "%s",
    async (_name, dir, file) => {
      const result = await replayFixture(path.join(dir, file), {
        sql,
        transport: httpTransport(server.baseUrl),
        // The server is another process, out of the replayer's reach.
        interceptHttp: false,
        compare: COMPARE,
      });
      assertParity(result);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  // What inertia_rails sends for X-Inertia requests. The controller specs never send the header, so
  // the expectations come from a Rails integration session against the same host and article.
  describe("Inertia protocol", () => {
    const ARTICLE = "/help/article/10-dealing-with-vat";
    const get = (pathAndQuery: string, headers: Record<string, string> = {}) =>
      fetch(new URL(pathAndQuery, server.baseUrl), {
        headers: { "x-forwarded-host": "app.test.gumroad.com:31337", "x-inertia": "true", ...headers },
        redirect: "manual",
      });
    // Next.js prepends its own RSC cache keys to Vary on every App Router response.
    const NEXT_VARY = /^(rsc|next-router-[a-z-]+|accept-encoding)$/iu;
    const railsVary = (response: Response) =>
      (response.headers.get("vary") ?? "")
        .split(/,\s*/u)
        .filter((token) => !NEXT_VARY.test(token))
        .join(", ");
    const cookieNames = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split("=")[0]);
    type PageJson = { component: string; props: Record<string, unknown>; url: string; version: unknown; encryptHistory: boolean; clearHistory: boolean };

    it("answers with the page as JSON, headers and cookies included", async () => {
      const response = await get(`${ARTICLE}?a=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("x-inertia")).toBe("true");
      expect(railsVary(response)).toBe("X-Inertia, Origin");
      expect(response.headers.get("x-gr")).toBe("DEV");
      expect(response.headers.get("x-revision")).toBe("no-revision");
      expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
      expect(response.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/u);
      expect(cookieNames(response).sort()).toEqual(["XSRF-TOKEN", "_gumroad_app_session_test", "_gumroad_guid"]);

      const text = await response.text();
      const page = JSON.parse(text) as PageJson;
      expect(Object.keys(page)).toEqual(["component", "props", "url", "version", "encryptHistory", "clearHistory"]);
      expect(page).toMatchObject({ component: "HelpCenter/Articles/Show", url: `${ARTICLE}?a=1`, version: null, encryptHistory: false, clearHistory: false });
      expect(Object.keys(page.props).slice(0, 3)).toEqual(["errors", "design_settings", "domain_settings"]);
      // ActiveSupport escapes HTML in JSON, so the body is safe to embed.
      expect(text).not.toMatch(/[<>&]/u);
    });

    it("carries the same page as the HTML response", async () => {
      const [json, html] = await Promise.all([get(ARTICLE), get(ARTICLE, { "x-inertia": "" })]);
      const embedded = inertiaPage(await html.text()) as unknown as PageJson;
      const page = (await json.json()) as PageJson;
      const volatile = (props: Record<string, unknown>) => {
        const { csp_nonce: _nonce, authenticity_token: _token, _inertia_meta: meta, ...rest } = props;
        return { ...rest, _inertia_meta: (meta as unknown[]).filter((_, i) => i !== 2) };
      };
      expect({ ...page, props: volatile(page.props) }).toEqual({ ...embedded, props: volatile(embedded.props) });
    });

    it("sends only the requested props for a partial reload", async () => {
      const response = await get(ARTICLE, { "x-inertia-partial-component": "HelpCenter/Articles/Show", "x-inertia-partial-data": "article,title" });
      const page = (await response.json()) as PageJson;
      expect(Object.keys(page.props)).toEqual(["errors", "title", "article", "_inertia_meta"]);

      const except = await get(ARTICLE, { "x-inertia-partial-component": "HelpCenter/Articles/Show", "x-inertia-partial-except": "article,design_settings" });
      const rest = ((await except.json()) as PageJson).props;
      expect(rest).not.toHaveProperty("article");
      expect(rest).not.toHaveProperty("design_settings");
      expect(rest).toHaveProperty("domain_settings");
    });

    it("ignores a partial reload for another component", async () => {
      const response = await get(ARTICLE, { "x-inertia-partial-component": "HelpCenter/Articles/Index", "x-inertia-partial-data": "title" });
      expect(Object.keys(((await response.json()) as PageJson).props)).toContain("article");
    });

    it.each(["abc", ""])("answers a stale asset version (%j) with a bare 409 that keeps the cookies", async (version) => {
      const response = await get(ARTICLE, { "x-inertia-version": version });
      expect(response.status).toBe(409);
      expect(response.headers.get("x-inertia-location")).toBe(`http://app.test.gumroad.com:31337${ARTICLE}`);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(railsVary(response)).toBe("Origin");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.has("x-gr")).toBe(false);
      expect(cookieNames(response).sort()).toEqual(["XSRF-TOKEN", "_gumroad_app_session_test", "_gumroad_guid"]);
      expect(await response.text()).toBe("");
    });

    it("answers a redirect with the redirect, and a stale redirect with the 409", async () => {
      const redirect = await get("/help/article/nope");
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("http://app.test.gumroad.com:31337/help");
      // The after_actions (XSRF-TOKEN) do not run when rescue_from redirects.
      expect(cookieNames(redirect).sort()).toEqual(["_gumroad_app_session_test", "_gumroad_guid"]);

      const stale = await get("/help/article/nope", { "x-inertia-version": "abc" });
      expect(stale.status).toBe(409);
      expect(stale.headers.get("x-inertia-location")).toBe("http://app.test.gumroad.com:31337/help/article/nope");
      expect(cookieNames(stale).sort()).toEqual(["_gumroad_app_session_test", "_gumroad_guid"]);
    });
  });

  describe("legacy .html URLs", () => {
    let proxy: (request: NextRequest) => Promise<Response>;

    beforeAll(async () => {
      process.env.RAILS_ENV = "test";
      process.env.NEXTJS_ROUTE_FLAGS = ROUTE_FLAGS;
      process.env.NEXTJS_ASSUME_SIGNED_OUT = "1";
      process.env.RAILS_ORIGIN = "http://rails.invalid";
      process.env.SECRET_KEY_BASE ??= "parity-replay-secret-key-base";
      setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
      proxy = (await import("@/proxy")).proxy as typeof proxy;
    });

    afterAll(() => setSubdomainRedirectorDepsForTesting(null));

    it.each(legacyHtml.map(({ file, exchange }) => [file, exchange.request] as const))("%s goes to Rails", async (_file, request) => {
      const response = await proxy(new NextRequest(`http://${request.headers.host}${request.path}`));
      expect(response.headers.get("x-middleware-rewrite")).toBe(`http://rails.invalid${request.path}`);
    });
  });
});
