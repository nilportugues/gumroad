import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { compare } from "bcryptjs";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totpAt } from "@/lib/rotp";
import { deriveRailsCookieSecrets, readEncryptedCookie } from "@/server/auth/rails-cookies";
import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture, type CapturedExchange, type Exchange, type Fixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { withoutRailsOnly } from "../src/rails-only";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the form submissions of the third-party analytics and advanced settings: spec/requests/settings_mutations_signed_in_spec.rb. Each fixture is a
// login, a CSRF fetch and the request under test (a JSON body with the token in X-CSRF-Token, as Inertia sends it); the last one is
// replayed against `next dev` with the write flags on. The comparison covers the status, the redirect, the flash in the session
// cookie's place, every row written and every job enqueued.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "settings_mutations_signed_in_spec",
  "settings_payments_backtax_opt_in_spec",
  "settings_team_invitations_signed_in_spec",
  "settings_totp_signed_in_spec",
  "settings_passkeys_signed_in_spec",
  "settings_ping_signing_signed_in_spec",
];
const ROUTE_FLAGS =
  "nextjs_settings_third_party_analytics_writes,nextjs_settings_advanced_writes,nextjs_settings_billing_writes,nextjs_settings_dismiss_ai_promo_writes,nextjs_settings_team_members_writes,nextjs_settings_team_members_reads,nextjs_settings_payments_backtax_writes,nextjs_settings_team_invitations_writes,nextjs_settings_totp_writes,nextjs_settings_passkeys_writes,nextjs_settings_ping_signing_writes";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-settings";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
// DNS as the spec's Resolv::DNS stub answers it (keep the two in sync): Gumroad's own targets resolve, and two names carry a CNAME to Gumroad.
const CNAME_TARGET = "domains-staging.gumroad.com";
const STATIC_IP_HOST = "staging-custom-domains-static-ip.gumroad.net";
const DNS_ZONE = JSON.stringify({
  cname: { "points.example.com": CNAME_TARGET, "verified-old.example.com": CNAME_TARGET },
  a: { [CNAME_TARGET]: ["203.0.113.7"], [STATIC_IP_HOST]: ["203.0.113.7"] },
});
// Example name fragment, sends in the throttle's set and how long ago they were made (spec/requests/settings_team_invitations_signed_in_spec.rb).
const THROTTLE_FILLS = [
  ["refuses-past-the-hourly-allowance", 10, 150],
  ["refuses-past-the-daily-allowance", 50, 7230],
] as const;
const EXPIRY_DAYS = 7;
// Example name fragment, and the email of the invitation the enqueued TeamMailer.invite names.
const MAIL_CASES: Record<string, string> = {
  "creates-the-invitation-expiring": "new@example.com",
  "does-not-count-invitations-against": "new@example.com",
  "extends-the-expiry-and-enqueues": "invitee@example.com",
};
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker"]);
// Both are `lock: :until_executed`. The Rails run holds the locks its factories took before the request (the seller's creation pushed
// GenerateSubscribePreviewJob), and its recorder lists identical pushes of one request more than once; Node takes the lock as production
// does, so identical pushes collapse to one and a push the setup already made is not repeated.
const LOCKED_JOBS = new Set(["InvalidateProductCacheWorker", "GenerateSubscribePreviewJob"]);

function withoutLockedRepeats<T extends { class: string; args: unknown; queue?: string }>(jobs: T[]): T[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (job.class === "GenerateSubscribePreviewJob") return false;
    if (!LOCKED_JOBS.has(job.class)) return true;
    const key = jobKey(job);
    return !seen.has(key) && seen.add(key) !== undefined;
  });
}
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

type SidekiqItem = { class: string; args: unknown[]; queue: string; at?: number; wrapped?: string };

