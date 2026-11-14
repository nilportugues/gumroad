import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { redisJobsChannel } from "../src/active-job";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays Products::PublishSchedulesController: spec/requests/products_publish_schedules_parity_spec.rb. The last exchange of each fixture
// is sent to `next dev` with the route's flag on; a stand-in Rails receives whatever Node hands back. A request that carries
// `parity_hours_ahead` has its `local_time` moved to the same distance from the replay's clock, in the zone it names.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["products_publish_schedules_parity_spec"].filter((dir) => existsSync(path.join(FIXTURES, dir)));
const ROUTE_FLAGS = "nextjs_product_publish_schedules";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

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

const wallClock = (at: Date, zone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

// The recorded `local_time` was `parity_hours_ahead` hours from the recording's clock, in `parity_zone`.
function withLocalTime<T extends { body?: string | null }>(request: T, now: Date): T {
  if (typeof request.body !== "string" || !request.body.includes("parity_hours_ahead")) return request;
  const body = JSON.parse(request.body) as Record<string, unknown>;
  const ahead = new Date(now.getTime() + Number(body.parity_hours_ahead) * 3_600_000);
  return { ...request, body: JSON.stringify({ ...body, local_time: wallClock(ahead, String(body.parity_zone)) }) };
}

// "November 13, 2026 at 8:07 AM PST" for the wall-clock time the request sent, with the abbreviation Rails printed.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
function expectedLabel(localTime: string, recordedLabel: string): string {
  const [, year, month, day, hour, minute] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u
    .exec(localTime)!
    .map(Number) as number[];
  const abbreviation = recordedLabel.split(" ").at(-1)!;
  return `${MONTHS[month! - 1]} ${day}, ${year} at ${hour! % 12 === 0 ? 12 : hour! % 12}:${String(minute).padStart(2, "0")} ${hour! < 12 ? "AM" : "PM"} ${abbreviation}`;
}

// A fixed `local_time` with a `parity_zone`: the label is compared as recorded, and the stored instant must be that wall-clock time in
// the zone (the recording's `<now+Nh>` moves with the replay's clock, so it is ignored in favor of this check).
function checkFixedTime(
  sent: Record<string, unknown>,
  actual: { response: { json?: unknown }; db: Record<string, unknown> },
) {
  const local = String(sent.local_time);
  const zone = String(sent.parity_zone);
  const [year, month, day, hour, minute] = local.split(/[-T:]/u).map(Number) as number[];
  const wall = Date.UTC(year!, month! - 1, day, hour, minute);
  const offsets = Array.from({ length: 113 }, (_, index) => (index - 56) * 15);
  const instants = offsets
    .map((offset) => wall - offset * 60_000)
    .filter((at) => wallClock(new Date(at), zone) === local);
  expect(instants).toHaveLength(1);
  const inserted = (actual.db.product_publish_schedules as { inserted: { publish_at: string }[] }).inserted[0]!
    .publish_at;
  const hours = /^<now\+(\d+)h>$/u.exec(inserted)?.[1];
  expect(hours).toBeDefined();
  const expected = (instants[0]! - Date.now()) / 3_600_000;
  expect(Math.abs(Number(hours) - expected)).toBeLessThanOrEqual(1);
}

function checkScheduledTime(
  exchange: { request: { body?: string }; response: { json?: unknown } },
  actual: { response: { json?: unknown }; db: Record<string, unknown> },
) {
  const sent = JSON.parse(exchange.request.body ?? "{}") as Record<string, unknown>;
  if (sent.parity_hours_ahead === undefined && typeof sent.parity_zone === "string")
    return checkFixedTime(sent, actual);
  if (sent.parity_hours_ahead === undefined) return;
  const recorded = (exchange.response.json as { publish_schedule?: { label: string } } | undefined)?.publish_schedule;
  if (recorded === undefined) return;
  const got = (actual.response.json as { publish_schedule: { label: string } }).publish_schedule;
  // The label may straddle a minute boundary between the request and this check.
  const labels = [0, -1].map((minutes) =>
    expectedLabel(
      wallClock(
        new Date(Date.now() + Number(sent.parity_hours_ahead) * 3_600_000 + minutes * 60_000),
        String(sent.parity_zone),
      ),
      recorded.label,
    ),
  );
  expect(labels).toContain(got.label);
  const inserted = (actual.db.product_publish_schedules as { inserted: { publish_at: string }[] }).inserted[0]!
    .publish_at;
  const hours = Number(sent.parity_hours_ahead);
  // Whole minutes: the seconds of the request are dropped, so the stored time is up to a minute short of the distance asked for.
  expect([`<now+${hours * 60}m>`, `<now+${hours * 60 - 1}m>`]).toContain(inserted);
}

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec.replace(/_parity_spec$/u, "")}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

describe.skipIf(!url)("Product publish schedules", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
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
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = (file: string) => {
    const ignore = [...COMPARE.ignore];
    // Rails' debug page for a 404 is not recorded and sets the profiler cookie.
    if (readFileSync(file, "utf8").includes("rails exception debug page"))
      ignore.push("response.cookies", "response.body", "response.json");
    // The label and `publish_at` follow the replay's clock; `checkScheduledTime` judges them against the request instead.
    // A fixed time keeps its recorded label; only its stored instant moves with the clock.
    const recorded = readFileSync(file, "utf8");
    if (recorded.includes("parity_hours_ahead")) ignore.push("response.json.publish_schedule.label");
    if (recorded.includes("parity_hours_ahead") || recorded.includes("parity_zone"))
      ignore.push("db.product_publish_schedules.inserted.*.publish_at");
    return replayOptionsFor({ ignore });
  };

  const replayOptionsFor = (compare: { ignore: string[] }) => ({
    sql,
    jobs: redisJobsChannel(redis),
    redis: {
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => withLocalTime(reencryptCookies(request, loaded, SECRET_KEY_BASE, now), now),
    compare,
  });

  afterAll(async () => {
    await server.stop();
    rails.close();
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases.slice(0, 2))
        await replayFixtureExchange(file, index, replayOptions(file)).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Whatever Node cannot prove goes to Rails whole, before its first write.
        if (/-hands-an?-/u.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions(file));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, replayOptions(file));
        assertParity(result);
        checkScheduledTime(fixture.exchanges[index]!, result.exchanges[0]!.actual);
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
