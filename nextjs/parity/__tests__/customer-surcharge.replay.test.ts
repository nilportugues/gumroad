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
import type { CapturedHttp } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/customer_surcharge_parity_spec.rb: POST /customer_surcharge, which the port answers for every cart without
// a buyer-currency quote. TaxJar, IRAS, Revenu Quebec and taxid.pro are one local stand-in that serves the recorded answers in
// order (a dropped connection is a destroyed socket) and keeps what the port sent; the vendors sit under a path prefix of their own.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/customer_surcharge_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const GEOIP_FIXTURE = path.join(process.cwd(), "src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb");
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

const VENDOR_HOSTS: Record<string, string> = {
  "taxjar.com": "",
  "apisandbox.iras.gov.sg": "/iras",
  "svcnab2b.revenuquebec.ca": "/qst",
  "v3.api.taxid.pro": "/taxid",
  "ec.europa.eu": "/vies",
  "api.vatstack.com": "/vatstack",
};
// The endpoints the port takes whole (the others are bases).
const WHOLE_URL_PREFIXES = ["/iras", "/vies", "/vatstack"];
const vendorOf = (call: CapturedHttp) =>
  Object.keys(VENDOR_HOSTS).find((host) => new URL(call.url).hostname.endsWith(host));
// Where the port should send what Rails sent to the vendor: IRAS_ENDPOINT, VIES_ENDPOINT and VATSTACK_ENDPOINT are the whole URL, the others are bases.
const expectedPath = (call: CapturedHttp) => {
  const url = new URL(call.url);
  const prefix = VENDOR_HOSTS[vendorOf(call) ?? ""] ?? "";
  return decodeURIComponent(WHOLE_URL_PREFIXES.includes(prefix) ? prefix : `${prefix}${url.pathname}${url.search}`);
};

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
      file.replace(/\.json$/u, "").replace(/^customer-surcharge-/u, ""),
      fixturePath,
      loadFixture(fixturePath).exchanges.length - 1,
    ] as const;
  });

describe.skipIf(!url)("Customer surcharge parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let taxjar: Server;
  const taxjarRecorded: CapturedHttp[] = [];
  const taxjarReceived: { method: string; url: string; contentType: string | undefined; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((_, response) => response.writeHead(218, { "x-handed-back": "rails" }).end());
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    taxjar = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        taxjarReceived.push({
          method: request.method ?? "",
          url: request.url ?? "",
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const answer = taxjarRecorded.shift()?.response;
        if (answer === undefined) return void response.writeHead(599).end("parity: no recorded vendor answer");
        if (answer.dropped) return void request.socket.destroy();
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => taxjar.listen(0, "127.0.0.1", resolve));
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_checkout_surcharge",
      TAXJAR_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}`,
      IRAS_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}/iras`,
      REVENU_QUEBEC_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}/qst`,
      TAX_ID_PRO_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}/taxid`,
      VIES_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}/vies`,
      VATSTACK_ENDPOINT: `http://127.0.0.1:${(taxjar.address() as AddressInfo).port}/vatstack`,
      VATSTACK_API_KEY: "vatstack-key",
      IRAS_API_ID: "iras-id",
      IRAS_API_SECRET: "iras-secret",
      TAX_ID_PRO_API_KEY: "taxid-key",
      GEOIP_DATABASE_PATH: GEOIP_FIXTURE,
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((resolve) => (rails ? rails.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (taxjar ? taxjar.close(() => resolve()) : resolve()));
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it.each(cases)(
    "%s",
    async (_name, fixturePath, index) => {
      const fixture = loadFixture(fixturePath);
      const recorded = fixture.exchanges[index]!.http.filter((call) => vendorOf(call) !== undefined);
      taxjarRecorded.splice(0, taxjarRecorded.length, ...recorded);
      taxjarReceived.length = 0;
      const result = await replayFixtureExchange(fixture, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        compare: COMPARE,
      });
      try {
        assertParity(result);
        // The port asked the vendors exactly what Rails asked, in the same order.
        expect(
          taxjarReceived.map(({ method, url, contentType, body }) => ({
            method,
            path: decodeURIComponent(url),
            contentType,
            body,
          })),
        ).toEqual(
          recorded.map((call) => ({
            method: call.method,
            path: expectedPath(call),
            // Net::HTTP adds the form type the recording of a Vatstack call does not carry.
            contentType:
              call.contentType ??
              (vendorOf(call) === "api.vatstack.com" ? "application/x-www-form-urlencoded" : undefined),
            body: call.body ?? "",
          })),
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
