// Replays stripe-jobs.golden.json (generate-stripe-jobs-golden.rb): the real Ruby jobs ran against
// the fake MySQL and the stripe gem against a local capture server. Each Node port must send the
// same statements and the same Stripe requests given the same answers, retry the same number of
// times, and log, raise and notify as Ruby did.
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { isRecordNotUnique } from "../../server/models/sql.ts";
import { setStripeClientForTesting, StripeClient, type TransportRequest } from "../../server/stripe/client.ts";
import { stripeConfigFromEnv } from "../../server/stripe/config.ts";
import { contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  createStripeApplePayDomainWorkerRetriesExhausted,
  createStripeApplePayDomainWorkerWith,
  deleteStripeApplePayDomainWorkerWith,
  syncStripeBusinessProfileUrlJobWith,
} from "./stripe-jobs.ts";

const notifyError = vi.hoisted(() => vi.fn());
vi.mock("../../server/infra/error-reporting.ts", () => ({ notifyError }));

type Recorded = { method: string; path: string; query: string | null; headers: Record<string, string>; body: string | null };
type GoldenCase = {
  name: string;
  args: JsonValue[];
  error?: { class: string; message: string };
  statements: Statement[];
  redis: RedisSnapshot;
  stripe: { responses: [number, Record<string, string>, string][]; requests: Recorded[] };
  retries: number;
  notifications: [string, Record<string, unknown>][];
  log: string[];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/stripe-jobs.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  jobs: Record<string, GoldenCase[]>;
  retries_exhausted: Record<string, { args: JsonValue[]; notifications: [string, Record<string, unknown>][] }[]>;
};
const now = () => new Date(Math.round(golden.now * 1000));

const PORTS: Record<string, typeof syncStripeBusinessProfileUrlJobWith> = {
  SyncStripeBusinessProfileUrlJob: syncStripeBusinessProfileUrlJobWith,
  CreateStripeApplePayDomainWorker: createStripeApplePayDomainWorkerWith,
  DeleteStripeApplePayDomainWorker: deleteStripeApplePayDomainWorkerWith,
};
const rubyRegistry = rubyRuntimeRegistry();

// User-Agent and X-Stripe-Client-User-Agent describe the bindings and are not recorded; the
// idempotency key is random and the telemetry header carries a duration, so both compare by shape.
// Content-Length is set by the transport (client.test.ts checks it on the wire).
const COMPARED_HEADERS = ["authorization", "content-type", "stripe-version", "stripe-account", "accept", "accept-encoding"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function normalize(request: Recorded) {
  const headers: Record<string, string | boolean> = {};
  for (const name of COMPARED_HEADERS) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
  headers["idempotency-key"] = UUID.test(request.headers["idempotency-key"] ?? "");
  headers["x-stripe-client-telemetry"] = request.headers["x-stripe-client-telemetry"] !== undefined;
  return { method: request.method, path: request.path, query: request.query, body: request.body, headers };
}

function fakeStripe(responses: GoldenCase["stripe"]["responses"]) {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const script = [...responses];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test" },
    sleep: async (seconds) => void sleeps.push(seconds),
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
      requests.push({ method: request.method.toUpperCase(), path: path!, query: query.length ? query.join("?") : null, headers, body: request.body });
      const [status, responseHeaders, body] = script.shift() ?? [500, {}, "no scripted response"];
      return { status, headers: Object.fromEntries(Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v])), body };
    },
  });
  return { client, requests, sleeps };
}

const savedEnv = process.env.RAILS_ENV;
beforeAll(() => {
  // The golden ran with Rails.env production: gumroad.com hosts, the beta API version, and
  // CreateStripeApplePayDomainWorker not short-circuiting as it does in test.
  process.env.RAILS_ENV = "production";
});
afterAll(() => {
  process.env.RAILS_ENV = savedEnv;
});
afterEach(() => {
  setStripeClientForTesting(undefined);
  notifyError.mockReset();
  vi.restoreAllMocks();
});

for (const [name, cases] of Object.entries(golden.jobs)) {
  describe(name, () => {
    it.each(cases.map((c) => [c.name, c] as const))("%s", async (_, c) => {
      const sql = sqlReplay(c.statements);
      const stripe = fakeStripe(c.stripe.responses);
      setStripeClientForTesting(stripe.client);
      const logged: string[] = [];
      vi.spyOn(console, "info").mockImplementation((message: string) => void logged.push(message));
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRegistry, now: () => golden.now, newJid: sequentialJids() });

      let error: unknown = null;
      try {
        await PORTS[name]!({ now })(c.args, contextFor(runtime));
      } catch (e) {
        error = e;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(stripe.requests.map(normalize)).toEqual(c.stripe.requests.map(normalize));
      expect(stripe.sleeps.length).toBe(c.retries);
      expect(logged).toEqual(c.log);
      expect(notifyError.mock.calls.map(([message, context = {}]) => [message, context])).toEqual(c.notifications);
      expect(recording.snapshot()).toEqual(c.redis);
      if (c.error?.class === "ActiveRecord::RecordNotUnique") {
        // The message is the fake MySQL driver's; the class is what Sidekiq retries on.
        expect(isRecordNotUnique(error)).toBe(true);
      } else {
        const actual = error === null ? null : { class: (error as { rubyClass?: string }).rubyClass, message: (error as Error).message };
        expect(actual).toEqual(c.error ?? null);
      }
    });
  });
}

describe("CreateStripeApplePayDomainWorker sidekiq_retries_exhausted", () => {
  it.each(golden.retries_exhausted.CreateStripeApplePayDomainWorker!.map((c) => [JSON.stringify(c.args), c] as const))("args %s", async (_, c) => {
    const { redis } = recordingSidekiqRedis();
    const runtime = createJobsRuntime({ sidekiqRedis: redis, bullmqRedis: redis, registry: rubyRegistry, now: () => golden.now });
    await createStripeApplePayDomainWorkerRetriesExhausted({ class: "CreateStripeApplePayDomainWorker", jid: "abc", queue: "low", args: c.args, retry: 3 }, new Error("boom"), { runtime });
    expect(notifyError.mock.calls.map(([message, context = {}]) => [message, context])).toEqual(c.notifications);
  });
});
