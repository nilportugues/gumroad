import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRailsCookieSecrets, readEncryptedCookie } from "@/server/auth/rails-cookies";
import { closeAllRedis } from "@/server/infra/redis";

import { unwrapActiveJob } from "../src/active-job";
import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { assertNonceMatchesCsp, maskVolatile } from "../src/erb-layout";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { withoutRailsOnly } from "../src/rails-only";
import { assertParity, httpTransport, replayFixtureExchange, type Transport } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the audience routes added in WS-13/15 (follow cancel and /:username/follow, imported customer unsubscribe, post re-send,
// workflow emails save, the dashboard 1099 link). Each fixture is a login, a CSRF fetch where the route needs one, and the request under
// test; the last one is replayed against `next dev` with the route flags on. Examples named "hands a ..." must reach the Rails stand-in whole
// and write nothing; the rest compare the status, redirect, body, flash, every row written and every job enqueued.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "followers_cancel_and_new_spec",
  "imported_customers_unsubscribe_spec",
  "posts_send_for_purchase_spec",
  "workflows_emails_update_spec",
  "dashboard_download_tax_form_spec",
];
const ROUTE_FLAGS =
  "nextjs_followers_cancel,nextjs_followers_new,nextjs_imported_customers_unsubscribe,nextjs_posts_send_for_purchase,nextjs_workflows_writes,nextjs_dashboard_tax_form";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker"]);
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// A lane sets PARITY_ES_INDEX_SUFFIX so its replay does not recreate the index another lane is reading.
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "";
// The sending limit counts the seller's audience in Elasticsearch: an empty audience_members index (no seller in these fixtures has one).
async function resetAudienceIndex() {
  const es = new ElasticsearchClient({ node: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200" });
  await es.indices.delete({ index: `audience_members${ES_INDEX_SUFFIX}` }, { ignore: [404] });
  await es.indices.create({
    index: `audience_members${ES_INDEX_SUFFIX}`,
    body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0 } } },
  });
  await es.close();
}

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
          at?: number;
        };
        if (IGNORED_JOBS.has(item.class)) continue;
        jobs.push(
          unwrapActiveJob({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          }),
        );
      }
      // A job whose body stays in Ruby (Exports::AudienceExportWorker) goes straight to Sidekiq's list.
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
          jobs.push(unwrapActiveJob({ class: item.class, args: item.args, queue: item.queue }));
        }
      }
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

// Rails' versions are off in the test environment (PaperTrail.enabled = false), so the rows Node writes for them are not compared;
// models/concerns/paper-trail.test.ts and the golden of each write pin them.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.installments.updated.*.changes.updated_at",
    "db.workflows.updated.*.changes.updated_at",
    "db.installment_rules.updated.*.changes.updated_at",
    "db.followers.updated.*.changes.updated_at",
    "db.imported_customers.updated.*.changes.updated_at",
    "db.comments.updated.*.changes.updated_at",
    // The row is the seed's: stamped with the replay's clock, where the recording's request came seconds after the factory.
    "db.audience_members.deleted.*.created_at",
    "db.audience_members.deleted.*.updated_at",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
    // Next.js owns the per-response random values of an Inertia page (the cancel page).
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.inertia.props._inertia_meta.1.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    "response.json.props._inertia_meta.1.content",
  ],
};

// Rails raises a 404 in the test environment and the recorder keeps a marker for the debug page it renders, where Node answers as production does.
const EXCEPTION_PAGE = "<rails exception debug page";
function compareFor(file: string, name: string) {
  const exchanges = loadFixture(file).exchanges;
  const body = exchanges.at(-1)!.response.body;
  const ignore = [...COMPARE.ignore];
  // SecureRandom.uuid of the ConfirmedFollowerEvent job, and the audience member's details, which carry the follow's absolute created_at.
  if (name.includes("get-follow-id-cancel")) ignore.push("jobs.*.args.*.id", "db.audience_members.deleted.*.details");
  // SecureRandom.uuid tokens of the schedule intent and of the job that carries them
  if (name.includes("workflow-emails-save") && /publishes-the-workflow|reschedules-an-email/u.test(name))
    ignore.push(
      "db.workflow_installment_schedule_intents.inserted.*.token",
      "db.workflow_installment_schedule_intents.inserted.*.dispatch_token",
      "jobs.*.args.*",
    );
  // The row's time columns are seeded from the replay's clock while its details hold absolute dates, so the columns recomputed from
  // the details read as changed (and the Elasticsearch update lists them). The flags, paid amounts and follower_created_at stay compared.
  if (name.includes("keeps-the-audience-member"))
    ignore.push(
      ...["min_created_at", "max_created_at", "min_purchase_created_at", "max_purchase_created_at"].map(
        (column) => `db.audience_members.updated.*.changes.${column}`,
      ),
      "jobs.*.args.1.fields",
    );
  if (typeof body === "string" && body.startsWith(EXCEPTION_PAGE))
    ignore.push("response.json", "response.body", "response.cookies");
  return { ignore };
}

// The unsubscribe page is an ERB layout: its body is compared byte for byte once the per-request CSRF token and CSP nonce are masked
// on both sides, and every nonce in the body must be allowed by the response's Content-Security-Policy.
const ERB_PAGE_SPEC = "imported_customers_unsubscribe_spec";
const maskingTransport =
  (inner: Transport): Transport =>
  async (request) => {
    const response = await inner(request);
    if (!(response.headers.get("content-type") ?? "").includes("html")) return response;
    const raw = await response.text();
    assertNonceMatchesCsp(raw, response.headers.get("content-security-policy"));
    if (process.env.PARITY_DUMP_BODY) writeFileSync(process.env.PARITY_DUMP_BODY, maskVolatile(raw));
    return new Response(maskVolatile(raw), { status: response.status, headers: response.headers });
  };

