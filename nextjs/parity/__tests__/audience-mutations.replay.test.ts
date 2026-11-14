import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decrypt } from "@/lib/obfuscate-ids";
import { closeAllRedis } from "@/server/infra/redis";

import { unwrapActiveJob } from "../src/active-job";
import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { withoutRailsOnly } from "../src/rails-only";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the mutations of the emails and workflows pages: spec/requests/{emails,workflows}_mutations_signed_in_spec.rb. Each fixture is a
// login, a CSRF fetch and the request under test (a JSON body with the token in X-CSRF-Token, as Inertia sends it); the last one is
// replayed against `next dev` with the write flags on. The comparison covers the status, the redirect, the flash in the session
// cookie's place, every row written and every job enqueued.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
// Rack::Attack's counters live in their own Redis database: the seeder flushes the main one before every exchange, which would zero a count.
const rackAttackHost = process.env.PARITY_RACK_ATTACK_REDIS_HOST;
// Examples of followers_create_parity_spec.rb whose answer asks the visitor to confirm.
const MAIL_FOLLOW_CASES = [
  "asks-a-visitor-to-confirm",
  "answers-json-with-the-message",
  "links-the-follow",
  "revives-a-follower",
  "asks-a-confirmed-follower",
  "records-the-embed-form-as-the-source",
  "follows-plainly-when-the-product-s-waitlist-is-off",
  "follows-plainly-when-the-product-is-already-published",
  "follows-plainly-when-the-product-belongs-to-another-seller",
  "from-a-product-s-waitlist-records-the-waitlist-entry-and-asks",
  "from-a-product-s-waitlist-keeps-the-entry",
  "from-a-product-s-waitlist-records-the-entry-of-a-follower-who-had-been-removed",
  "from-a-product-s-waitlist-records-the-waitlist-entry-of-an-embed-form-signup",
];
const THROTTLE_CASE = /-refuses-the-(?:fourth|sixth)-/u;
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "emails_mutations_signed_in_spec",
  "workflows_mutations_signed_in_spec",
  "audience_export_signed_in_spec",
  "followers_mutations_signed_in_spec",
  "followers_confirm_link_spec",
  "comments_mutations_signed_in_spec",
  "followers_create_parity_spec",
  "comments_index_parity_spec",
];
const ROUTE_FLAGS =
  "nextjs_emails_writes,nextjs_workflows_writes,nextjs_audience_export,nextjs_followers_writes,nextjs_followers_confirm,nextjs_comments_writes,nextjs_followers_create,nextjs_comments_index";
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

// The mail jobs of the last exchange: the request spec's test adapter never queued them, so they are asserted apart from the others.
type MailItem = {
  class: string;
  wrapped?: string;
  queue: string;
  args: { job_class: string; queue_name: string; arguments: unknown[] }[];
};
let mailJobs: MailItem[] = [];
// A fixture recorded with `parity_mail_jobs: true` holds its mail job in `jobs`: the others keep it apart.
let compareMailJobs = false;

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as {
          class: string;
          args: unknown[];
          queue: string;
          at?: number;
          wrapped?: string;
        };
        if (item.wrapped === "MailDeliveryJob") {
          mailJobs.push(item as unknown as MailItem);
          continue;
        }
        if (IGNORED_JOBS.has(item.class)) continue;
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      // A job whose body stays in Ruby (Exports::AudienceExportWorker) goes straight to Sidekiq's list.
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as MailItem & { class: string };
          if (item.wrapped === "MailDeliveryJob") mailJobs.push(item);
          else jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      // deliver_later(wait:) waits in the schedule until its time.
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as MailItem;
        if (item.wrapped === "MailDeliveryJob") mailJobs.push(item);
      }
      if (compareMailJobs)
        for (const mail of mailJobs)
          jobs.push(unwrapActiveJob({ class: mail.class, args: mail.args, queue: mail.queue } as RawJob));
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
    "db.comments.updated.*.changes.updated_at",
    // The row is the seed's: stamped with the replay's clock, where the recording's request came seconds after the factory.
    "db.audience_members.deleted.*.created_at",
    "db.audience_members.deleted.*.updated_at",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
  ],
};

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
const railsServed = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);
// A throttled request is only refused after the earlier ones of its example counted: those are replayed in order by their own test below.
const cases = railsServed.filter(([name]) => !THROTTLE_CASE.test(name));
const throttleCases = railsServed.filter(([name]) => THROTTLE_CASE.test(name));