// A request spec's ActiveJob adapter is the test one, so Rails' mail deliveries are not in the fixtures: the replay reads Node's back and
// asserts them separately.
let mailJobs: SidekiqItem[] = [];

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as SidekiqItem;
        if (item.wrapped === "MailDeliveryJob") {
          mailJobs.push(item);
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
      // Jobs of a class Ruby still runs sit in Sidekiq's own lists and schedule.
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as SidekiqItem;
          if (item.wrapped === "MailDeliveryJob") mailJobs.push(item);
          else if (!IGNORED_JOBS.has(item.class)) jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at: number };
        if (!IGNORED_JOBS.has(item.class))
          jobs.push({ class: item.class, args: item.args, queue: item.queue, at: item.at });
      }
      return withoutLockedRepeats(jobs).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
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
    "db.third_party_analytics.updated.*.changes.updated_at",
    "db.custom_domains.updated.*.changes.updated_at",
    "db.blocked_customer_objects.updated.*.changes.updated_at",
    "db.billing_details.updated.*.changes.updated_at",
    "db.team_memberships.updated.*.changes.updated_at",
    // Random bcrypt hashes and the codes they hide: assertTotp reads them back.
    "response.json.recovery_codes",
    "response.json.secret",
    "response.json.provisioning_uri",
    // The creation options' challenge is 32 random bytes, kept in the session: assertRegistrationOptions reads both back.
    "response.json.options.challenge",
    "response.json.qr_svg",
    "db.totp_credentials.inserted.*.otp_secret",
    // The signing secret is random: assertPingSigning reads it back.
    "db.ping_signing_settings.inserted.*.secret",
    "db.ping_signing_settings.updated.*.changes.secret",
    "db.ping_signing_settings.inserted.*.created_at",
    "db.ping_signing_settings.inserted.*.updated_at",
    "db.ping_signing_settings.updated.*.changes.updated_at",
    "db.totp_credentials.updated.*.changes.recovery_codes",
    // The join's cookie is encrypted with a random IV: assertJoin reads it back.
    "response.cookies.current_seller_id.value",
    "db.webauthn_credentials.updated.*.changes.updated_at",
    // An invitation expires at the end of the day a week out: the recorded offset from the request depends on the hour it was
    // recorded at. assertSend checks the day and the microseconds.
    "db.team_invitations.inserted.*.expires_at",
    "db.team_invitations.updated.*.changes.expires_at",
    // The throttle's clock is Redis': assertSend checks the header equals the body and sits in the window the fill implies.
    "response.headers.retry-after",
    "response.json.retry_after",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
  ],
};

// Seconds from the replay's clock for the code a confirmation sends; the recorded code is for a clock the replay does not have.
const TOTP_OFFSETS = [
  ["confirms-with-the-code-of-the-previous-interval", -30],
  ["answers-422-for-the-code-of-the-next-interval", 30],
  ["confirms-with-the-current-code", 0],
] as const;

