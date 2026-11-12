// Replays handle-resend-event-job.golden.json (scripts/golden/handle-resend-event-job.rb): HandleResendEventJob run by the real app
// as a Sidekiq job. Node drops the events Rails drops, runs the receipt events of a purchase or a charge (the CustomerEmailInfo statements Rails sent) and the
// events no handler claims, and hands back the ones another handler acts on or Rails fails on, before any statement. A payload whose
// date or workflow ids Node cannot judge exactly is handed back even where Rails drops it (CONSERVATIVE).
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { handleResendEventJobWith } from "./handle-resend-event-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/handle-resend-event-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Rails drops these; the parser behind them (Ruby's Time.zone.parse, JSON.parse) is not reproduced for every input.
const CONSERVATIVE = new Set([
  "an untracked type with a created_at that does not parse",
  "a delivered event with a created_at that does not parse",
]);

// Piracy notices Node hands back before any statement though Rails runs them: a recipient that is not text or not ASCII (casecmp?
// folds Unicode), and a report id too long for a plain integer (Rails answers without a query).
CONSERVATIVE.add("a delivered piracy notice with a non-ASCII recipient");
CONSERVATIVE.add("a delivered piracy notice with a recipient that is not text");
CONSERVATIVE.add("a delivered piracy notice with a report id too long for a plain integer");
const READ_THEN_HAND_BACK = new Set<string>();

beforeEach(() => vi.stubEnv("MAILER_HEADERS_ENCRYPTION_KEY_V1", "test_encryption_key"));
afterEach(() => vi.unstubAllEnvs());

const handler = handleResendEventJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

function runtime() {
  const recording = recordingSidekiqRedis();
  return createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

describe("HandleResendEventJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      // A charge receipt for a charge that is gone fails the state machine after its reads, with the transaction rolled back; a piracy
      // report whose seller or product is gone fails its validations the same way.
      if (
        c.error?.class === "StateMachines::InvalidTransition" ||
        (c.error?.class === "ActiveRecord::RecordInvalid" &&
          /^Validation failed: (Seller|Product) must exist/u.test(c.error.message))
      ) {
        expect((error as Error | null)?.message).toBe(c.error.message);
        expect(sql.log).toEqual(sql.expected);
        return;
      }
      // A piracy report Node cannot judge once it has read it (its validations fail on text Node does not build the message of)
      // is handed back after that one read, before BEGIN.
      if (c.error?.class === "ActiveRecord::RecordInvalid") {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, 1));
        return;
      }
      if (READ_THEN_HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, 1));
        return;
      }
      const handedBack = c.hands_back || c.error !== null || CONSERVATIVE.has(c.name);
      expect((error as Error | null)?.name ?? null).toBe(handedBack ? "HandBackToRuby" : null);
      expect(sql.log).toEqual(handedBack ? [] : sql.expected);
    });
  }

  for (const args of [[], [null], [[]], ["x"], [1]] as JsonValue[][]) {
    it(`rejects ${JSON.stringify(args)} before any statement`, async () => {
      const outcome = asSidekiqJob(() => handler(args, contextFor(runtime())), golden.now);
      if (args.length === 0) await expect(outcome).rejects.toThrow("wrong number of arguments");
      else await expect(outcome).rejects.toMatchObject({ name: "HandBackToRuby" });
    });
  }
});
