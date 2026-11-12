// Replays handle-sendgrid-event-job.golden.json (scripts/golden/handle-sendgrid-event-job.rb): HandleSendgridEventJob run by the real
// app as a Sidekiq job. Node drops the events Rails drops and hands back the job at the first event Rails acts on, or fails on,
// before any statement. A malformed payload Rails fails on is handed back rather than failed.
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
import { handleSendgridEventJob } from "./handle-sendgrid-event-job.ts";

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
        await asSidekiqJob(() => handleSendgridEventJob(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      expect((error as Error | null)?.name ?? null).toBe(c.hands_back || c.error !== null ? "HandBackToRuby" : null);
      expect(sql.log).toEqual([]);
      expect(sql.expected).toEqual([]);
    });
  }

  for (const args of [[], [null], [[]], ["x"]] as JsonValue[][]) {
    it(`rejects ${JSON.stringify(args)} before any statement`, async () => {
      const outcome = asSidekiqJob(() => handleSendgridEventJob(args, contextFor(runtime())), golden.now);
      if (args.length === 0) await expect(outcome).rejects.toThrow("wrong number of arguments");
      else await expect(outcome).rejects.toMatchObject({ name: "HandBackToRuby" });
    });
  }
});
