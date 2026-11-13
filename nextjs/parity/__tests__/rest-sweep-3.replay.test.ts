import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { withDriftedDates } from "../src/date-drift";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the specs of the third rest sweep (the purchases export), with the same method as dashboard-json.replay.test.ts: each fixture is a login,
// a CSRF fetch and the request under test, and only the last is replayed against `next dev` with the route flags on. A request the
// port hands back must reach the stand-in Rails with its body, before anything is written.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["purchases_export_parity_spec"];
const ROUTE_FLAGS = "nextjs_purchases_export";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item. The request spec's test adapter never queued the mail jobs (the
// fixtures hold none), so they are asserted apart from the others.
type MailItem = { wrapped?: string; queue: string; args: { arguments: unknown[] }[] };
const isMail = (item: MailItem) => item.wrapped?.endsWith("MailDeliveryJob") === true;
let mailJobs: MailItem[] = [];

function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {
      mailJobs = [];
    },
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      mailJobs = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data === null) continue;
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as MailItem & {
          class: string;
          args: unknown[];
          at?: number;
        };
        if (isMail(item)) mailJobs.push(item);
        else
          jobs.push({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as MailItem & { class: string; args: unknown[] };
          if (isMail(item)) mailJobs.push(item);
          else jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      // A job whose body stays in Ruby waits in Sidekiq's schedule until its time (PostToPingEndpointsWorker, five seconds out).
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as MailItem & { class: string; args: unknown[]; at?: number };
        if (isMail(item)) mailJobs.push(item);
        else
          jobs.push({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          });
      }
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    // Rails adds Vary: Accept to a JSON answer whose action never touched params; Node's answer helpers mark every render as having read them.
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // Rails' versions are off in the test environment (PaperTrail.enabled = false); models/concerns/paper-trail.test.ts pins Node's rows.
    "db.versions",
    "jobs.*.at",
    "http",
    // The export file is named after the second it was made in.
    "response.headers.content-disposition",
  ],
};

// Hour-granular seed tokens move a sale's minutes and seconds: "2026-03-04 05:06:07 +0000" keeps its day and loses its clock time.
const masked = (body: unknown) =>
  typeof body === "string"
    ? body.replace(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}( \+0000| UTC)/gu, "$1 <time>$2")
    : body;

const HANDED_BACK = /hands-|through-rails/u;

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

describe.skipIf(!url)("rest sweep 3", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      // The "from the IP address" examples stub Rails' GEOIP with this MaxMind test database.
      GEOIP_DATABASE_PATH: path.join(process.cwd(), "src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb"),
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

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  // A seed token ("<now-2995h>") keeps only the hours between the sale and the recording, so a sale replays at the replay's clock time
  // and the CSV's dates and the day boundaries of the time zone examples drift with it. Seeding at the clock time of the recording
  // (14:21:00 UTC on 2026-11-13, the middle of the recording run) and moving the expected dates by the days since keeps both.
  const RECORDED_CLOCK_UTC = [14, 21, 0] as const;
  const seedClock = () => {
    const pinned = new Date();
    pinned.setUTCHours(...RECORDED_CLOCK_UTC, 0);
    return pinned;
  };

  const options = (name = "") => ({
    seedClock: seedClock(),
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
        await redisSeeder(redis).reset(entries);
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    // Rails renders its debug page for these 404s in the test environment; only the status is compared.
    compare: name.includes("404")
      ? { ignore: [...COMPARE.ignore, "response.body", "response.json", "response.headers.content-type"] }
      : { ignore: [...COMPARE.ignore, "response.body"] },
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request down a code path compiles what it imports, which would age the seeded timestamps past the
  // replayer's tolerance. One warm-up per route is not enough: a 404 never reaches the modules a delete loads.
  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases) await replayFixtureExchange(file, index, options()).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = withDriftedDates(loadFixture(file), index, new Date(), ["body"]);
        if (HANDED_BACK.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options(name));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
            decodeURIComponent(request.path.split("?")[0]!),
          );
          if (request.body) expect(handedBack[0]!.body).toBe(request.body);
          expect(
            Object.keys(handed.exchanges[0]!.actual.db ?? {}).filter((table) => table !== "dashboard_nav_promotions"),
          ).toEqual([]);
          return;
        }
        // Rails and Node push in different orders across stores: both sides are compared sorted.
        const recorded = fixture.exchanges[index]!;
        recorded.jobs = [...(recorded.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        const result = await replayFixtureExchange(fixture, index, options(name));
        assertParity(result);
        const exchange = result.exchanges[0]!;
        expect(masked(exchange.actual.response.body)).toBe(masked(exchange.expected.response.body));
        expect(mailJobs).toHaveLength(0);
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