function withCurrentTotpCode<T extends { body?: string }>(name: string, request: T, loaded: Fixture, now: Date): T {
  const offset = TOTP_OFFSETS.find(([fragment]) => name.includes(fragment))?.[1];
  if (offset === undefined) return request;
  const secret = loaded.exchanges.at(-1)!.seed.tables.totp_credentials!.rows[0]!.otp_secret as string;
  return { ...request, body: JSON.stringify({ code: totpAt(secret, new Date(now.getTime() + offset * 1000)) }) };
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

describe.skipIf(!url)("mutations of the settings pages", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
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
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      CUSTOM_DOMAIN_DNS_TEST_ZONE: DNS_ZONE,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
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

  // The first request to a route compiles it, and the time a write is stamped with is the replay's clock plus the compile: replay one
  // fixture before the first comparison.
  const replayOptions = (file: string, name: string) => ({
    sql,
    redis: {
      async reset(entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0], exchange?: unknown) {
        await redisSeeder(redis).reset(entries);
        if (!exchange) return;
        await seedSendThrottle(name, exchange as Exchange);
        // The AI promo's eligibility sums the seller's sales in Elasticsearch.
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
    ) => withCurrentTotpCode(name, reencryptCookies(request, loaded, SECRET_KEY_BASE, now), loaded, now),
    // The test environment answers a 422 with its exception debug page, which the fixture does not keep.
    compare: /422|unknown-invitation/u.test(name)
      ? { ignore: [...COMPARE.ignore, "response.body"] }
      : // The test environment answers a 404 with its debug page whatever the Accept header says.
        name.includes("404")
        ? { ignore: [...COMPARE.ignore, "response.body", "response.json", "response.headers.content-type"] }
        : COMPARE,
    file,
  });

  // The send throttle is a sorted set, which a recording does not hold: refill what the example's setup put there.
  async function seedSendThrottle(name: string, exchange: Exchange) {
    const fill = THROTTLE_FILLS.find(([fragment]) => name.includes(fragment));
    if (!fill) return;
    const [, count, secondsAgo] = fill;
    const seller = exchange.seed.tables.users?.rows.find((row) => row.username === "teaminvites");
    for (let index = 0; index < count; index++)
      await redis.zadd(
        `team_invitation_send_throttle:${String(seller!.id)}`,
        Date.now() / 1000 - secondsAgo,
        `send${index}`,
      );
  }

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  // What the comparison skips for a send: the mail job (class, queue and arguments), the expiry and the throttle's retry time.
  async function assertSend(name: string, actual: CapturedExchange) {
    if (!name.startsWith("settings_team_invitations_signed_in_spec") || name.includes("joins-")) return;
    const mailEmail = Object.entries(MAIL_CASES).find(([fragment]) => name.includes(fragment))?.[1];
    if (mailEmail === undefined) {
      expect(mailJobs).toHaveLength(0);
    } else {
      expect(mailJobs).toHaveLength(1);
      const job = mailJobs[0]!;
      expect(job.queue).toBe("default");
      const wrapped = (job.args as { job_class: string; queue_name: string; arguments: unknown[] }[])[0]!;
      expect(wrapped).toMatchObject({ job_class: "MailDeliveryJob", queue_name: "default" });
      const [mailer, method, delivery, params] = wrapped.arguments as [
        string,
        string,
        string,
        { args: { _aj_globalid: string }[]; _aj_ruby2_keywords: string[] },
      ];
      expect([mailer, method, delivery]).toEqual(["TeamMailer", "invite", "deliver_now"]);
      expect(params._aj_ruby2_keywords).toEqual(["args"]);
      expect(params.args).toHaveLength(1);
      const id = /^gid:\/\/gumroad\/TeamInvitation\/(\d+)$/u.exec(params.args[0]!._aj_globalid)?.[1];
      const row = await client.teamInvitation.findUniqueOrThrow({ where: { id: BigInt(id!) } });
      expect(row.email).toBe(mailEmail);
      const expected = new Date(Date.now() + EXPIRY_DAYS * 86_400_000);
      expect(row.expires_at.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
      // The datetime(6) column keeps the end of the day as Ruby wrote it.
      const [stored] = await client.$queryRaw<
        { expires_at: string }[]
      >`SELECT CAST(expires_at AS CHAR) AS expires_at FROM team_invitations WHERE id = ${BigInt(id!)}`;
      expect(stored!.expires_at).toMatch(/ 23:59:59\.999999$/u);
    }
    if (!/refuses-past-the-/u.test(name)) return;
    const retryAfter = (actual.response.json as { retry_after: number }).retry_after;
    expect(actual.response.headers["retry-after"]).toBe(String(retryAfter));
    const [low, high] = name.includes("hourly") ? [3400, 3500] : [79_000, 79_200];
    expect(retryAfter).toBeGreaterThanOrEqual(low);
    expect(retryAfter).toBeLessThanOrEqual(high);
  }

  // The mail job of a join (TeamMailer.invitation_accepted for the membership it created) and the account the cookie switches to.
  async function assertJoin(name: string, actual: CapturedExchange) {
    if (!name.startsWith("settings_team_invitations_signed_in_spec") || !name.includes("joins-")) return;
    expect(mailJobs).toHaveLength(1);
    const wrapped = (mailJobs[0]!.args as { arguments: unknown[] }[])[0]!;
    const [mailer, method, , params] = wrapped.arguments as [
      string,
      string,
      string,
      { args: { _aj_globalid: string }[] },
    ];
    expect([mailer, method]).toEqual(["TeamMailer", "invitation_accepted"]);
    const id = /^gid:\/\/gumroad\/TeamMembership\/(\d+)$/u.exec(params.args[0]!._aj_globalid)?.[1];
    const membership = await client.teamMembership.findUniqueOrThrow({ where: { id: BigInt(id!) } });
    const cookie = actual.response.cookies?.current_seller_id?.value as string | undefined;
    expect(readEncryptedCookie(deriveRailsCookieSecrets(SECRET_KEY_BASE), "current_seller_id", cookie)).toBe(
      Number(membership.seller_id),
    );
  }

  // The recovery codes a confirmation or a regeneration made: ten of them, shaped as shown to the user, and the stored list holds a
  // bcrypt hash of each (cost 12, `$2a$`). WRITE_NODE_TOTP hands both to spec/requests/node_output_parity_spec.rb, where Rails redeems them.
  async function assertTotp(name: string, actual: CapturedExchange) {
    if (!name.startsWith("settings_totp_signed_in_spec")) return;
    const codes = (actual.response.json as { recovery_codes?: string[] } | undefined)?.recovery_codes;
    if (codes === undefined) return;
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    const credential = await client.totpCredential.findFirstOrThrow();
    const hashes = JSON.parse(credential.recovery_codes!) as string[];
    expect(hashes).toHaveLength(10);
    for (const [index, hash] of hashes.entries()) {
      expect(hash).toMatch(/^\$2a\$12\$[./A-Za-z0-9]{53}$/u);
      expect(await compare(codes[index]!.replace("-", ""), hash)).toBe(true);
    }
    expect(credential.recovery_codes_generated_at).not.toBeNull();
    if (process.env.WRITE_NODE_TOTP && name.includes("confirms-with-the-current-code")) {
      const user = await client.user.findFirstOrThrow();
      writeFileSync(
        process.env.WRITE_NODE_TOTP,
        `${JSON.stringify({ user: { id: Number(user.id), email: user.email }, otp_secret: credential.otp_secret, confirmed_at: credential.confirmed_at, recovery_codes: credential.recovery_codes, recovery_codes_generated_at: credential.recovery_codes_generated_at, codes }, null, 2)}\n`,
      );
    }
  }

  // A rotation's secret is 32 random bytes in hex, and the one stored for the seller.
  async function assertPingSigning(name: string, actual: CapturedExchange) {
    if (!name.startsWith("settings_ping_signing_signed_in_spec")) return;
    const secret = (actual.response.json as { secret?: string } | undefined)?.secret;
    if (secret === undefined) return;
    expect(secret).toMatch(/^[0-9a-f]{64}$/u);
    const rows = await client.$queryRaw<{ secret: string }[]>`SELECT secret FROM ping_signing_settings WHERE secret = ${secret}`;
    expect(rows).toHaveLength(1);
  }

  // A setup's secret is 160 random bits in base32 and is the one in the row; WRITE_NODE_TOTP_SETUP hands the secret and what Node drew
  // from it to spec/requests/node_output_parity_spec.rb, where Rails draws the same URI and QR code.
  async function assertSetup(name: string, actual: CapturedExchange) {
    if (!name.startsWith("settings_totp_signed_in_spec")) return;
    const body = actual.response.json as { secret?: string; provisioning_uri?: string; qr_svg?: string } | undefined;
    if (body?.secret === undefined) return;
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/u);
    const credential = await client.totpCredential.findFirstOrThrow();
    expect(credential.otp_secret).toBe(body.secret);
    expect(credential.confirmed_at).toBeNull();
    if (process.env.WRITE_NODE_TOTP_SETUP && name.includes("starts-a-setup")) {
      const user = await client.user.findFirstOrThrow();
      writeFileSync(
        process.env.WRITE_NODE_TOTP_SETUP,
        `${JSON.stringify({ user: { id: Number(user.id), email: user.email }, secret: body.secret, provisioning_uri: body.provisioning_uri, qr_svg: body.qr_svg }, null, 2)}\n`,
      );
    }
  }

  // The session cookie the response set (the compare ignores its encrypted value).
  function sessionOf(fixture: Fixture, cookies: CapturedExchange["response"]["cookies"]) {
    const raw = (cookies?.[fixture.sessionCookie!] as { value?: string } | undefined)?.value;
    if (raw === undefined) return null;
    return readEncryptedCookie(
      deriveRailsCookieSecrets(SECRET_KEY_BASE),
      fixture.sessionCookie!,
      decodeURIComponent(raw),
      new Date(0),
    ) as Record<string, unknown> | null;
  }

  // The creation options' challenge is the one kept in the session under the registration key, and nothing else was added to it.
  // WRITE_NODE_PASSKEY_REGISTRATION hands the session cookie and challenge of the first example to spec/requests/node_output_parity_spec.rb,
  // where Rails registers a passkey against them.
  async function assertRegistrationOptions(
    name: string,
    fixture: Fixture,
    actual: CapturedExchange,
    expected: CapturedExchange,
  ) {
    if (!name.startsWith("settings_passkeys_signed_in_spec")) return;
    const body = actual.response.json as { options?: { challenge?: string } } | undefined;
    const session = sessionOf(fixture, actual.response.cookies);
    const recorded = sessionOf(fixture, expected.response.cookies);
    if (body?.options?.challenge !== undefined) {
      expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(session?.webauthn_registration_challenge).toBe(body.options.challenge);
      const { webauthn_registration_challenge: _kept, ...rest } = session ?? {};
      const { webauthn_registration_challenge: _recorded, ...recordedRest } = recorded ?? {};
      expect(rest).toEqual(recordedRest);
      if (process.env.WRITE_NODE_PASSKEY_REGISTRATION && name.includes("issues-creation-options")) {
        const user = await client.user.findFirstOrThrow();
        const cookie = (actual.response.cookies as Record<string, { value: string }>)[fixture.sessionCookie!]!;
        writeFileSync(
          process.env.WRITE_NODE_PASSKEY_REGISTRATION,
          `${JSON.stringify(
            {
              session_cookie: { name: fixture.sessionCookie, value: cookie.value },
              challenge: body.options.challenge,
              user: {
                id: Number(user.id),
                email: user.email,
                encrypted_password: user.encrypted_password,
                remember_created_at: user.remember_created_at?.toISOString(),
              },
            },
            null,
            2,
          )}\n`,
        );
      }
      return;
    }
    if (name.includes("adding-a-passkey")) {
      // The challenge is spent whether or not the attestation verified, and the prompt flag follows the passkeys left to add.
      expect(session).not.toHaveProperty("webauthn_registration_challenge");
      expect(session).toEqual(recorded);
    }
  }

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handler",
    async () => {
      for (const [name, file, index] of [
        cases.find(([name]) => name.includes("saves-the-pixel-ids")) ?? cases[0]!,
        cases.find(([name]) => name.includes("saves-the-ping-endpoint")) ?? cases[0]!,
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
        expected.jobs = withoutLockedRepeats([...(expected.jobs ?? [])]).sort((a, b) =>
          jobKey(a).localeCompare(jobKey(b)),
        );
        const { file: _file, ...options } = replayOptions(file, name);
        if (name.includes("hands-a-")) {
          // Whatever Node cannot prove goes to Rails whole, before its first write.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          // A PUT or GET without a body reaches Rails with none.
          const parsed = (body: string) => (body === "" ? {} : (JSON.parse(body) as unknown));
          expect(parsed(handedBack[0]!.body)).toEqual(parsed(request.body ?? ""));
          // A GET navigation seeds the seller's nav promotions before the action runs, as Rails' own request would.
          expect(
            Object.keys(handed.exchanges[0]!.actual.db ?? {}).filter((name) => name !== "dashboard_nav_promotions"),
          ).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options);
        assertParity(result);
        await assertSend(name, result.exchanges[0]!.actual);
        await assertJoin(name, result.exchanges[0]!.actual);
        await assertTotp(name, result.exchanges[0]!.actual);
        await assertSetup(name, result.exchanges[0]!.actual);
        await assertPingSigning(name, result.exchanges[0]!.actual);
        await assertRegistrationOptions(name, fixture, result.exchanges[0]!.actual, result.exchanges[0]!.expected);
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
