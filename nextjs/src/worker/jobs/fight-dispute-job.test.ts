// Replays fight-dispute-job.golden.json (scripts/golden/fight-dispute-job.rb): the real FightDisputeJob run by the app against MySQL
// with Stripe answered by a capture server. Node must send the same statements and the same Stripe requests (method, path, body and
// idempotency key, in the same order), raise the same error and leave the same tracked failures. A submission Node does not make
// is handed back before the first Stripe call or write; Rails' own statements after that point are not Node's to match.
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { StripeClient, setStripeClientForTesting, type TransportRequest } from "../../server/stripe/client.ts";
import { stripeConfigFromEnv } from "../../server/stripe/config.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { fightDisputeJobWith } from "./fight-dispute-job.ts";

type Request = {
  method: string;
  path: string;
  query: string | null;
  headers?: Record<string, string>;
  body: string | null;
};
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
  stripe: { responses: [number, Record<string, string>, string][]; requests: Request[] };
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/fight-dispute-job.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: number;
  cases: Case[];
};
const now = () => new Date(Math.round(golden.now * 1000));

const summary = (request: Request) => ({
  method: request.method,
  path: request.path,
  query: request.query === "" ? null : request.query,
  body: request.body === "" ? null : request.body,
  idempotencyKey: request.headers?.["idempotency-key"] ?? null,
});

function fakeStripe(c: Case) {
  const requests: Request[] = [];
  const script = [...c.stripe.responses];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test", maxNetworkRetries: 0 },
    sleep: async () => {},
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      requests.push({
        method: request.method.toUpperCase(),
        path: path!,
        query: query.length ? query.join("?") : null,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        body: request.body ?? null,
      });
      const [status, headers, body] = script.shift() ?? [500, {}, "no scripted response"];
      return {
        status,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        body,
      };
    },
  });
  return { client, requests };
}

// The keys the recording ran with (.env.test), so the external id in the idempotency key is the one Rails produced.
const savedKeys = {
  cipher: process.env.OBFUSCATE_IDS_CIPHER_KEY,
  numeric: process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY,
};
beforeAll(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "0";
});
afterAll(() => {
  if (savedKeys.cipher === undefined) delete process.env.OBFUSCATE_IDS_CIPHER_KEY;
  else process.env.OBFUSCATE_IDS_CIPHER_KEY = savedKeys.cipher;
  if (savedKeys.numeric === undefined) delete process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY;
  else process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = savedKeys.numeric;
});
afterEach(() => setStripeClientForTesting(undefined));

function jobs() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

describe("FightDisputeJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const stripe = fakeStripe(c);
      setStripeClientForTesting(stripe.client);
      const { recording, runtime } = jobs();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => fightDisputeJobWith({ now })(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
        expect(sql.log.some((statement) => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
        // A read of the charge may precede the hand-back; nothing is submitted.
        expect(stripe.requests.filter((request) => request.method !== "GET")).toEqual([]);
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
        expect(stripe.requests.map(summary)).toEqual(c.stripe.requests.map(summary));
      }
      expect(recording.snapshot()).toEqual(c.hands_back ? {} : (c as unknown as { redis: object }).redis);
    });
  }

  it("raises the error class Rails raises", async () => {
    for (const c of golden.cases.filter((candidate) => candidate.error)) {
      const stripe = fakeStripe(c);
      setStripeClientForTesting(stripe.client);
      sqlReplay(c.statements);
      const { runtime } = jobs();
      const error = await asSidekiqJob(
        () => fightDisputeJobWith({ now })(c.args, contextFor(runtime)),
        golden.now,
      ).catch((e: unknown) => e);
      if (c.error!.class.startsWith("ChargeProcessor"))
        expect((error as { rubyClass: string }).rubyClass).toBe(c.error!.class);
    }
  });
});
