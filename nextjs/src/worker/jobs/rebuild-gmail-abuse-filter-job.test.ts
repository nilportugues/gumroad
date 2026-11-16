// Replays rebuild-gmail-abuse-filter-job.golden.json (scripts/golden/rebuild-gmail-abuse-filter-job.rb): RebuildGmailAbuseFilterJob
// run by the real app as a Sidekiq job. Node sends the same user batches and leaves the same Redis set behind, including the
// RENAME failure that keeps the old set when no abusive Gmail user exists.
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
import { rebuildGmailAbuseFilterJobWith } from "./rebuild-gmail-abuse-filter-job.ts";

const KEY = "gmail_abuse:normalized_emails";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/rebuild-gmail-abuse-filter-job.golden.json", import.meta.url), "utf8"),
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

// Just the sets and the three commands the job sends; anything else throws.
function setRedis(before: Record<string, string[]>) {
  const sets = new Map(Object.entries(before).map(([key, members]) => [key, new Set(members)]));
  return {
    snapshot: () =>
      Object.fromEntries(
        [...sets].map(([key, members]) => [key, { type: "set", value: [...members].sort(), expires: false }]),
      ),
    redis: {
      del: (key: string) => Promise.resolve(Number(sets.delete(key))),
      sadd: (key: string, member: string) => {
        sets.set(key, (sets.get(key) ?? new Set()).add(member));
        return Promise.resolve(1);
      },
      rename: (from: string, to: string) => {
        const members = sets.get(from);
        if (!members) return Promise.reject(new Error("ERR no such key"));
        sets.delete(from);
        sets.set(to, members);
        return Promise.resolve("OK" as const);
      },
    },
  };
}

function before(c: Case): Record<string, string[]> {
  const set = c.redis_before?.[KEY];
  const temp = c.redis_before?.[`${KEY}:rebuild`];
  return {
    ...(set ? { [KEY]: set.value as string[] } : {}),
    ...(temp ? { [`${KEY}:rebuild`]: temp.value as string[] } : {}),
  };
}

describe("RebuildGmailAbuseFilterJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const fake = setRedis(before(c));
      const handler = rebuildGmailAbuseFilterJobWith({}, { redis: () => fake.redis });
      let error: Error | null = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(runtime())), golden.now);
      } catch (e) {
        error = e as Error;
      }

      if (c.error) expect(c.error.message).toContain(error?.message ?? "no error");
      else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(fake.snapshot()).toEqual(c.redis);
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const fake = setRedis({});
    const handler = rebuildGmailAbuseFilterJobWith({}, { redis: () => fake.redis });
    await expect(asSidekiqJob(() => handler([1], contextFor(runtime())), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
