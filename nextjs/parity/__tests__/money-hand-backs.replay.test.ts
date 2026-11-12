import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { compareExchange } from "../src/compare";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type CapturedExchange, type Exchange } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, formatReplay, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";
import { standInDifferences, startStandIn, timelineSegments, uncommittedReader, type StandIn } from "../src/stand-in";

// Replays the requests that reach a payment processor: PUT /purchases/:id/refund (spec/requests/purchases_refund_parity_spec.rb and
// purchases_refund_failures_parity_spec.rb, which records every branch after Stripe was called), POST
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
  "purchases_refund_failures_parity_spec",
  "purchases_refund_fee_retention_parity_spec",
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
// Mail goes out inside Sidekiq's ActiveJob wrapper; the recording keeps the wrapped job's class, arguments and queue.
const asJob = (item: QueuedJob): RawJob => {
  const wrapped = item.args[0] as { job_class?: string; arguments?: unknown[]; queue_name?: string } | undefined;
  const unwrapped =
    item.class === "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper" && wrapped?.job_class
      ? {
          class: wrapped.job_class,
          args: wrapped.arguments ?? [],
          queue: wrapped.queue_name ?? item.queue,
          activeJob: true,
        }
      : { class: item.class, args: item.args, queue: item.queue };
  return { ...unwrapped, ...(item.at === undefined ? {} : { at: item.at }) };
};
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

