import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type CapturedHttp } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/foreign_webhooks_parity_spec.rb: the Stripe, PayPal, SendGrid, Resend and SNS callbacks. The verification
// calls to PayPal and the certificate downloads of SNS go to a local stand-in (OUTBOUND_HTTP_STAND_IN) that answers what the
// recording saw, in order, and the test then compares what Node sent with what Rails sent. The clock is the recording's, which the
// signatures and the five minute tolerances are measured against.
//
// Run with the environment the spec was recorded with: SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY, RESEND_WEBHOOK_SECRET, PAYPAL_WEBHOOK_ID
// and PAYPAL_PARTNER_CLIENT_SECRET are set below, the rest comes from .env.test.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/foreign_webhooks_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const PARITY_NOW = 1_600_112_502_000;
const SENDGRID_PUBLIC_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
const RESEND_SECRET = "whsec_dGVzdC1yZXNlbmQtc2VjcmV0";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.cookies.XSRF-TOKEN.value",
    "response.cookies.__profilin",
    "http",
  ],
};

const cases = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixturePath = path.join(DIR, file);
    return [
      file.replace(/\.json$/u, "").replace(/^foreign-webhooks-/u, ""),
      fixturePath,
      loadFixture(fixturePath).exchanges.length - 1,
    ] as const;
  });

const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

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
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
          jobs.push({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          });
        }
      }
      const scheduled = await redis.zrange("schedule", 0, -1, "WITHSCORES");
      for (let index = 0; index < scheduled.length; index += 2) {
        const item = JSON.parse(scheduled[index]!) as { class: string; args: unknown[]; queue: string };
        jobs.push({ class: item.class, args: item.args, queue: item.queue, at: Number(scheduled[index + 1]) });
      }
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

describe.skipIf(!url)("Foreign webhooks parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const recorded: CapturedHttp[] = [];
  const received: { method: string; url: string; contentType: string | undefined; body: string }[] = [];
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
        response.writeHead(218, { "x-handed-back": "rails" }).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: String(request.headers["x-parity-original-url"] ?? request.url),
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const answer = recorded.shift()?.response;
        if (answer === undefined) return void response.writeHead(599).end("parity: no recorded answer left");
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    clockOffset = Math.round(PARITY_NOW - realNow());
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_foreign_webhooks",
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      OUTBOUND_HTTP_STAND_IN: `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`,
      STRIPE__ENDPOINT_SECRET: testEnv("STRIPE__ENDPOINT_SECRET") ?? "",
      STRIPE_CONNECT__ENDPOINT_SECRET: testEnv("STRIPE_CONNECT__ENDPOINT_SECRET") ?? "",
      PAYPAL_PARTNER_CLIENT_ID: testEnv("PAYPAL_PARTNER_CLIENT_ID") ?? "",
      PAYPAL_PARTNER_CLIENT_SECRET: "test-paypal-partner-client-secret",
      PAYPAL_WEBHOOK_ID: "TEST_WEBHOOK_ID",
      RESEND_WEBHOOK_SECRET: RESEND_SECRET,
      SENDGRID_GR_CREATORS_WEBHOOK_PUBLIC_KEY: SENDGRID_PUBLIC_KEY,
      MAILER_HEADERS_ENCRYPTION_KEY_V1: testEnv("MAILER_HEADERS_ENCRYPTION_KEY_V1") ?? "",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
    });
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await new Promise((resolve) => standIn?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  const options = (name: string) => ({
    sql,
    redis: redisSeeder(redis),
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    driftDates: false,
    jobs: redisJobs(redis),
    // Rails answers the debug page of the test environment for an action that does not exist; its text is not the port's to match.
    compare: name.includes("grmc")
      ? { ignore: [...COMPARE.ignore, "response.body"] }
      : // perform_in(5.seconds) sits exactly on the five second edge of the "<now>" bucket; the delay is asserted below instead.
        name.includes("mediaconvert") && name.includes("enqueues")
        ? { ignore: [...COMPARE.ignore, "jobs.*.at"] }
        : COMPARE,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(62);
  });

  it(
    "compiles the handler",
    async () => {
      for (const [name, file, index] of cases.slice(0, 1))
        await replayFixtureExchange(loadFixture(file), index, options(name)).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      const fixture = loadFixture(file);
      const calls = fixture.exchanges[index]!.http;
      recorded.splice(0, recorded.length, ...calls);
      received.length = 0;
      handedBack.length = 0;
      try {
        if (/-hands-an?-/u.test(name)) {
          // A delivery the port cannot prove goes to Rails whole, body and signature headers included, before anything is queued.
          const handed = await replayFixtureExchange(fixture, index, options(name));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          if (request.body) expect(handedBack[0]!.body).toBe(request.body);
          expect(handed.exchanges[0]!.actual.jobs).toEqual([]);
          expect(received).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options(name));
        assertParity(result);
        if (name.includes("mediaconvert") && name.includes("enqueues"))
          expect(result.exchanges[0]!.actual.jobs.map((job) => job.at)).toEqual(["<now+5s>"]);
        // The port made the calls Rails made: the same method, URL, content type and body, in the same order.
        expect(
          received.map(({ method, url: original, contentType, body }) => ({
            method,
            url: original,
            contentType,
            body,
          })),
        ).toEqual(
          calls.map((call) => ({
            method: call.method,
            url: call.url,
            contentType: call.contentType ?? received[calls.indexOf(call)]?.contentType,
            body: call.body ?? "",
          })),
        );
        expect(handedBack).toEqual([]);
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
