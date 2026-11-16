import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/paypal_billing_agreements_parity_spec.rb: POST /paypal/billing_agreement_token and /paypal/billing_agreement.
// PayPal is a local stand-in (OUTBOUND_HTTP_STAND_IN) that serves the answers recorded in the fixture in order; Node must have made the
// same calls (method, URL, body) in the same order. A request the port hands back must reach the stand-in Rails and call PayPal not at all.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/paypal_billing_agreements_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const HANDED_BACK = /hands-a-/u;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "http",
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
  ],
};

const cases = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixturePath = path.join(DIR, file);
    return [
      file.replace(/\.json$/u, "").replace(/^paypal-billing-agreements-post-paypal-/u, ""),
      fixturePath,
      loadFixture(fixturePath).exchanges.length - 1,
    ] as const;
  });

describe.skipIf(!url)("PayPal billing agreements parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  const recordedHttp: { response?: { status?: number; contentType?: string; body?: string } }[] = [];
  const received: { method: string; url: string; body: string }[] = [];
  let handedBack = 0;
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((_, response) => {
      handedBack += 1;
      response.writeHead(218, { "x-handed-back": "rails" }).end();
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: String(request.headers["x-parity-original-url"] ?? request.url),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const answer = recordedHttp.shift()?.response;
        if (answer === undefined) return void response.writeHead(599).end("parity: no recorded answer left");
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      OUTBOUND_HTTP_STAND_IN: `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`,
      PAYPAL_PARTNER_MERCHANT_ID: testEnv("PAYPAL_PARTNER_MERCHANT_ID") ?? "",
      PAYPAL_PARTNER_CLIENT_ID: testEnv("PAYPAL_PARTNER_CLIENT_ID") ?? "",
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_paypal_billing_agreements",
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => (rails ? rails.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (standIn ? standIn.close(() => resolve()) : resolve()));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBe(18);
  });

  it.each(cases)(
    "%s",
    async (name, fixturePath, index) => {
      const fixture = loadFixture(fixturePath);
      const recorded = fixture.exchanges[index]!.http;
      recordedHttp.splice(0, recordedHttp.length, ...recorded);
      received.length = 0;
      handedBack = 0;
      const result = await replayFixtureExchange(fixture, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        compare: COMPARE,
      });
      try {
        if (HANDED_BACK.test(name)) {
          // Rails answers: Node reached it before calling PayPal or writing anything.
          expect(result.exchanges[0]!.actual.response.status).toBe(218);
          expect(handedBack).toBe(1);
          expect(received).toEqual([]);
          return;
        }
        assertParity(result);
        expect(received).toEqual(
          recorded.map((call) => ({ method: call.method, url: call.url, body: call.body ?? "" })),
        );
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\n--- server ---\n${server.output().split("\n").slice(-25).join("\n")}`,
        );
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