// A payout runs for as long as the Stripe gem sleeps between retries and the recorder took to set the example up, so the stamps of
// its rows land on either side of the 5s "<now>" window; which rows were written, in which order, is held by the timeline. A
// comment says when the payout failed, in words, so it is compared with the time taken out.
const INSTANT_PAYOUT_COMPARE = {
  ...COMPARE,
  ignore: [
    ...COMPARE.ignore,
    "db.*.inserted.*.created_at",
    "db.*.inserted.*.updated_at",
    "db.*.updated.*.changes.updated_at.*",
    "db.comments.inserted.*.content",
  ],
};
// An UPDATE that only moves updated_at to "<now>" (from a stamp at the edge of the 5s window) is whether the second ticked over: Rails recorded
// it for some examples and Node does not see the same tick.
function withoutClockBumps<T extends { db?: unknown }>(exchange: T): T {
  const db = structuredClone(
    (exchange.db ?? {}) as Record<string, { updated?: { changes: Record<string, unknown[]> }[] }>,
  );
  for (const [table, entry] of Object.entries(db)) {
    if (!entry.updated) continue;
    entry.updated = entry.updated.filter(
      (row) =>
        !Object.entries(row.changes).every(
          ([column, [was, is]]) => column === "updated_at" && (was === "<now>" || was === "<now-5s>") && is === "<now>",
        ),
    );
    if (entry.updated.length === 0) delete entry.updated;
    if (Object.keys(entry).length === 0) delete db[table];
  }
  return { ...exchange, db };
}
const UTC_STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/gu;
const commentContents = (exchange: { db?: unknown }) =>
  (
    ((exchange.db as Record<string, { inserted?: { content?: string }[] }> | undefined)?.comments?.inserted ?? []) as {
      content?: string;
    }[]
  ).map((comment) => (comment.content ?? "").replace(UTC_STAMP, "<time>"));

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
      // Only its presence is compared; the stand-in never sees a real key.
      STRIPE_API_KEY: "sk_test_parity_stand_in",
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

  const replayOptions = (name: string | typeof INSTANT_PAYOUT_COMPARE) => ({
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
    compare:
      typeof name !== "string"
        ? name
        : name.includes("404")
          ? { ignore: [...COMPARE.ignore, "response.body"] }
          : COMPARE,
  });

  afterAll(async () => {
    await server.stop();
    rails.close();
    await stripe.close();
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
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

  // Rails reads Stripe twice, claims the balances and writes the payout row, reads the destination account's balance, and only then
  // creates the payout with a random idempotency key.
  it("records Rails reading Stripe, writing the payout, reading the destination balance, then creating it with a random idempotency key", () => {
    const [, file, index] = cases.find(([, file]) => file.includes("instant_payouts_parity_spec"))!;
    const exchange = loadFixture(file).exchanges[index]!;
    expect(exchange.http.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      expect.stringMatching(/^GET \/v1\/accounts\/acct_\w+\/external_accounts\/ba_/u),
      "GET /v1/balance",
      "GET /v1/balance",
      "POST /v1/payouts",
    ]);
    expect(exchange.http[3]!.headers).toMatchObject({
      "idempotency-key": "<uuid>",
      "stripe-account": expect.stringMatching(/^acct_/u),
    });
    expect(timelineSegments(exchange.timeline!)).toEqual([
      [],
      [],
      ["balances", "payments", "payments_balances"],
      ["payments"],
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

    const dropped = named("the-connection-drops-after-the-f26c6d71");
    expect(paths(dropped).slice(3)).toEqual(Array<string>(4).fill("POST /v1/payouts"));
    expect(dropped.http.slice(3).every((call) => call.response.dropped === true)).toBe(true);
    expect(new Set(dropped.http.slice(3).map((call) => call.headers!["idempotency-key"])).size).toBe(1);
    expect(timelineSegments(dropped.timeline!).at(-1)).toEqual(["balances", "comments", "payments", "users"]);

    const rateLimited = named("stripe-answers-a-rate-limit");
    expect(paths(rateLimited).slice(3)).toEqual(["POST /v1/payouts"]);
    expect(rateLimited.http[3]!.response.status).toBe(429);

    const staleBank = named("stripe-answers-a-bank-account-53c07c4d");
    expect(timelineSegments(staleBank.timeline!).at(-1)).toEqual(["balances", "bank_accounts", "comments", "payments"]);

    const reversed = named("the-bank-payout-fails-and-the-i-70442b08");
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

  // Every branch of the refund after Stripe was called (purchases_refund_failures_parity_spec.rb). What a port is held to: which call
  // fails, how often the gem sends it (4 attempts on a 500 or a dropped connection, 1 on a 429 or a 4xx, all under one key), and that
  // a refusal writes nothing while a success books the ledger only after the last read.
  it("records the branches of a refund after the first Stripe call in the order Rails ran them", () => {
    const named = (example: string) => {
      for (const [, file, index] of cases) {
        if (!file.includes("purchases_refund_failures_parity_spec")) continue;
        const fixture = loadFixture(file);
        if (fixture.example.includes(example)) return fixture.exchanges[index]!;
      }
      throw new Error(`no fixture for ${example}`);
    };
    const calls = (exchange: ReturnType<typeof named>) =>
      exchange.http.map(
        (call) =>
          `${call.method} ${new URL(call.url).pathname.replace(/_\w+$/u, "")}${call.response.dropped ? " dropped" : ` ${call.response.status}`}`,
      );
    const keys = (exchange: ReturnType<typeof named>, method: string) =>
      new Set(exchange.http.filter((call) => call.method === method).map((call) => call.headers!["idempotency-key"]));
    const writtenAfterFirstCall = (exchange: ReturnType<typeof named>) =>
      timelineSegments(exchange.timeline!).slice(1).flat();

    const alreadyRefunded = named("reports the charge as already refunded");
    expect(calls(alreadyRefunded)).toEqual(["GET /v1/charges/ch 200", "POST /v1/refunds 400"]);
    expect(writtenAfterFirstCall(alreadyRefunded)).toEqual([]);
    expect(calls(named("answers insufficient balance"))).toEqual(["GET /v1/charges/ch 200", "POST /v1/refunds 400"]);
    expect(calls(named("cannot find the charge"))).toEqual(["GET /v1/charges/ch 404"]);

    const serverError = named("answers a server error");
    expect(calls(serverError)).toEqual(["GET /v1/charges/ch 200", ...Array<string>(4).fill("POST /v1/refunds 500")]);
    expect(keys(serverError, "POST").size).toBe(1);
    expect(writtenAfterFirstCall(serverError)).toEqual([]);

    const dropped = named("the connection drops on the refund request");
    expect(calls(dropped)).toEqual(["GET /v1/charges/ch 200", ...Array<string>(4).fill("POST /v1/refunds dropped")]);
    expect(keys(dropped, "POST").size).toBe(1);

    // A 429 is not rescued by refund_and_save!, so Rails answers 500; nothing is booked.
    const rateLimited = named("rate limits the refund request");
    expect(calls(rateLimited)).toEqual(["GET /v1/charges/ch 200", "POST /v1/refunds 429"]);
    expect(rateLimited.response.status).toBe(500);
    expect(writtenAfterFirstCall(rateLimited)).toEqual([]);

    // The refund exists at Stripe, the read back fails, and Rails books nothing: the money has moved with no local record.
    const unreadable = named("fails to return the refund");
    expect(calls(unreadable)).toEqual([
      "GET /v1/charges/ch 200",
      "POST /v1/refunds 200",
      ...Array<string>(4).fill("GET /v1/refunds/re 500"),
    ]);
    expect(writtenAfterFirstCall(unreadable)).toEqual([]);
    const unreadableRateLimit = named("rate limits the refund read and the money has moved");
    expect(unreadableRateLimit.response.status).toBe(500);
    expect(writtenAfterFirstCall(unreadableRateLimit)).toEqual([]);

    // The seller's own Stripe account: every call carries Stripe-Account, and a refused one is repeated against Gumroad's account.
    const fallback = named("falls back to Gumroad's Stripe account");
    expect(calls(fallback).filter((call) => call.endsWith("403"))).toHaveLength(3);
    expect(
      fallback.http.filter((call) => call.headers?.["stripe-account"]).map((call) => call.response.status),
    ).toEqual([403, 403, 403]);

    // A destination charge reads the transfer and the destination payment before the first write.
    const destination = named("hands a refund of a destination charge to Rails and books the fee reversal");
    expect(calls(destination)).toEqual([
      "GET /v1/charges/ch 200",
      "POST /v1/refunds 200",
      "GET /v1/refunds/re 200",
      "GET /v1/charges/ch 200",
      "GET /v1/transfers/tr 200",
      "GET /v1/charges/py 200",
    ]);
    const segments = timelineSegments(destination.timeline!);
    expect(segments.slice(0, 6)).toEqual(Array<string[]>(6).fill([]));
    expect(segments[6]).toEqual(expect.arrayContaining(["balance_transactions", "balances", "purchases", "refunds"]));
  });

  // The Stripe calls Rails makes after the ledger (purchases_refund_fee_retention_parity_spec.rb): the retained fee is collected once
  // the outermost transaction commits, so every one of these calls comes after the last write of the ledger, and a failure of the
  // collection changes nothing but the refund row. The excess reversal and the dispute-win reversal run inside the transaction.
  it("records the Stripe calls after the refund ledger in the order Rails ran them", () => {
    const fixtureOf = (example: string) => {
      for (const [, file, index] of cases) {
        if (!file.includes("purchases_refund_fee_retention_parity_spec")) continue;
        const fixture = loadFixture(file);
        if (fixture.example.includes(example)) return fixture.exchanges[index]!;
      }
      throw new Error(`no fixture for ${example}`);
    };
    type Exchange = ReturnType<typeof fixtureOf>;
    const calls = (exchange: Exchange) =>
      exchange.http
        .slice(6)
        .map(
          (call) =>
            `${call.method} ${new URL(call.url).pathname.replace(/\/(tr|ch|re|pyr|py|txn)_\w+/gu, "/$1")}${call.response.dropped ? " dropped" : ` ${call.response.status}`}`,
        );
    // After the sixth call (the destination payment) the ledger is written; which calls follow the last ledger write.
    const afterCommit = (exchange: Exchange) => {
      const timeline = exchange.timeline!;
      const lastJob = timeline.reduce((last, entry, at) => (entry.type === "job" ? at : last), -1);
      return timeline.slice(lastJob + 1).filter((entry) => entry.type === "http").length;
    };

    const reversal = fixtureOf("collects the retained fee by reversing a transfer");
    expect(calls(reversal)).toEqual([
      "GET /v1/transfers 200",
      "POST /v1/transfers/tr/reversals 200",
      "GET /v1/refunds/pyr 200",
      "GET /v1/balance_transactions/txn 200",
    ]);
    expect(afterCommit(reversal)).toBe(4);
    expect(reversal.http[7]!.headers).toMatchObject({
      "idempotency-key": "refund_fee_retention_reversal_1_tr_paritypayout01",
    });

    const second = fixtureOf("moves on to a second transfer");
    expect(calls(second)).toEqual([
      "GET /v1/transfers 200",
      "POST /v1/transfers/tr/reversals 400",
      "GET /v1/transfers/tr/reversals 200",
      "GET /v1/transfers 200",
      "POST /v1/transfers/tr/reversals 200",
      "GET /v1/refunds/pyr 200",
      "GET /v1/balance_transactions/txn 200",
    ]);

    // Nothing to reverse: the fee is written off with one more balance transaction and no further call.
    expect(calls(fixtureOf("writes the fee off"))).toEqual(["GET /v1/transfers 200"]);
    // A 500 is sent four times under one key, a dropped list four times, and the request still answers 200.
    expect(calls(fixtureOf("Stripe fails the reversal"))).toEqual([
      "GET /v1/transfers 200",
      ...Array<string>(4).fill("POST /v1/transfers/tr/reversals 500"),
    ]);
    expect(calls(fixtureOf("connection drops while listing"))).toEqual(
      Array<string>(4).fill("GET /v1/transfers dropped"),
    );

    expect(calls(fixtureOf("collects the retained fee with a transfer from the seller's account"))).toEqual([
      "GET /v1/transfers 200",
      "POST /v1/transfers 200",
    ]);
    expect(calls(fixtureOf("adopts a fee transfer Stripe already made"))).toEqual(["GET /v1/transfers 200"]);
    expect(calls(fixtureOf("keeps the fee pending when Stripe refuses the transfer"))).toEqual([
      "GET /v1/transfers 200",
      "POST /v1/transfers 400",
    ]);

    // The reversal of the excess VAT happens before the credit rows and inside the transaction, with a random idempotency key.
    const excess = fixtureOf("reverses the excess from the transfer");
    expect(calls(excess)).toEqual([
      "GET /v1/charges/ch 200",
      "GET /v1/transfers/tr 200",
      "POST /v1/transfers/tr/reversals 200",
      "GET /v1/refunds/pyr 200",
      "GET /v1/balance_transactions/txn 200",
    ]);
    expect(excess.http[8]!.headers).toMatchObject({ "idempotency-key": "<uuid>" });
    expect(afterCommit(excess)).toBe(0);
    // A transfer Stripe says is fully reversed is reported and the refund is booked; any other failure is a 500 and books nothing.
    expect(calls(fixtureOf("already fully reversed"))).toEqual([
      "GET /v1/charges/ch 200",
      "GET /v1/transfers/tr 200",
      "POST /v1/transfers/tr/reversals 400",
    ]);
    const failed = fixtureOf("answers 500 and books nothing");
    expect(failed.response.status).toBe(500);
    expect(calls(failed).filter((call) => call.startsWith("POST"))).toEqual(
      Array<string>(4).fill("POST /v1/transfers/tr/reversals 500"),
    );
    expect(failed.timeline!.filter((entry) => entry.type === "job")).toEqual([]);

    // The dispute-win transfer is found with a window starting at the win and reversed under a key built from the refund id.
    const won = fixtureOf("reverses the transfer Stripe made when the dispute was won");
    expect(calls(won).slice(0, 2)).toEqual(["GET /v1/transfers 200", "POST /v1/transfers/tr/reversals 200"]);
    expect(won.http[7]!.headers).toMatchObject({ "idempotency-key": "dispute_win_reversal_re_parityretain01" });
    expect(new URL(won.http[6]!.url).searchParams.get("created[gte]")).toBe(
      String(Date.UTC(2026, 9, 20) / 1000 - 60000),
    );
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

  // A shape Node does not take goes to Rails whole: no write, and no Stripe call that moves money (the reads before the claim are allowed).
  describe("instant payout shapes Node hands back", () => {
    const successCase = () => cases.find(([, file]) => file.includes("instant_payouts_parity_spec"))!;
    // `extraReads` answers the balance reads a second balance adds.
    const replayEdited = async (edit: (exchange: Exchange) => void, extraReads = 0) => {
      const [name, file, index] = successCase();
      const fixture = loadFixture(file);
      edit(fixture.exchanges[index]!);
      handedBack.length = 0;
      const recorded = fixture.exchanges[index]!.http;
      stripe.arm([...recorded, ...Array.from({ length: extraReads }, () => recorded[1]!)]);
      const result = await replayFixtureExchange(fixture, index, replayOptions(name));
      const seen = await stripe.finish();
      return { result, seen };
    };
    const expectHandedBack = (
      result: Awaited<ReturnType<typeof replayEdited>>["result"],
      seen: { calls: { method: string }[]; writtenAfter: string[] },
    ) => {
      expect(handedBack).toHaveLength(1);
      expect(Object.keys(result.exchanges[0]!.actual.db ?? {})).toEqual([]);
      expect(seen.calls.filter((call) => call.method !== "GET")).toEqual([]);
      expect(seen.writtenAfter).toEqual([]);
    };

    it("hands back a date that is not a YYYY-MM-DD day, before any read", async () => {
      const { result, seen } = await replayEdited((exchange) => {
        exchange.request.body = JSON.stringify({ date: "11/12/2026" });
      });
      expectHandedBack(result, seen);
      expect(seen.calls).toEqual([]);
    });

    it("hands back balances created at the same instant, whose order Ruby leaves open", async () => {
      const { result, seen } = await replayEdited((exchange) => {
        const table = exchange.seed.tables.balances!;
        // Half the recorded amount each, so both fit the instant balance Stripe reported.
        for (const row of table.rows) Object.assign(row, { amount_cents: 50000, holding_amount_cents: 50000 });
        table.rows.push({ ...table.rows[0]!, id: 2 });
      }, 3);
      expectHandedBack(result, seen);
    });
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
        const instant = name.startsWith("instant_payouts");
        const result = await replayFixtureExchange(
          fixture,
          index,
          replayOptions(instant ? INSTANT_PAYOUT_COMPARE : name),
        );
        if (!instant) assertParity(result);
        if (instant) {
          const [{ expected: want, actual }] = result.exchanges as [{ expected: Exchange; actual: CapturedExchange }];
          const differences = compareExchange(withoutClockBumps(want), withoutClockBumps(actual), {
            ...INSTANT_PAYOUT_COMPARE,
            ...(fixture.sessionCookie ? { sessionCookie: fixture.sessionCookie } : {}),
          });
          if (differences.length > 0)
            throw new Error(formatReplay({ ...result, exchanges: [{ expected: want, actual, differences }] }));
          expect(commentContents(actual)).toEqual(commentContents(want));
        }
        expect(handedBack).toEqual([]);
        const standInDiffs = standInDifferences(
          expected,
          await stripe.finish(),
          instant ? { ignoreTables: ["versions"] } : {},
        );
        if (standInDiffs.length > 0) throw new Error(standInDiffs.join("\n"));
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
