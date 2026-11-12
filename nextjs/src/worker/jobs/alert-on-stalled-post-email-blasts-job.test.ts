// Replays alert-on-stalled-post-email-blasts-job.golden.json (scripts/golden/alert-on-stalled-post-email-blasts-job.rb): the job run by
// the real app as a Sidekiq job. Node sends the statements Rails sent for the abandoned-blast expiry (the ids read, the re-check and
// the update) and the candidate read, and finishes the runs with no candidate. A run Rails went on to scan Sidekiq for hands back
// after the candidate read.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { alertOnStalledPostEmailBlastsJobWith } from "./alert-on-stalled-post-email-blasts-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  hands_back: boolean;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// The sale the golden injects between the expiry reads is the test setup, not something the job sends.
const sentBySetup = (s: Statement) => s.sql.startsWith("INSERT INTO sent_post_emails");

async function run(c: Case, statements: Statement[] = c.statements.filter((s) => !sentBySetup(s))) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  const handler = alertOnStalledPostEmailBlastsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("AlertOnStalledPostEmailBlastsJob", () => {
  for (const c of golden.cases) {
    it(c.hands_back ? `hands back ${c.name} after the candidate read` : c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(sql.log).toEqual(sql.expected);
      if (c.hands_back) expect(error?.name).toBe("HandBackToRuby");
      else expect(error).toBeNull();
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands back a failed expiry without scanning", async () => {
    const c = golden.cases.find((c) => c.name === "an abandoned blast")!;
    const failing = c.statements.map((s, i) =>
      i === 2 ? { ...s, result: { error: { number: 1205, message: "Lock wait timeout exceeded" } } } : s,
    );
    const { error, sql } = await run(c, failing.slice(0, 3));

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
  });

  it("rejects an argument, as perform takes none", async () => {
    const handler = alertOnStalledPostEmailBlastsJobWith();
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });

    await expect(handler([1], contextFor(runtime))).rejects.toThrow();
  });
});