// The `flash` entry of the session a response set, or null when it set no session or no flash.
function sessionFlash(
  secretKeyBase: string | undefined,
  sessionCookie: string | undefined,
  cookies: Record<string, { value?: unknown }> | undefined,
): unknown {
  const raw = sessionCookie ? cookies?.[sessionCookie]?.value : undefined;
  if (typeof raw !== "string" || !secretKeyBase) return null;
  const session = readEncryptedCookie(deriveRailsCookieSecrets(secretKeyBase), sessionCookie!, raw, new Date(0));
  return (session as { flash?: unknown } | null)?.flash ?? null;
}

const allCases = SPECS.flatMap((spec) => {
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

// Rails serves the throttled routes whole; rack-attack-routes.replay.test.ts replays those.
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);

describe.skipIf(!url)("audience routes added in WS-13 to WS-15", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  // Stands in for Rails: a request Node hands back arrives here, body and all.
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
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
    server = await startNextServer({
      ...(ES_INDEX_SUFFIX ? { ES_INDEX_SUFFIX } : {}),
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      // The first re-send of "sends nothing the second time" is not replayed, only its limit: post 6 to purchase 1, as recorded.
      RAILS_CACHE_TEST_SEED: JSON.stringify({ "post_email:6:1": true }),
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      // The unsubscribe link a re-sent post carries is signed with them.
      ...(testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION")
        ? { SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION")! }
        : {}),
      ...(testEnv("SECURE_EXTERNAL_ID__KEYS__1")
        ? { SECURE_EXTERNAL_ID__KEYS__1: testEnv("SECURE_EXTERNAL_ID__KEYS__1")! }
        : {}),
      ...(testEnv("STRIPE_PUBLIC_KEY_TEST") ? { STRIPE_PUBLIC_KEY_TEST: testEnv("STRIPE_PUBLIC_KEY_TEST")! } : {}),
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  // The first request to a route compiles it, and the time a write is stamped with is the replay's clock plus the compile: replay one
  // fixture before the first comparison.
  const replayOptions = (file: string, name: string) => ({
    sql,
    redis: {
      // The cached 1099 URL is keyed by the year before the one the request runs in, which was 2025 when recorded.
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) =>
        redisSeeder(redis).reset(
          Object.fromEntries(
            Object.entries(entries).map(([key, entry]) => [
              key.replace(/^(tax_form_1099_download_url_)\d{4}_/u, `$1${new Date().getUTCFullYear() - 1}_`),
              entry,
            ]),
          ),
        ),
    },
    transport: file.includes(ERB_PAGE_SPEC)
      ? maskingTransport(httpTransport(server.baseUrl))
      : httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: compareFor(file, name),
    file,
  });

  afterAll(async () => {
    await server?.stop();
    rails?.close();
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
      await resetAudienceIndex();
      // One fixture per spec, so every route compiles before the first comparison.
      for (const spec of SPECS) {
        const [name, file, index] = cases.find(([name]) => name.startsWith(spec)) ?? cases[0]!;
        const { file: _file, ...options } = replayOptions(file, name);
        await replayFixtureExchange(file, index, options).catch(() => undefined);
      }
      // The X-Inertia handler (/gr-inertia) compiles on its own.
      const inertia = cases.find(([name]) => name.includes("inertia-visit"));
      if (inertia) {
        const { file: _file, ...options } = replayOptions(inertia[1], inertia[0]);
        await replayFixtureExchange(inertia[1], inertia[2], options).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (caseName, file, index) => {
      try {
        const fixture = loadFixture(file);
        if (file.includes(ERB_PAGE_SPEC))
          for (const exchange of fixture.exchanges)
            if (typeof exchange.response.body === "string")
              exchange.response.body = maskVolatile(exchange.response.body);
        // Rails and Node push in different orders across stores: both sides are compared sorted.
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        const { file: _file, ...options } = replayOptions(file, caseName);
        if (caseName.includes("hands-a-")) {
          // Whatever Node cannot prove goes to Rails whole, before its first write.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          expect(JSON.parse(handedBack[0]!.body || "{}")).toEqual(JSON.parse(request.body || "{}"));
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options);
        assertParity(result);
        // The flash lives in the encrypted session cookie, which the comparison skips: read it out of both responses.
        if (caseName.includes("workflow-emails-save")) {
          const cookie = (cookies: Record<string, { value?: unknown }> | undefined) =>
            sessionFlash(fixture.secretKeyBase, fixture.sessionCookie, cookies);
          const recorded = cookie(fixture.exchanges[index]!.response.cookies as never);
          // A redirect that saved something carries a notice; an empty read here would let both sides pass unseen.
          if (fixture.exchanges[index]!.response.status === 303 && /preview|publishes|saves|creates/u.test(caseName))
            expect(recorded).not.toBeNull();
          expect(cookie(result.exchanges.at(-1)!.actual.response.cookies as never)).toEqual(recorded);
        }
        if (caseName.includes("confirms-an-unconfirmed-follower")) {
          const inserted = (result.exchanges.at(-1)!.actual.db as Record<string, { inserted: { details: string }[] }>)
            .audience_members!.inserted;
          expect(inserted).toHaveLength(1);
          expect(JSON.parse(inserted[0]!.details)).toMatchObject({
            follower: {
              id: expect.any(Number),
              created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u),
            },
          });
        }
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
