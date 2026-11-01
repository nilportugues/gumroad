import { readdirSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { assertParity, replayFixtureExchange, routeHandlers, type Transport } from "../src/replay";
import { redisSeeder, reencryptCookies } from "../src/session";

// Replays spec/requests/signed_in_filters_spec.rb in process: the filters ApplicationController runs
// before an action (check_suspended, invalidate_session_if_necessary off the app's hosts), recorded
// through the full Rack stack after a real login. A suspended write never reaches its action, so the
// request goes straight through processAction with an action that fails the test if it runs; the
// session invalidation cases go through the real /healthcheck route handler.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/signed_in_filters_spec";
const SECRET_KEY_BASE = "parity-replay-secret-key-base";

// The cases where the filter lets the request through to its action.
const PASSES_THROUGH = [/lets-an-impersonating-admin-write/, /lets-a-suspended-user-read/];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.cookies.XSRF-TOKEN.value",
    // Rails specs run with PaperTrail off; Next writes the version row production writes.
    "db.versions",
    "db.users.updated.*.changes.updated_at",
  ],
};

const files = url ? readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json")) : [];

describe.skipIf(!url)("ApplicationController filters when signed in", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let actionRan = false;
  let transportFor: (request: string) => Promise<Transport>;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.RAILS_ENV = "test";
    process.env.DATABASE_URL = url;
    process.env.REDIS_HOST = redisHost;
    process.env.SIDEKIQ_REDIS_HOST = redisHost;
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const { setSqlClient } = await import("@/server/models/sql");
    setSqlClient(() => client);
    const { getRedis } = await import("@/server/infra/redis");
    redis = getRedis("main");
    const { processAction } = await import("@/server/controllers/application-controller");
    const healthcheck = await import("@/app/healthcheck/route");

    transportFor = async (requestPath) => {
      if (requestPath === "/healthcheck") return routeHandlers(healthcheck);
      return (request) =>
        processAction(request, {}, async () => {
          actionRan = true;
          return { status: 204, body: "", contentType: "text/html; charset=utf-8" };
        });
    };
  });

  afterAll(async () => {
    const { closeAllRedis } = await import("@/server/infra/redis");
    await closeAllRedis();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  it.each(files.map((file) => [file.replace(/^signed-in-filters-/, "").replace(/\.json$/, ""), file] as const))("%s", async (name, file) => {
    const fixture = loadFixture(path.join(FIXTURE_DIR, file));
    const index = fixture.exchanges.length - 1;
    const exchange = fixture.exchanges[index]!;
    actionRan = false;

    const result = await replayFixtureExchange(fixture, index, {
      sql,
      redis: redisSeeder(redis),
      transport: await transportFor(exchange.request.path),
      interceptHttp: false,
      rewriteRequest: (request, loaded, now) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
      compare: COMPARE,
    });

    if (PASSES_THROUGH.some((pattern) => pattern.test(name))) {
      // The stand-in action answers instead of the real one; what matters is that the filter let go.
      expect(actionRan).toBe(true);
      return;
    }
    // A refused write never reaches its action.
    expect(actionRan).toBe(false);
    assertParity(result);
  });
});
