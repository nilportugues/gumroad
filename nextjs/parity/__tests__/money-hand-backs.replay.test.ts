import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";
import { standInDifferences, startStandIn, timelineSegments, uncommittedReader, type StandIn } from "../src/stand-in";

// Replays the requests that reach a payment processor: PUT /purchases/:id/refund (spec/requests/purchases_refund_parity_spec.rb), POST
// /instant_payouts (instant_payouts_parity_spec.rb) and the settings save that creates a Stripe account
// (settings_payments_stripe_account_parity_spec.rb). Stripe is a stand-in (OUTBOUND_HTTP_STAND_IN) that
// answers the calls the fixture recorded and reports which tables had been written when each one arrived. A refusal Rails makes before
// it calls the processor must make no call and write nothing; an example named "hands a ..." must reach Rails whole, with no Stripe
// call and no write from Node (a refund past the guards moves money, and the ledger writes follow the calls).
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "purchases_refund_parity_spec",
  "instant_payouts_parity_spec",
  "instant_payouts_failures_parity_spec",
  "settings_payments_stripe_account_parity_spec",
];
const ROUTE_FLAGS = ["nextjs_purchases_seller_guards", "nextjs_payouts_guards", "nextjs_settings_payments_guards"].join(
  ",",
);
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

type QueuedJob = { class: string; args: unknown[]; queue: string; at?: number };
const asJob = (item: QueuedJob): RawJob => ({
  class: item.class,
  args: item.args,
  queue: item.queue,
  ...(item.at === undefined ? {} : { at: item.at }),
});
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the ones that stay in Ruby are in Sidekiq's own lists.
function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {
      /* the seeder flushes the database */
    },
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data !== null) jobs.push(asJob(JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as QueuedJob));
      }
      for (const key of await redis.keys("queue:*"))
        for (const raw of await redis.lrange(key, 0, -1)) jobs.push(asJob(JSON.parse(raw) as QueuedJob));
      for (const raw of await redis.zrange("schedule", "0", "-1")) jobs.push(asJob(JSON.parse(raw) as QueuedJob));
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "http",
  ],
};

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

