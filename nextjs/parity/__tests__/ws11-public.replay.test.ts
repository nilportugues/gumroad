import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRailsCookieSecrets, readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsMessageVerifierVerified } from "@/server/auth/message-verifier";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { withoutRailsOnly } from "../src/rails-only";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import type { JobsChannel, RawJob } from "../src/channels";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/public_files_parity_spec.rb (robots.txt, llms.txt, the favicon, the IndexNow key, ACME challenges,
// crossdomain.xml), recorded through the full Rack stack. The GitHub stars counter reads Rails.cache, which a request spec fills
// in the Rails process only: github-stars.test.ts covers it.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIRS = ["public_files_parity_spec", "public_data_parity_spec", "sellers_switch_parity_spec"].filter((dir) => existsSync(path.join(FIXTURES_ROOT, dir)));
const NOT_REPLAYED = /github-stars/u;
const ROUTE_FLAGS = ["nextjs_robots", "nextjs_llms", "nextjs_crossdomain", "nextjs_favicon", "nextjs_indexnow_key", "nextjs_acme_challenge", "nextjs_public_lookup_data", "nextjs_embedded_analytics_js", "nextjs_public_working_webhook", "nextjs_sellers_switch"];
const INDEXNOW_KEY = "AbCd-1234-EfGh-5678";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    // Rack::MiniProfiler's authorization cookie for team members; Rails specs run with PaperTrail off.
    "response.cookies.__profilin",
    "db.versions",
    // Encrypted with a random IV: its content is compared below.
    "response.cookies.current_seller_id.value",
    // Masked per response; the ACME challenge's is raw bytes of the session's global token.
    "response.cookies.XSRF-TOKEN.value",
  ],
};

type SidekiqItem = { class: string; args: unknown[]; queue: string; wrapped?: string };

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item (ported classes) or plain Sidekiq items (the rest). A request spec's
// ActiveJob adapter is the test one, so Rails' mail deliveries are not in the fixtures: they are read back and asserted separately.
let mailJobs: SidekiqItem[] = [];
function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {
      mailJobs = [];
    },
    async drain(): Promise<RawJob[]> {
      const items: SidekiqItem[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data !== null) items.push(JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as SidekiqItem);
      }
      for (const key of await redis.keys("queue:*")) for (const raw of await redis.lrange(key, 0, -1)) items.push(JSON.parse(raw) as SidekiqItem);
      mailJobs = items.filter((item) => item.wrapped === "MailDeliveryJob");
      return items.filter((item) => item.wrapped !== "MailDeliveryJob").map((item) => ({ class: item.class, args: item.args, queue: item.queue }));
    },
  };
}

const allCases = SPEC_DIRS.flatMap((dir) =>
  readdirSync(path.join(FIXTURES_ROOT, dir))
    .filter((file) => file.endsWith(".json") && !NOT_REPLAYED.test(file))
    .map((file) => {
      const fixturePath = path.join(FIXTURES_ROOT, dir, file);
      return [file.replace(/\.json$/u, ""), fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
    }),
);

const VIEW_TOKEN_CASE = /a-view-token-for-the-referring-page/u;

// The script embeds the view token Link#analytics_view_token mints: for this product and referrer, valid for ten minutes.
function assertViewToken(script: string) {
  const token = /var token = "([^"]+)";/u.exec(script)?.[1];
  expect(token).toBeTruthy();
  process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
  const payload = railsMessageVerifierVerified("product_analytics_view", token!, "external_landing_page_view") as Record<string, unknown>;
  expect(payload).toMatchObject({ source_url: "https://landing.example/post" });
  expect(typeof payload.product_id).toBe("number");
  expect(String(payload.event_id)).toMatch(/^[0-9a-f-]{36}$/u);
  expect(railsMessageVerifierVerified("product_analytics_view", token!, "external_landing_page_view", new Date(Date.now() + 11 * 60_000))).toBeNull();
}

// CustomerMailer.grouped_receipt(purchases.ids[, recommendations:]).deliver_later(queue: "critical") for a lookup that found purchases.
function assertMailJobs(name: string, body: unknown) {
  const success = (body as { success?: boolean } | undefined)?.success === true;
  if (!/charge-data-|license-key-lookup-data-/u.test(name) || /paypal/u.test(name)) return;
  expect(mailJobs).toHaveLength(success ? 1 : 0);
  if (!success) return;
  const [job] = mailJobs;
  expect(job!.queue).toBe("critical");
  const [mailer, method, delivery, params] = (job!.args[0] as { arguments: [string, string, string, { args: unknown[]; _aj_ruby2_keywords: string[] }] }).arguments;
  expect([mailer, method, delivery]).toEqual(["CustomerMailer", "grouped_receipt", "deliver_now"]);
  const ids = params.args[0] as number[];
  expect(ids.length).toBeGreaterThan(0);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  expect(params.args).toHaveLength(/license/u.test(name) ? 2 : 1);
  if (/license/u.test(name)) expect(params.args[1]).toMatchObject({ recommendations: !/narrows-to-the-product/u.test(name) });
}

// Rails serves the throttled routes whole; rack-attack-routes.replay.test.ts replays those.
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);

describe.skipIf(!url)("WS-11 public files parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      INDEXNOW_KEY,
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
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
    async (_name, fixturePath, index) => {
      const result = await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        jobs: redisJobs(redis),
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        // The view token carries a fresh event id and an expiry: checked below instead.
        compare: VIEW_TOKEN_CASE.test(_name) ? { ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
      });
      try {
        assertParity(result);
        const expectedSeller = loadFixture(fixturePath).exchanges[index]!.response.cookies?.current_seller_id?.value as string | undefined;
        const actualSeller = result.exchanges[0]!.actual.response.cookies?.current_seller_id?.value as string | undefined;
        if (expectedSeller !== undefined || actualSeller !== undefined) {
          const read = (value: string | undefined) => readEncryptedCookie(deriveRailsCookieSecrets(SECRET_KEY_BASE), "current_seller_id", value);
          expect(read(actualSeller)).toBe(read(expectedSeller));
          expect(read(actualSeller)).toEqual(expect.any(Number));
        }
        if (VIEW_TOKEN_CASE.test(_name)) assertViewToken(String(result.exchanges[0]!.actual.response.body ?? ""));
        assertMailJobs(_name, loadFixture(fixturePath).exchanges[index]!.response.json);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !/built-in version of this loader|^\s*$/u.test(line)).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
