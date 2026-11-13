import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type Exchange } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";
import { standInDifferences, startStandIn, uncommittedReader, type StandIn } from "../src/stand-in";

// Replays payouts_instant_notice_parity_spec.rb: the Payouts page of a seller whose bank account carries Stripe ids. Rails reads the
// external account from Stripe twice (the instant payout props, then the notice); the stand-in answers what the fixture recorded and
// the replay holds Node to the same reads. Elasticsearch calls are Rails' own (the sales totals) and are not routed through the stand-in.
// A bank account Stripe lists instant payouts for gets the instant payout props, which Node does not build: it reads once, hands the
// request back and writes nothing of its own.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIR = "payouts_instant_notice_parity_spec";
const ROUTE_FLAGS = ["nextjs_payouts"];
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200";
// The sales totals behind a signed-in page read the purchases index, which the replayer does not seed: it is created
// empty, with the settings and mappings of the index Rails writes to.
const RAILS_PURCHASE_INDEX = "purchase-test";
// A lane sets PARITY_ES_INDEX_SUFFIX so its replay does not recreate the index another lane is reading.
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "";
const REPLAY_PURCHASE_INDEX = `purchases${ES_INDEX_SUFFIX}`;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    // Rails' Elasticsearch reads are recorded; the port's run in the server process, out of the replayer's reach.
    "http",
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    // Rack::MiniProfiler's authorization cookie for team members; its token lives in the Rails process.
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // insert_all leaves these to the database clock, which is not UTC on every machine.
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    // Rails specs run with PaperTrail off; Next writes the version row production writes.
    "db.versions",
    "db.users.updated.*.changes.updated_at",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.inertia.props._inertia_meta.1.content",
    "response.json.props._inertia_meta.1.content",
    "response.body",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    // The upcoming payout's dates follow the payout cycle.
    "response.inertia.props.next_payout_period_data.payout_date_formatted",
    "response.inertia.props.next_payout_period_data.displayable_payout_period_range",
    "response.json.props.next_payout_period_data.payout_date_formatted",
    "response.json.props.next_payout_period_data.displayable_payout_period_range",
  ],
};

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item (the cache refresh of a large seller's Payouts page).
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
        if (data === null) continue;
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as {
          class: string;
          args: unknown[];
          queue: string;
        };
        jobs.push({ class: item.class, args: item.args, queue: item.queue });
      }
      return jobs;
    },
  };
}

// The fixture without the Elasticsearch calls Rails made for the sales totals, which the timeline points at by index.
function stripeOnly(exchange: Exchange): Exchange {
  const kept = new Map<number, number>();
  const http = exchange.http.filter((call, index) => {
    const isStripe = new URL(call.url).host === "api.stripe.com";
    if (isStripe) kept.set(index, kept.size);
    return isStripe;
  });
  const timeline = (exchange.timeline ?? [])
    .filter((event) => event.type !== "http" || kept.has(event.index))
    .map((event) => (event.type === "http" ? { ...event, index: kept.get(event.index)! } : event));
  return { ...exchange, http, timeline };
}

const INSTANT_LISTED = "-serves-the-instant-payout-data-and-no-notice-";
const cases = readdirSync(path.join(FIXTURES_ROOT, SPEC_DIR))
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixturePath = path.join(FIXTURES_ROOT, SPEC_DIR, file);
    return [file.replace(/\.json$/u, ""), fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
  });

describe.skipIf(!url)("Payouts page instant payout notice parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let stripe: StandIn;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    const es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    const indices = (await es.indices.get({ index: RAILS_PURCHASE_INDEX })).body as Record<
      string,
      { settings: { index: { analysis: unknown } }; mappings: unknown }
    >;
    const source = indices[RAILS_PURCHASE_INDEX]!;
    await es.indices.delete({ index: REPLAY_PURCHASE_INDEX }, { ignore: [404] });
    await es.indices.create({
      index: REPLAY_PURCHASE_INDEX,
      body: {
        settings: { index: { number_of_shards: 1, number_of_replicas: 0, analysis: source.settings.index.analysis } },
        mappings: source.mappings,
      },
    });
    await es.close();
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    stripe = await startStandIn(uncommittedReader(client));
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    // Stands in for Rails: a request Node hands back arrives here.
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OUTBOUND_HTTP_STAND_IN: stripe.url,
      // Only its presence is compared; the stand-in never sees a real key.
      STRIPE_API_KEY: "sk_test_parity_stand_in",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

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

  it.each(cases)(
    "%s",
    async (name, fixturePath, index) => {
      const fixture = loadFixture(fixturePath);
      const expected = stripeOnly(fixture.exchanges[index]!);
      handedBack.length = 0;
      stripe.arm(expected.http);
      const options = {
        sql,
        redis: redisSeeder(redis),
        jobs: redisJobs(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        driftDates: true,
        beforeRequest: () => stripe.baseline(),
        rewriteRequest: (
          request: Parameters<typeof reencryptCookies>[0],
          loaded: Parameters<typeof reencryptCookies>[1],
          now: Date,
        ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
        compare: COMPARE,
      };
      try {
        if (name.includes(INSTANT_LISTED)) {
          // Rails builds the instant payout props from a third Stripe read of the balance; Node asks the bank account once, then Rails does.
          const result = await replayFixtureExchange(fixture, index, options);
          expect(handedBack.map(({ method, url }) => `${method} ${url}`)).toEqual(["GET /payouts"]);
          // The nav promotions are seeded by the signed-in filters before any page decides to hand back, as for every dashboard page.
          expect(Object.keys(result.exchanges[0]!.actual.db)).toEqual(["dashboard_nav_promotions"]);
          const seen = await stripe.finish();
          expect(seen.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
            `GET /v1/accounts/acct_parityinstant01/external_accounts/ba_parityinstant01`,
          ]);
          expect(seen.calls[0]).toMatchObject({ url: expected.http[0]!.url });
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, options));
        expect(handedBack).toEqual([]);
        const differences = standInDifferences(expected, await stripe.finish());
        if (differences.length > 0) throw new Error(differences.join("\n"));
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => /error|Error|at /u.test(line))
          .slice(-25)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
