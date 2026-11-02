import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptNumeric } from "@/lib/obfuscate-ids";
import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type Fixture, type FixtureRequest } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { resolveTimeToken } from "../src/canonical";
import { redisSeeder } from "../src/session";

// Replays the controller specs of the Api::V2 endpoints WS-17b ports (spec/controllers/api/v2/*_controller_spec.rb, recorded with
// PARITY_RECORD=all) against `next dev`. A controller spec's request is `get :show, params: { access_token: ..., format: :json }`, so the
// recorder keeps the params as the query (or form body) and a `.json` path; the replay sends them to the `/api/v2` form of the route
// (the main host; `/v2` is the same handler on the API host, covered by the route table test). A controller spec runs no Rack middleware: cookies are
// compared as a subset, and the headers Rack::ETag and SecureHeaders add are not in the recording.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/controllers/api/v2";
// Per controller spec: the Flipper flag of its routes and the methods Node serves (the rest stays with Rails and is not replayed).
const SPECS: Record<string, { flag: string; methods: string[]; exclude?: RegExp; include?: RegExp }> = {
  product_reviews_controller_spec: { flag: "nextjs_api_v2_product_reviews", methods: ["GET"] },
  offer_codes_controller_spec: { flag: "nextjs_api_v2_offer_codes", methods: ["GET"] },
  resource_subscriptions_controller_spec: { flag: "nextjs_api_v2_resource_subscriptions", methods: ["GET", "DELETE"] },
  // The other sales actions render Purchase#as_json, which is not ported.
  sales_controller_spec: { flag: "nextjs_api_v2_sales", methods: ["POST"], include: /resend-receipt/ },
  upsells_controller_spec: { flag: "nextjs_api_v2_upsells", methods: ["GET"] },
  earnings_controller_spec: { flag: "nextjs_api_v2_tax", methods: ["GET"] },
  // #download builds the PDF from Stripe or S3.
  tax_forms_controller_spec: { flag: "nextjs_api_v2_tax", methods: ["GET"], exclude: /-get-download-|-download-/ },
};
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const jobKey = (job: { class: string; args: unknown; queue?: string }) => `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

function redisJobs(redis: Redis): JobsChannel {
  const item = (raw: string) => JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
  return {
    async reset() {
      /* the seeder flushes the database */
    },
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      const push = (job: { class: string; args: unknown[]; queue: string; at?: number }) => jobs.push({ class: job.class, args: job.args, queue: job.queue, ...(job.at === undefined ? {} : { at: job.at }) });
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data !== null) push(item((JSON.parse(data) as { sidekiq: string }).sidekiq));
      }
      for (const key of await redis.keys("queue:*")) for (const raw of await redis.lrange(key, 0, -1)) push(item(raw));
      for (const raw of await redis.zrange("schedule", "0", "-1")) push(item(raw));
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.headers.etag",
    "response.cookies",
    "db.versions",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.resource_subscriptions.updated.*.changes.updated_at",
    "jobs.*.at",
    // The cursor holds the created_at of a row the replay seeds relative to its own clock.
    "response.json.next_page_key",
    "response.json.next_page_url",
    "http",
    // Error pages are recorded as a placeholder.
    "response.body",
  ],
};

// A page_key holds the created_at of the row that ended the previous page, recorded as an absolute time; the replay seeds that row
// relative to its own clock, so the key is rebuilt from the row (found by the id the key holds).
const PAGED_TABLES: Record<string, string> = { product_reviews_controller_spec: "product_reviews", offer_codes_controller_spec: "offer_codes", payouts_controller_spec: "payments" };
function pageKeyAtReplayTime(query: string, fixture: Fixture, request: FixtureRequest, now: Date): string {
  const table = PAGED_TABLES[path.basename(fixture.spec).replace(/\.rb$/u, "")];
  const exchange = fixture.exchanges.find((candidate) => candidate.request === request) ?? fixture.exchanges.at(-1)!;
  return query.replace(/page_key=(\d{20})-(\d+)/u, (match, _stamp: string, encrypted: string) => {
    const row = table === undefined ? undefined : (exchange.seed.tables[table]?.rows as Record<string, unknown>[] | undefined)?.find((candidate) => Number(candidate.id) === decryptNumeric(Number(encrypted)));
    const time = typeof row?.created_at === "string" ? resolveTimeToken(row.created_at, now) : null;
    return time === null || time === undefined ? match : `page_key=${time.toISOString().slice(0, 19).replace(/[-:T]/gu, "")}000000-${encrypted}`;
  });
}

// Examples whose recording cannot replay on another day or without the spec's stubs. The reason is in the test title.
const SKIPPED: [RegExp, string][] = [
  [/pagination-paginates-with-page-key #1|pagination-still-returns-a-review-whose-id-is-higher.* #1/u, "the spec stubs RESULTS_PER_PAGE to 1; its second page (the page_key request) is replayed"],
  [/returns-aggregated-earnings-in-cents/u, "sales dated 2025-03-15 and the like are seeded relative to the replay's clock, which moves them across the year the request names"],
  [/returns-filed-at-as-iso-8601/u, "filed_at is an epoch number inside json_data, which the seed does not shift"],
];

const cases = Object.keys(SPECS).flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file))] as const)
    // A shared example of a write action (`authorized oauth v1 api method`) calls it with `get`, which no route allows.
    .filter(([name]) => !SPECS[spec]!.exclude?.test(name) && (SPECS[spec]!.include?.test(name) ?? true))
    .filter(([name, , fixture]) => {
      const verb = /-(get|post|put|patch|delete)-/u.exec(name)?.[1]?.toUpperCase();
      return SPECS[spec]!.methods.includes(verb ?? fixture.exchanges.at(-1)!.request.method);
    })
    // The exchanges before the last of an example are often its setup (`put :create`), which Node does not serve.
    .flatMap(([name, file, fixture]) =>
      fixture.exchanges.flatMap((exchange, index) =>
        SPECS[spec]!.methods.includes(exchange.request.method) ? [[`${name}${fixture.exchanges.length > 1 ? ` #${index + 1}` : ""}`, file, index] as const] : [],
      ),
    );
});

describe.skipIf(!url)("Api::V2 endpoints of WS-17b", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    // The page keys of the recorded requests are rebuilt in this process (see pageKeyAtReplayTime).
    process.env.OBFUSCATE_IDS_CIPHER_KEY = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1] ?? "";
    process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = testEnv("OBFUSCATE_IDS_NUMERIC_CIPHER_KEY") ?? "0";
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      response.writeHead(599).end();
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: testEnv("OBFUSCATE_IDS_NUMERIC_CIPHER_KEY") ?? "0",
      NEXTJS_ROUTE_FLAGS: Object.values(SPECS).map((spec) => spec.flag).join(","),
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
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  const options = () => ({
    sql,
    redis: { reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries) },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    // `/v2/earnings.json` -> `/api/v2/earnings`: the main host serves the same routes under /api, without a format suffix.
    rewriteRequest: (request: FixtureRequest, fixture: Fixture, now: Date): FixtureRequest => ({
      ...request,
      path: String(request.path).replace(/^\/v2\//u, "/api/v2/").replace(/\.json$/u, ""),
      ...(request.query === undefined ? {} : { query: pageKeyAtReplayTime(request.query, fixture, request, now) }),
    }),
    compare: COMPARE,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  const [skipped, replayed] = [cases.filter(([name]) => SKIPPED.some(([pattern]) => pattern.test(name))), cases.filter(([name]) => !SKIPPED.some(([pattern]) => pattern.test(name)))];
  it.skip.each(skipped.map(([name]) => [`${name} (${SKIPPED.find(([pattern]) => pattern.test(name))![1]})`]))("%s", () => undefined);

  it.each(replayed)(
    "%s",
    async (_name, file, index) => {
      try {
        const result = await replayFixtureExchange(loadFixture(file), index, options());
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-30).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
