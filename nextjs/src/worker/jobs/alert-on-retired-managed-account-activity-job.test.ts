// Replays alert-on-retired-managed-account-activity-job.golden.json (scripts/golden/alert-on-retired-managed-account-activity-job.rb):
// AlertOnRetiredManagedAccountActivityJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the account, then
// the three legs of rows created since the retirement), pushes the same InternalNotificationWorker alert, and fails with the same
// ArgumentError for a retirement time Ruby rejects. A time whose Ruby error depends on which check trips first is handed back.
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
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { alertOnRetiredManagedAccountActivityJobWith } from "./alert-on-retired-managed-account-activity-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/alert-on-retired-managed-account-activity-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };

const now = () => new Date(Math.round(golden.now * 1000));
const handler = alertOnRetiredManagedAccountActivityJobWith({ now });

async function run(args: JsonValue[]) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, recording };
}

describe("AlertOnRetiredManagedAccountActivityJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { error, recording } = await run(c.args);

      expect(sql.log).toEqual(sql.expected);
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      if (error !== null) expect(error.name).toEqual(c.error?.class);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const [name, args] of [
    ["a float account id", [1.5, "2026-11-01T10:00:00Z"]],
    ["a null account id", [null, "2026-11-01T10:00:00Z"]],
    ["a word for an account id", ["abc", "2026-11-01T10:00:00Z"]],
  ] as [string, JsonValue[]][]) {
    it(`hands ${name} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const { error } = await run(args);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  const accountRead = () =>
    golden.cases.find((c) => c.name === "one balance transaction landed")!.statements.slice(0, 1);

  for (const [name, time] of [
    ["a year past 9999", "20261-01-01T00:00:00Z"],
    ["two out of range components", "2026-13-32T00:00:00Z"],
    ["an offset and a date that are both out of range", "2026-13-01T00:00:00+24"],
    ["hour 25", "2026-01-01T25:00:00Z"],
  ] as [string, string][]) {
    it(`hands ${name} back after reading the account`, async () => {
      const sql = sqlReplay(accountRead());
      const { error, recording } = await run([1, time]);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a retirement time that is not a string back after reading the account", async () => {
    const sql = sqlReplay(accountRead());
    const { error } = await run([1, 1_793_000_000]);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
  });
});
