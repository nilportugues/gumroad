// Replays radar-sync-value-lists-job.golden.json (scripts/golden/radar-sync-value-lists-job.rb): Radar::SyncValueListsJob run by the real
// app against MySQL, with Stripe answered by a capture server. Node sends the same statements and the same Stripe requests (method,
// path, query, body), given the same answers, and fails with the same error. Headers are client.test.ts's concern. A case where the
// table changes while the first item is added reruns the one write the recording shows right after that item call, as the Ruby run
// did from inside Stripe::Radar::ValueListItem.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { execute } from "../../server/models/sql.ts";
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
import { radarSyncValueListsJobWith } from "./radar-sync-value-lists-job.ts";

type Request = { method: string; path: string; query: string | null; body: string | null };
type Case = {
  name: string;
  args: JsonValue[];
  enabled: boolean;
  error: { class: string; message: string } | null;
  statements: Statement[];
  stripe: { responses: [number, Record<string, string>, string][]; requests: Request[] };
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/radar-sync-value-lists-job.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: number;
  cases: Case[];
};
const now = () => new Date(Math.round(golden.now * 1000));
const handler = radarSyncValueListsJobWith({ now });
// What Stripe::Error#class prints for the errors the recording raised.
const RUBY_CLASS: Record<string, string> = {
  Error: "RuntimeError",
  APIError: "Stripe::APIError",
  InvalidRequestError: "Stripe::InvalidRequestError",
};

function fakeStripe(c: Case) {
  const requests: Request[] = [];
  const script = [...c.stripe.responses];
  // The recording's write that ran inside an item call.
  const concurrentWrites = c.statements
    .map((s) => s.sql)
    .filter((sql) => sql.startsWith("UPDATE `platform_blocks`") || sql.startsWith("DELETE FROM `platform_blocks`"));
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test", maxNetworkRetries: 0 },
    sleep: async () => {},
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      requests.push({
        method: request.method.toUpperCase(),
        path: path!,
        query: query.length ? query.join("?") : null,
        body: request.body ?? null,
      });
      const [status, headers, body] = script.shift() ?? [500, {}, "no scripted response"];
      const writesItem = path!.startsWith("/v1/radar/value_list_items") && request.method.toUpperCase() !== "GET";
      if (writesItem && concurrentWrites.length > 0) await execute(Prisma.raw(concurrentWrites.shift()!));
      return {
        status,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        body,
      };
    },
  });
  return { client, requests };
}

// Ruby's Net::HTTP sends `?` with an empty query on a DELETE.
const normalize = (r: Request) => ({
  ...r,
  query: r.query === "" ? null : r.query,
  body: r.body === "" ? null : r.body,
});

const original = { railsEnv: process.env.RAILS_ENV, radar: process.env.ENABLE_RADAR_VALUE_LIST_SYNC };
beforeEach(() => {
  process.env.RAILS_ENV = "test";
});
afterEach(() => {
  setStripeClientForTesting(undefined);
  if (original.railsEnv === undefined) delete process.env.RAILS_ENV;
  else process.env.RAILS_ENV = original.railsEnv;
  if (original.radar === undefined) delete process.env.ENABLE_RADAR_VALUE_LIST_SYNC;
  else process.env.ENABLE_RADAR_VALUE_LIST_SYNC = original.radar;
});

describe("Radar::SyncValueListsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      if (c.enabled) process.env.ENABLE_RADAR_VALUE_LIST_SYNC = "1";
      else delete process.env.ENABLE_RADAR_VALUE_LIST_SYNC;
      const sql = sqlReplay(c.statements);
      const stripe = fakeStripe(c);
      setStripeClientForTesting(stripe.client);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(stripe.requests.map(normalize)).toEqual(c.stripe.requests.map(normalize));
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      if (error !== null) expect(RUBY_CLASS[(error as Error).name] ?? (error as Error).name).toEqual(c.error?.class);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
