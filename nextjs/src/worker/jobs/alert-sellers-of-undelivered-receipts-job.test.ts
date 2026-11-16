// Replays alert-sellers-of-undelivered-receipts-job.golden.json
// (scripts/golden/alert-sellers-of-undelivered-receipts-job.rb): the job run by the real app as a Sidekiq job. Node reads the
// cursor and retry set the case started from (`redis_before`), sends the statements Rails sent and writes the cursor back as Rails
// wrote it; a receipt old enough to judge, a retry set and a first run that must search for its start hand the job back whole, having
// written nothing.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden } from "./__fixtures__/replay-job-golden.ts";
import { scratchRedis } from "./__fixtures__/scratch-redis.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { alertSellersOfUndeliveredReceiptsJobWith } from "./alert-sellers-of-undelivered-receipts-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/alert-sellers-of-undelivered-receipts-job.golden.json", import.meta.url),
);
const now = () => new Date(Math.round(Number(golden.now) * 1000));
// A whole number of seconds is a Float in the golden, which parses to a RubyFloat.
const seconds = (value: unknown) => (value instanceof RubyFloat ? value.value : Number(value));
const failing = () => Promise.reject(new Error("connection lost"));

describe("AlertSellersOfUndeliveredReceiptsJob", () => {
  for (const c of golden.cases as (Omit<(typeof golden.cases)[number], "redis"> & {
    now: number;
    redis: Record<string, never>;
    redis_before?: Record<string, never>;
  })[]) {
    it(c.hands_back ? `hands back ${c.name} before any write` : c.name, async () => {
      const sql = sqlReplay(c.statements);
      const cursor = scratchRedis(c.redis_before);
      const sidekiq = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: sidekiq.redis,
        bullmqRedis: sidekiq.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      // A case on a clock with no fraction of a second carries it; the others share the golden's.
      const clock = () => new Date(Math.round(seconds(c.now ?? golden.now) * 1000));
      const handler = alertSellersOfUndeliveredReceiptsJobWith({ now: clock }, { redis: () => cursor.redis });
      const error = await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now).then(
        () => null,
        (e: unknown) => e as Error,
      );

      if (c.hands_back) {
        expect(error?.name).toBe("HandBackToRuby");
        // Only reads of the cursor and the retry set: the cursor is written once the scan has ended.
        expect(cursor.commands.filter((command) => command !== "get" && command !== "srandmember")).toEqual([]);
      } else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      if (!c.hands_back) expect(cursor.snapshot()).toEqual(c.redis);
      expect(sidekiq.snapshot()).toEqual({});
    });
  }

  // Rails reports a Redis error and goes on without it, which a recording cannot show: Node hands the job back instead.
  for (const [command, rejects] of [
    ["get", { get: failing }],
    ["srandmember", { srandmember: failing }],
    ["set", { set: failing }],
  ] as const) {
    it(`hands back when Redis ${command} fails`, async () => {
      // The write comes after the scan; the reads fail before any statement.
      const scan = golden.cases.find((c) => c.name === "no receipts and a cursor")!.statements;
      sqlReplay(command === "set" ? scan : []);
      const sidekiq = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: sidekiq.redis,
        bullmqRedis: sidekiq.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const redis = {
        ...scratchRedis({ "undelivered_receipt_sweep:cursor": { type: "string", value: "5", expires: false } }).redis,
        ...rejects,
      };
      const handler = alertSellersOfUndeliveredReceiptsJobWith({ now }, { redis: () => redis });
      await expect(asSidekiqJob(() => handler([], contextFor(jobs)), golden.now)).rejects.toMatchObject({
        name: "HandBackToRuby",
      });
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const sidekiq = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: sidekiq.redis,
      bullmqRedis: sidekiq.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = alertSellersOfUndeliveredReceiptsJobWith({ now }, { redis: () => scratchRedis({}).redis });
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
