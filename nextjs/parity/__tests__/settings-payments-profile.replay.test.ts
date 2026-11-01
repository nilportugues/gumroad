import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/settings_payments_profile_signed_in_spec.rb: signed-in visits to the payments
// settings, the profile settings and the OAuth application editor, recorded through the full Rack stack
// after a real login (and, for team members, an account switch). Each fixture is a login followed by the
// request under test; only the last request is replayed.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/settings_payments_profile_signed_in_spec";
const ROUTE_FLAGS = ["nextjs_settings_payments"].join(",");
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];
// The test-only RSA key the specs' Strongbox columns are encrypted with (committed in .env.test).
const strongboxKey = /^STRONGBOX_GENERAL="(.+)"$/m.exec(envTest)?.[1]?.replaceAll("\\n", "\n");
const strongboxPassword = /^STRONGBOX_GENERAL_PASSWORD="?([^"\n]+)"?$/m.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    // Added by the test environment's Rack stack, not by the app.
    "response.headers.x-original-headers-class",
    // Next.js owns Cache-Control on rendered HTML (no-store).
    "response.headers.cache-control",
    // Rack::MiniProfiler's authorization cookie for team members; its token lives in the Rails process.
    "response.cookies.__profilin",
    // Masked per response.
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
    // _inertia_meta[2] is the csrf-token <meta>
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    // Both depend on the day the fixture is replayed on (payments-clock.test.ts pins them).
    "response.inertia.props.min_dob_year",
    "response.json.props.min_dob_year",
    "response.inertia.props.aus_backtax_details.credit_creation_date",
    "response.json.props.aus_backtax_details.credit_creation_date",
  ],
};

const files = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json"));
const cases = files.map((file) => [file.replace(/^payments-profile-and-application-settings-when-signed-in-/, "").replace(/\.json$/, ""), file] as const);

describe.skipIf(!url)("Payments, profile and application settings parity when signed in", () => {
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
      // External ids in the props; the Rails test environment has no numeric key, which reads as 0.
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      ...(strongboxKey && strongboxPassword ? { STRONGBOX_GENERAL: strongboxKey, STRONGBOX_GENERAL_PASSWORD: strongboxPassword } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
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
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  it.each(cases)(
    "%s",
    async (_name, file) => {
      const exchanges = loadFixture(path.join(FIXTURE_DIR, file)).exchanges;
      const result = await replayFixtureExchange(path.join(FIXTURE_DIR, file), exchanges.length - 1, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        // The server is another process, out of the replayer's reach.
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