describe.skipIf(!url)("requests that call a payment processor", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let stripe: StandIn;
  // Stands in for Rails: a request Node hands back arrives here, body and all.
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    stripe = await startStandIn(uncommittedReader(client));
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        handedBack.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OUTBOUND_HTTP_STAND_IN: stripe.url,
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = (name: string) => ({
    sql,
    redis: {
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    beforeRequest: () => stripe.baseline(),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: name.includes("404") ? { ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
  });

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await stripe?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handler",
    async () => {
      const [name, file, index] = cases.find(([name]) => name.includes("comma")) ?? cases[0]!;
      stripe.arm([]);
      await replayFixtureExchange(file, index, replayOptions(name)).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  // What the recording proves about Rails, which a port is held to: the four Stripe calls come before the first write, the refund
  // POST carries a random idempotency key, and the ledger is written after the last call.
  it("records Rails calling Stripe four times before it writes anything", () => {
    const [, file, index] = cases.find(([name]) => name.includes("hands-a-full-refund"))!;
    const exchange = loadFixture(file).exchanges[index]!;
    expect(exchange.http.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      expect.stringMatching(/^GET \/v1\/charges\/ch_/u),
      "POST /v1/refunds",
      expect.stringMatching(/^GET \/v1\/refunds\/re_/u),
      expect.stringMatching(/^GET \/v1\/charges\/ch_/u),
    ]);
    expect(exchange.http[1]!.headers).toMatchObject({ "idempotency-key": "<uuid>" });
    expect(exchange.http[1]!.headers!.authorization).toMatch(/^sha256:[0-9a-f]{16}$/u);
    const segments = timelineSegments(exchange.timeline!);
    expect(segments.slice(0, 4)).toEqual([[], [], [], []]);
    expect(segments[4]).toEqual(
      expect.arrayContaining([
        "audience_members",
        "balance_transactions",
        "balances",
        "credits",
        "purchases",
        "refunds",
      ]),
    );
    expect(exchange.timeline![0]).toEqual({ type: "http", index: 0 });
  });

  // Rails creates the payout row and moves the balance before it asks Stripe for the payout, and finishes the row after.
  it("records Rails reading Stripe twice, writing the payout, then creating it with a random idempotency key", () => {
    const [, file, index] = cases.find(([, file]) => file.includes("instant_payouts_parity_spec"))!;
    const exchange = loadFixture(file).exchanges[index]!;
    expect(exchange.http.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      expect.stringMatching(/^GET \/v1\/accounts\/acct_\w+\/external_accounts\/ba_/u),
      "GET /v1/balance",
      "POST /v1/payouts",
    ]);
    expect(exchange.http[2]!.headers).toMatchObject({
      "idempotency-key": "<uuid>",
      "stripe-account": expect.stringMatching(/^acct_/u),
    });
    expect(timelineSegments(exchange.timeline!)).toEqual([
      [],
      [],
      ["balances", "payments", "payments_balances"],
      ["payments"],
    ]);
  });

  // The post-call branches of StripePayoutProcessor.perform_payment: a dropped connection is retried by the Stripe gem under one key
  // and then recorded as an unknown outcome (balances back to unpaid, the seller held), a 429 is not retried, and a Gumroad-held
  // balance is transferred before the payout and reversed after its failure.
  it("records the failures of an instant payout in the order Rails wrote them", () => {
    const named = (needle: string) => {
      const [, file, index] = cases.find(([name]) => name.includes(needle))!;
      return loadFixture(file).exchanges[index]!;
    };
    const paths = (exchange: ReturnType<typeof named>) =>
      exchange.http.map((call) => `${call.method} ${new URL(call.url).pathname}`);

    const dropped = named("the-connection-drops-a-039d4a76");
    expect(paths(dropped).slice(2)).toEqual(Array<string>(4).fill("POST /v1/payouts"));
    expect(dropped.http.slice(2).every((call) => call.response.dropped === true)).toBe(true);
    expect(new Set(dropped.http.slice(2).map((call) => call.headers!["idempotency-key"])).size).toBe(1);
    expect(timelineSegments(dropped.timeline!).at(-1)).toEqual(["balances", "comments", "payments", "users"]);

    const rateLimited = named("stripe-answers-a-rate-1fa02d00");
    expect(paths(rateLimited).slice(2)).toEqual(["POST /v1/payouts"]);
    expect(rateLimited.http[2]!.response.status).toBe(429);

    const staleBank = named("stripe-answers-a-bank-238b951b");
    expect(timelineSegments(staleBank.timeline!).at(-1)).toEqual(["balances", "bank_accounts", "comments", "payments"]);

    const reversed = named("the-bank-payout-fails-a-73fcf293");
    expect(
      paths(reversed)
        .slice(2)
        .map((p) => p.replace(/\/(tr|py|txn)_\w+/gu, "/$1")),
    ).toEqual([
      "POST /v1/transfers",
      "GET /v1/charges/py",
      "POST /v1/payouts",
      "GET /v1/transfers/tr",
      "POST /v1/transfers/tr/reversals",
      "GET /v1/charges/py",
      "GET /v1/balance_transactions/txn",
    ]);
  });

  // The account row is inserted before the processor is called and filled in after.
  it("records Rails inserting the merchant account before it creates the Stripe account", () => {
    const [, file, index] = cases.find(([, file]) => file.includes("settings_payments_stripe_account_parity_spec"))!;
    const exchange = loadFixture(file).exchanges[index]!;
    expect(exchange.http.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /v1/accounts"]);
    expect(exchange.http[0]!.headers).toMatchObject({ "idempotency-key": "<uuid>" });
    expect(timelineSegments(exchange.timeline!)).toEqual([
      ["comments", "merchant_accounts", "tos_agreements", "users"],
      ["bank_accounts", "comments", "merchant_accounts"],
    ]);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        handedBack.length = 0;
        stripe.arm(expected.http);
        if (/hands-an?-/u.test(name)) {
          // Rails calls Stripe here; Node must not, and must not write: the request goes to Rails whole.
          const handed = await replayFixtureExchange(fixture, index, replayOptions(name));
          const request = expected.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(JSON.parse(handedBack[0]!.body)).toEqual(JSON.parse(request.body ?? "{}"));
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          const seen = await stripe.finish();
          expect(seen.calls).toEqual([]);
          expect(seen.writtenAfter).toEqual([]);
          return;
        }
        // A refusal Rails makes before the processor: the same response, no Stripe call, no write.
        const result = await replayFixtureExchange(fixture, index, replayOptions(name));
        assertParity(result);
        expect(handedBack).toEqual([]);
        expect(standInDifferences(expected, await stripe.finish())).toEqual([]);
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => !line.startsWith("Next.js includes"))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
