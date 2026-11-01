import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { withDriftedDates } from "../src/date-drift";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the checkout, subscription management and payouts request specs: the GET renders recorded through
// the full Rack stack, signed out and signed in. Each fixture is a login (and often a CSRF fetch or account
// switch) followed by the request under test, which is the last exchange.
//
// Dates: a fixture records "March 7th, 2026" for a payout made N days ago. The seeded rows are relative to
// the replay's clock, so the recorded strings are moved by the days since the recording (withDriftedDates).
// The dates of the upcoming payout follow the weekday, not the day, so those two fields are left out here and
// payout-schedule.test.ts pins them against the real module.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIRS = ["payouts_signed_in_spec", "subscriptions_manage_access_spec"];
const ROUTE_FLAGS = ["nextjs_payouts", "nextjs_subscription_manage"];
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200";
// The sales totals behind a signed-in page read the purchases index, which the replayer does not seed: it is created
// empty, with the settings and mappings of the index Rails writes to.
const RAILS_PURCHASE_INDEX = "purchase-test";
const REPLAY_PURCHASE_INDEX = "purchases";
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];

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

const cases = SPEC_DIRS.flatMap((dir) =>
  readdirSync(path.join(FIXTURES_ROOT, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixturePath = path.join(FIXTURES_ROOT, dir, file);
      return [`${dir.replace(/_signed_in_spec$|_spec$/g, "")}: ${file.replace(/\.json$/, "")}`, fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
    }),
);

describe.skipIf(!url)("Checkout, subscription and payouts parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    const es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    const source = (await es.indices.get({ index: RAILS_PURCHASE_INDEX })).body[RAILS_PURCHASE_INDEX];
    await es.indices.delete({ index: REPLAY_PURCHASE_INDEX }, { ignore: [404] });
    await es.indices.create({
      index: REPLAY_PURCHASE_INDEX,
      body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0, analysis: source.settings.index.analysis } }, mappings: source.mappings },
    });
    await es.close();
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      ELASTICSEARCH_HOST,
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
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
      const result = await replayFixtureExchange(withDriftedDates(loadFixture(fixturePath), index), index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
