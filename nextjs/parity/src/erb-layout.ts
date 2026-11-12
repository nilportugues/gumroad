// Shared by the replays of spec/requests/erb_layout_pages_parity_spec.rb: the pages Rails renders in the `home` and `application` layouts.
// The body is compared byte for byte once the two per-request values in it are masked: the masked CSRF token of the meta tag and the CSP
// nonce. An example named "hands a ..." is one Node leaves to Rails whole. The Rails.cache of a Node test process is its own memory, so a
// replay file picks the star count that process starts with.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "./db";
import { loadFixture } from "./fixture";
import { type NextServer, startNextServer } from "./next-server";
import { assertParity, httpTransport, replayFixtureExchange, type Transport } from "./replay";
import { reencryptCookies, redisSeeder } from "./session";

const DEFAULT_SPEC = "erb_layout_pages_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
// What the spec writes to Rails.cache for the nav's star count.
export const STARS_KEY = "github_stars_antiwork/gumroad";
export const CACHED_STARS = 12_345;

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    "response.cookies.__profilin",
    // The masked token is random per request (the recorded bytes are one draw); the meta tag's is masked in the body the same way.
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
  ],
};

export const maskVolatile = (text: string) =>
  text
    .replace(/(<meta name="csrf-token" content=")[^"]*(")/u, "$1<csrf-token>$2")
    .replace(/(<script nonce=")[^"]*(")/gu, "$1<nonce>$2")
    // The per-form tokens of a Devise view: csrf.test.ts pins how each is derived from the session's.
    .replace(/(name="authenticity_token" value=")[^"]*(")/gu, "$1<csrf-token>$2");

// The recorder drops the CSP header as volatile, so masking the nonce would hide a header that names another nonce than the body's.
// The live response is the only place both exist: every nonce in the body must be allowed by the header.
export function assertNonceMatchesCsp(body: string, csp: string | null) {
  const nonces = [...body.matchAll(/<script nonce="([^"]*)"/gu)].map((match) => match[1]!);
  if (nonces.length === 0) return;
  expect(csp, "content-security-policy").not.toBeNull();
  for (const nonce of nonces) expect(csp).toContain(`'nonce-${nonce}'`);
}

const maskingTransport =
  (inner: Transport): Transport =>
  async (request) => {
    const response = await inner(request);
    if (!(response.headers.get("content-type") ?? "").includes("html")) return response;
    const raw = await response.text();
    assertNonceMatchesCsp(raw, response.headers.get("content-security-policy"));
    const text = maskVolatile(raw);
    // Debugging aid: where the body went, for diffing against the fixture.
    if (process.env.PARITY_DUMP_BODY) writeFileSync(process.env.PARITY_DUMP_BODY, text);
    return new Response(text, { status: response.status, headers: response.headers });
  };

export function describeErbLayoutReplay(
  title: string,
  options: { routeFlags: string; seed: Record<string, number | null>; github?: number; select: (name: string) => boolean; spec?: string; env?: Record<string, string> },
) {
  const FIXTURES = path.join("parity/fixtures/requests", options.spec ?? DEFAULT_SPEC);
  const url = process.env.PARITY_DATABASE_URL;
  const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
  const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
  const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
  const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];
  const cases = (existsSync(FIXTURES) ? readdirSync(FIXTURES) : [])
    .filter((file) => file.endsWith(".json") && options.select(file.replace(/\.json$/u, "")))
    .map((file) => {
      const fixturePath = path.join(FIXTURES, file);
      return [file.replace(/\.json$/u, ""), fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
    });

  describe.skipIf(!url)(title, () => {
    let client: PrismaClient;
    let sql: SqlExecutor;
    let redis: Redis;
    let server: NextServer;
    let rails: Server;
    let github: Server | undefined;
    const githubRequests: { path: string; version: string }[] = [];
    const handedBack: { method: string; url: string }[] = [];
    const saved = { ...process.env };

    beforeAll(async () => {
      client = new PrismaClient({ datasourceUrl: url });
      sql = prismaExecutor(client);
      const [hostAndPort = "", db = "0"] = redisHost.split("/");
      const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
      redis = new Redis({ host, port: Number(port), db: Number(db) });
      rails = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
      // Stands in for api.github.com, as the spec's WebMock stub does for Rails.
      if (options.github !== undefined) {
        github = createServer((request, response) => {
          githubRequests.push({ path: request.url ?? "", version: String(request.headers["x-github-api-version"]) });
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stargazers_count: options.github }));
        });
        await new Promise<void>((resolve) => github!.listen(0, "127.0.0.1", resolve));
      }
      server = await startNextServer({
        RAILS_ENV: "test",
        OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
        OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
        ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
        NEXTJS_ROUTE_FLAGS: options.routeFlags,
        RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
        SECRET_KEY_BASE,
        DATABASE_URL: url!,
        REDIS_HOST: redisHost,
        SIDEKIQ_REDIS_HOST: redisHost,
        JOBS_REDIS_URL: `redis://${redisHost}`,
        RAILS_CACHE_TEST_SEED: JSON.stringify(options.seed),
        ...options.env,
        ...(github ? { GITHUB_API_ORIGIN: `http://127.0.0.1:${(github.address() as { port: number }).port}` } : {}),
      });
    }, FIRST_COMPILE_TIMEOUT_MS);

    afterAll(async () => {
      await server?.stop();
      await new Promise((resolve) => rails?.close(resolve));
      await new Promise((resolve) => (github ? github.close(resolve) : resolve(undefined)));
      await closeAllRedis();
      await redis?.quit();
      await client?.$disconnect();
      process.env = saved;
    });

    it("finds the fixtures", () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases)(
      "%s",
      async (name, fixturePath, index) => {
        handedBack.length = 0;
        const fixture = loadFixture(fixturePath);
        for (const exchange of fixture.exchanges) {
          const body = exchange.response.body;
          if (typeof body === "string") exchange.response.body = maskVolatile(body);
        }
        try {
          const result = await replayFixtureExchange(fixture, index, {
            sql,
            redis: redisSeeder(redis),
            transport: maskingTransport(httpTransport(server.baseUrl)),
            rewriteRequest: (request, source, now) => reencryptCookies(request, source, SECRET_KEY_BASE, now),
            interceptHttp: false,
            compare: options.github === undefined ? COMPARE : { ignore: [...COMPARE.ignore, "http"] },
          });
          if (name.includes("hands-a-")) {
            const request = fixture.exchanges[index]!.request;
            expect(handedBack).toHaveLength(1);
            expect(handedBack[0]).toMatchObject({ method: request.method });
            expect(handedBack[0]!.url.split("?")[0]).toBe(request.path);
            expect(Object.keys(result.exchanges[0]!.actual.db ?? {})).toEqual([]);
            return;
          }
          expect(handedBack).toHaveLength(0);
          assertParity(result);
          // The one call Rails makes on a cold cache.
          if (options.github !== undefined)
            expect(githubRequests).toEqual([{ path: "/repos/antiwork/gumroad", version: "2022-11-28" }]);
        } catch (error) {
          const logs = server
            .output()
            .split("\n")
            .filter((line) => !/built-in version of this loader|^\s*$/u.test(line))
            .slice(-40)
            .join("\n");
          throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
        }
      },
      FIRST_COMPILE_TIMEOUT_MS,
    );
  });
}
