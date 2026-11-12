// Replays handle-sendgrid-event-job.golden.json (scripts/golden/handle-sendgrid-event-job.rb): HandleSendgridEventJob run by the real
// app as a Sidekiq job. Node drops the events Rails drops, runs the receipt events (the CustomerEmailInfo statements Rails sent) and the
// events no handler claims, and hands the whole job back, before any statement, when an event of the batch is another handler's or
// Rails fails on it. A malformed payload Rails fails on is handed back rather than failed.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
import { handleSendgridEventJobWith } from "./handle-sendgrid-event-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/handle-sendgrid-event-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const handler = handleSendgridEventJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

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

describe("HandleSendgridEventJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      // A charge receipt for a charge that is gone fails the state machine after its reads, with the transaction rolled back.
      if (c.error?.class === "StateMachines::InvalidTransition") {
        expect((error as Error | null)?.message).toBe(c.error.message);
        expect(sql.log).toEqual(sql.expected);
        return;
      }
      const handedBack = c.hands_back || c.error !== null;
      expect((error as Error | null)?.name ?? null).toBe(handedBack ? "HandBackToRuby" : null);
      // A hand-back leaves nothing written; otherwise Node sends the statements Rails sent.
      expect(sql.log).toEqual(handedBack ? [] : sql.expected);
    });
  }

  for (const args of [[], [null], [[]], ["x"]] as JsonValue[][]) {
    it(`rejects ${JSON.stringify(args)} before any statement`, async () => {
      const outcome = asSidekiqJob(() => handler(args, contextFor(runtime())), golden.now);
      if (args.length === 0) await expect(outcome).rejects.toThrow("wrong number of arguments");
      else await expect(outcome).rejects.toMatchObject({ name: "HandBackToRuby" });
    });
  }
});
