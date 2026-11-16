// Replays alert-on-blocked-established-buyers-job.golden.json (scripts/golden/alert-on-blocked-established-buyers-job.rb): the job run by the real app as a
// Sidekiq job. Node sends the candidate read and, per slice of 500, the settled-history and dispute reads Rails sent, and finishes the
// runs where no candidate survives them. A run where one does (Rails went on to read the latest failures) hands back at that point.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setSqlClient } from "../../server/models/sql.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { alertOnBlockedEstablishedBuyersJobWith } from "./alert-on-blocked-established-buyers-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-blocked-established-buyers-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const LATEST_FAILURES = "SELECT `purchases`.`email`, `purchases`.`id` FROM";
// Rails reached the latest-failure read: some buyer survived the filters Node ports.
const goesOn = (c: Case) => c.statements.some((s) => s.sql.startsWith(LATEST_FAILURES));

async function run(c: Case) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(c.statements);
  let error: Error | null = null;
  try {
    await asSidekiqJob(
      () =>
        alertOnBlockedEstablishedBuyersJobWith({ now: () => new Date(Math.round(golden.now * 1000)) })(
          [],
          contextFor(runtime),
        ),
      golden.now,
    );
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("AlertOnBlockedEstablishedBuyersJob", () => {
  for (const c of golden.cases.filter((c) => !goesOn(c))) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter(goesOn)) {
    it(`hands ${c.name} back once a buyer survives the filters`, async () => {
      const { error, sql, recording } = await run(c);

      const upToTheLatestFailures = sql.expected.findIndex((text) => text.startsWith(LATEST_FAILURES));
      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, upToTheLatestFailures));
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands back a scan that stopped at the candidate budget, which Rails reports even with nobody qualifying", async () => {
    const answers = [Array.from({ length: 20_001 }, (_, i) => ({ email: `buyer${i}@example.com` }))];
    setSqlClient(() => ({ $queryRaw: async () => answers.shift() ?? [], $executeRaw: async () => 0 }) as never);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = alertOnBlockedEstablishedBuyersJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
    await expect(asSidekiqJob(() => handler([], contextFor(runtime)), golden.now)).rejects.toThrow(/truncated scan/u);
    expect(recording.snapshot()).toEqual({});
  });

  it("rejects an extra argument, as perform takes none", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(() => alertOnBlockedEstablishedBuyersJobWith()([1], contextFor(runtime)), golden.now),
    ).rejects.toBeInstanceOf(Error);
  });
});
