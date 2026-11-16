// Replays send-authentication-token.golden.json (scripts/golden/send-authentication-token.rb): the
// real User#send_authentication_token! under the production Sidekiq executor.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { asSidekiqJob, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "../../worker/jobs/__fixtures__/golden.ts";
import { createJobsRuntime } from "../jobs/runtime.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";
import { sendAuthenticationToken } from "./two-factor-authentication.ts";

type Case = { name: string; feature: boolean; fallback_key: boolean; email: string | null; error: unknown; statements: unknown[]; redis: RedisSnapshot };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/send-authentication-token.golden.json", import.meta.url), "utf8")) as unknown as { now: number; cases: Case[] };

// job_id is a random UUID in production; the generator numbered them.
const withoutJobIds = (snapshot: unknown) => JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
// The Flipper and fallback keys are the inputs; the pushes are what the method writes.
const pushed = (snapshot: RedisSnapshot) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => key === "queues" || key.startsWith("queue:")));

describe("User#send_authentication_token!", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const reads: string[] = [];
      await asSidekiqJob(
        () =>
          sendAuthenticationToken(runtime, { id: 5, email: c.email }, {
            featureActive: async (name) => (reads.push(name), c.feature),
            redisExists: async (key) => (reads.push(key), c.fallback_key),
          }),
        golden.now,
      );

      expect(c.statements).toEqual([]);
      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(pushed(c.redis)));
      // The Ruby guard clauses stop at the first check that says no.
      expect(reads).toEqual(c.feature ? ["resend_fallback_for_auth_emails", "email_router_fallback:5"] : ["resend_fallback_for_auth_emails"]);
    });
  }
});