describe.skipIf(!url)("mutations of the emails and workflows pages", () => {
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
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: rackAttackHost ?? redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      // Rails' test environment has a site key, which is what makes a seller who is not reviewed need a CAPTCHA.
      ...(testEnv("RECAPTCHA_MONEY_SITE_KEY")
        ? { RECAPTCHA_MONEY_SITE_KEY: testEnv("RECAPTCHA_MONEY_SITE_KEY")! }
        : {}),
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  // The first request to a route compiles it, and the time a write is stamped with is the replay's clock plus the compile: replay one
  // fixture before the first comparison.
  const replayOptions = (file: string, name: string) => ({
    sql,
    redis: {
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => {
      const moved = reencryptCookies(request, loaded, SECRET_KEY_BASE, now);
      // Rails' cache is empty at the start of every example, and ids restart with each seed: the server's must be too.
      return { ...moved, headers: { ...moved.headers, "x-parity-reset-cache": "1" } };
    },
    compare:
      name.includes("delete-followers") || name.includes("follow-confirmation-link")
        ? {
            ignore: [
              ...COMPARE.ignore,
              // SecureRandom.uuid of the ConfirmedFollowerEvent job
              "jobs.*.args.*.id",
              // The details keep the follow's created_at as an absolute time; the seed's is the replay's clock. The shape is asserted below.
              "db.audience_members.inserted.*.details",
              ...(name.includes("404") ? ["response.body"] : []),
              // The row's time columns are seeded from the replay's clock while its details hold absolute dates, so the columns
              // recomputed from the details read as changed (and the Elasticsearch update lists them). The flags, paid amounts and
              // follower_created_at stay compared.
              ...(name.includes("keeps-the-audience-member")
                ? [
                    "db.audience_members.updated.*.changes.min_created_at",
                    "db.audience_members.updated.*.changes.max_created_at",
                    "db.audience_members.updated.*.changes.min_purchase_created_at",
                    "db.audience_members.updated.*.changes.max_purchase_created_at",
                    "db.audience_members.updated.*.changes.min_affiliate_created_at",
                    "db.audience_members.updated.*.changes.max_affiliate_created_at",
                    "jobs.*.args.1.fields",
                  ]
                : []),
            ],
          }
        : name.includes("signed-in-visitor-with-a-verified-email")
          ? // The audience member keeps the follow's created_at as an absolute time, and the event job carries a SecureRandom.uuid.
            { ignore: [...COMPARE.ignore, "db.audience_members.inserted.*.details", "jobs.*.args.*.id"] }
          : /404|with-a-400/u.test(name)
            ? // The test environment answers an error with its debug page, which the recorder does not keep.
              { ignore: [...COMPARE.ignore, "response.body"] }
            : name.includes("publishes-a-workflow")
              ? // SecureRandom.uuid tokens of the schedule intents and the jobs that carry them
                {
                  ignore: [
                    ...COMPARE.ignore,
                    "db.workflow_installment_schedule_intents.inserted.*.token",
                    "db.workflow_installment_schedule_intents.inserted.*.dispatch_token",
                    "jobs.*.args.*",
                  ],
                }
              : name.includes("numeric-suffix")
                ? { ignore: [...COMPARE.ignore, "db.installments.inserted.*.slug"] }
                : name.includes("schedules-an-email")
                  ? // The posted 2099 date canonicalizes to hours from now, which shrinks as the fixture ages;
                    // save-installment.golden.json pins the stored value.
                    { ignore: [...COMPARE.ignore, "db.installment_rules.inserted.*.to_be_published_at"] }
                  : COMPARE,
    file,
  });

  afterAll(async () => {
    if (rackAttackHost) await rackAttackRedis().flushdb();
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await rackRedis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  // Connection to the Rack::Attack database.
  let rackRedis: Redis | undefined;
  const rackAttackRedis = () => {
    const [hostAndPort = "", db = "0"] = rackAttackHost!.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    return (rackRedis ??= new Redis({ host, port: Number(port), db: Number(db) }));
  };

  // The confirmation request Rails queued through its test adapter: FollowerMailer.confirm_follower(seller id, follower id) on the critical
  // queue, three seconds out, only for a follow that is not confirmed on the spot.
  async function assertConfirmationMail(
    name: string,
    result: Awaited<ReturnType<typeof replayFixtureExchange>>,
    requestBody: string,
  ) {
    const sends = MAIL_FOLLOW_CASES.some((fragment) => name.includes(fragment));
    if (!sends) {
      expect(mailJobs).toHaveLength(0);
      return;
    }
    expect(mailJobs).toHaveLength(1);
    const job = mailJobs[0]!;
    expect(job.queue).toBe("critical");
    const wrapped = job.args[0]!;
    expect(wrapped).toMatchObject({ job_class: "MailDeliveryJob", queue_name: "critical" });
    const [mailer, method, delivery, params] = wrapped.arguments as [string, string, string, { args: number[] }];
    expect([mailer, method, delivery]).toEqual(["FollowerMailer", "confirm_follower", "deliver_now"]);
    const written = result.exchanges[0]!.actual.db as Record<
      string,
      { inserted?: { id: number }[]; updated?: { id: number }[] }
    >;
    const followerId = (written.followers?.inserted?.[0] ?? written.followers?.updated?.[0])?.id;
    expect(params.args[1]).toBe(followerId ?? params.args[1]);
    // A waitlist signup carries the product as a third argument; a plain follow keeps the two-argument job.
    if (name.includes("from-a-product-s-waitlist") && !name.includes("follows-plainly")) {
      const { product_id: productId } = JSON.parse(requestBody) as { product_id: string };
      expect(params.args).toEqual([expect.any(Number), params.args[1], decrypt(productId)]);
    } else expect(params.args).toHaveLength(2);
  }

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handler",
    async () => {
      await resetAudienceIndex();
      for (const [name, file, index] of [
        cases.find(([name]) => name.includes("creates-a-draft")) ?? cases[0]!,
        cases.find(([name]) => name.includes("updates-a-draft")) ?? cases[0]!,
        cases.find(([name]) => name.includes("deletes-a-draft")) ?? cases[0]!,
      ]) {
        const { file: _file, ...options } = replayOptions(file, name);
        await replayFixtureExchange(file, index, options).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Rails and Node push in different orders across stores: both sides are compared sorted.
        const expected = fixture.exchanges[index]!;
        compareMailJobs = (expected.jobs ?? []).some((job) => job.activeJob === true);
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        const { file: _file, ...options } = replayOptions(file, name);
        if (name.includes("hands-a-")) {
          // Whatever Node cannot prove goes to Rails whole, before its first write.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          // A form post (the embed form's HTML answer) is forwarded byte for byte; a JSON body is compared parsed.
          if (request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
            expect(handedBack[0]!.body).toBe(request.body ?? "");
          } else {
            expect(JSON.parse(handedBack[0]!.body || "{}")).toEqual(JSON.parse(request.body || "{}"));
          }
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options);
        assertParity(result);
        if (name.startsWith("followers_create_parity_spec"))
          await assertConfirmationMail(name, result, expected.request.body ?? "{}");
        // Recorded with the Sidekiq adapter, a comment that mails nobody leaves no mail job behind.
        if (name.startsWith("comments_mutations_signed_in_spec") && !compareMailJobs) expect(mailJobs).toHaveLength(0);
        if (name.includes("confirms-an-unconfirmed-follower")) {
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

  // Replays every write of the example in order against a counter that starts empty: the last one is refused with the 429 Rails answered.
  it.skipIf(!rackAttackHost).each(throttleCases)(
    "%s",
    async (name, file, last) => {
      const fixture = loadFixture(file);
      handedBack.length = 0;
      await rackAttackRedis().flushdb();
      // The counter is keyed by the minute window: start early in one so the replay cannot straddle two.
      const secondInWindow = new Date().getUTCSeconds();
      if (secondInWindow > 45) await new Promise((resolve) => setTimeout(resolve, (61 - secondInWindow) * 1000));
      const writes = fixture.exchanges.flatMap((exchange, index) =>
        index <= last &&
        /^(POST|PUT)$/u.test(exchange.request.method) &&
        /\/(?:comments|follow)/u.test(exchange.request.path)
          ? [index]
          : [],
      );
      expect(writes.length).toBeGreaterThanOrEqual(4);
      for (const index of writes) {
        const { file: _file, ...options } = replayOptions(file, name);
        const result = await replayFixtureExchange(fixture, index, {
          ...options,
          // The seconds left in the window depend on when the replay ran; the status and body say it was refused.
          compare: { ...COMPARE, ignore: [...COMPARE.ignore, "response.headers.retry-after"] },
        });
        assertParity(result);
        if (index === last) {
          expect(result.exchanges[0]!.actual.response.status).toBe(429);
          expect(Number(result.exchanges[0]!.actual.response.headers["retry-after"])).toBeGreaterThan(0);
        }
      }
      expect(handedBack).toHaveLength(0);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
