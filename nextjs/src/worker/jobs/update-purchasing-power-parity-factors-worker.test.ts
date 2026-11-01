// Replays update-purchasing-power-parity-factors-job.golden.json (scripts/golden/update-purchasing-power-parity-factors-job.rb):
// the real job as a Sidekiq job against a local stand-in for the World Bank that serves each case's zip. A local
// HTTP server answers the same script here, and a fake Redis serves the case's currency rates and logs the
// commands to the `ppp` and `currencies` namespaces, which must be Ruby's, in order. Cases Node cannot read the
// way Ruby does must hand the job back before any write.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openUriRead } from "../../lib/ruby-open-uri.ts";
import { setCurrencyDepsForTesting } from "../../server/models/concerns/currency-helper.ts";
import { rubyFloatRoundDigits } from "../../server/models/concerns/ruby-numeric.ts";
import { setPurchasingPowerParityDepsForTesting } from "../../server/models/purchasing-power-parity.ts";
import { parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, goldenRuntime, recordingSidekiqRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { updatePurchasingPowerParityFactorsWorkerWith } from "./update-purchasing-power-parity-factors-worker.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  commands: string[][];
  requests: Array<{ method: string; path: string; query: string | null }>;
  responses: Array<{ status: number; headers: Record<string, string>; body: string }>;
  hand_back?: boolean;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/update-purchasing-power-parity-factors-job.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  cases: Case[];
  round2: [number | string | RubyFloat, number | string | RubyFloat][];
};

const BACKUP_RATES = readFileSync(new URL("../../../../lib/currency/backup_rates.json", import.meta.url), "utf8");
const API_PATH = "/v2/en/indicator/PA.NUS.PPP?downloadformat=csv";
const KEY = /^(ppp|currencies):/u;
const withoutPort = (text: string) => text.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:PORT");

// A server that answers the case's scripted responses in order, and 500 once they run out.
let server: Server;
let origin: string;
let script: Case["responses"] = [];
let requests: Case["requests"] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    const [path, query = null] = (request.url ?? "").split("?", 2) as [string, string?];
    requests.push({ method: request.method ?? "", path, query });
    const next = script.shift();
    if (next === undefined) {
      response.writeHead(500, "X", { "Content-Length": "20" }).end("no scripted response");
      return;
    }
    const body = Buffer.from(next.body, "base64");
    const headers = Object.fromEntries(Object.entries(next.headers).map(([name, value]) => [name, value.replace(/http:\/\/127\.0\.0\.1:\d+/u, origin)]));
    response.writeHead(next.status, "X", { ...headers, "Content-Length": String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  setPurchasingPowerParityDepsForTesting(undefined);
  setCurrencyDepsForTesting(undefined);
});

// A Redis holding the strings the case started with, logging the commands of the two namespaces.
function fakeRedis(before: RedisSnapshot) {
  const data = new Map(Object.entries(before).map(([key, entry]) => [key, entry.value as string]));
  const commands: string[][] = [];
  return {
    commands,
    data,
    redis: {
      async get(key: string) {
        if (KEY.test(key)) commands.push(["get", key]);
        return data.get(key) ?? null;
      },
      async set(key: string, value: string) {
        if (KEY.test(key)) commands.push(["set", key, value]);
        data.set(key, value);
        return "OK" as const;
      },
    },
  };
}

describe("UpdatePurchasingPowerParityFactorsWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const fake = fakeRedis(c.redis_before);
      setPurchasingPowerParityDepsForTesting({ redis: () => fake.redis as never });
      setCurrencyDepsForTesting({ redis: () => fake.redis as never, readSource: async () => BACKUP_RATES });
      script = c.responses.map((response) => ({ ...response }));
      requests = [];

      const handler = updatePurchasingPowerParityFactorsWorkerWith({
        now: () => new Date(Math.round(golden.now * 1000)),
        read: () => openUriRead(`${origin}${API_PATH}`),
      });
      let error: Error | null = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(goldenRuntime(recordingSidekiqRedis().redis))), golden.now);
      } catch (thrown) {
        error = thrown as Error;
      }

      expect(requests).toEqual(c.requests);
      if (c.hand_back === true) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(fake.commands).toEqual([]);
        return;
      }
      expect(error === null ? null : withoutPort(error.message)).toEqual(c.error === null ? null : withoutPort(c.error.message));
      expect(fake.commands).toEqual(c.commands);
      const stored = Object.fromEntries([...fake.data].filter(([key]) => KEY.test(key)));
      const expected = Object.fromEntries(Object.entries(c.redis).filter(([key]) => KEY.test(key)).map(([key, entry]) => [key, entry.value]));
      expect(stored).toEqual(expected);
    });
  }
});

describe("Float#round(2)", () => {
  // parseRubyJson keeps a whole-number Float apart from an Integer
  const decode = (value: number | string | RubyFloat): number =>
    value instanceof RubyFloat ? value.value : value === "NaN" ? Number.NaN : value === "Infinity" ? Infinity : value === "-Infinity" ? -Infinity : (value as number);
  it(`rounds ${golden.round2.length} inputs as Ruby does`, () => {
    const wrong = golden.round2.filter(([input, expected]) => !Object.is(rubyFloatRoundDigits(decode(input), 2), decode(expected)));
    expect(wrong.slice(0, 10)).toEqual([]);
  });
});

