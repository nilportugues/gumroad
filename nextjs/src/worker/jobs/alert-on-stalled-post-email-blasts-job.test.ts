// Replays alert-on-stalled-post-email-blasts-job.golden.json (scripts/golden/alert-on-stalled-post-email-blasts-job.rb): the job run by
// the real app as a Sidekiq job. Node sends the statements Rails sent for the abandoned-blast expiry and the candidate read, scans the
// dead, retry, queued and busy sets the case started from (`redis_before`), claims the same markers, pushes the same
// SendPostBlastEmailsJob and InternalNotificationWorker jobs and removes the same dead entries.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  alertOnStalledPostEmailBlastsJobWith,
  type StalledBlastRedis,
} from "./alert-on-stalled-post-email-blasts-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-stalled-post-email-blasts-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// The sale the golden injects between the expiry reads is the test setup, not something the job sends.
const sentBySetup = (s: Statement) => s.sql.startsWith("INSERT INTO sent_post_emails");

// A case whose Rails run took an entry out of the dead set.
const removesDeadEntry = (c: Case) => {
  if (c.name === "a dead blast whose sender reappears busy") return true;
  const before = (c.redis_before?.dead?.value ?? []) as [string, number][];
  const after = new Set(((c.redis.dead?.value ?? []) as [string, number][]).map(([member]) => member));
  return before.some(([member]) => !after.has(member));
};

const FLAG = "auto_resume_stalled_post_blasts";

type Stored = RedisSnapshot[string];

// The commands the job sends, over the keys the case started from; anything else throws.
function scratchRedis(before: RedisSnapshot, afterScan?: (store: Map<string, Stored>) => void) {
  const store = new Map<string, Stored>(Object.entries(before).map(([key, entry]) => [key, structuredClone(entry)]));
  let queueReads = 0;
  const members = (key: string) => (store.get(key)?.value ?? []) as unknown[];
  const redis: StalledBlastRedis = {
    get: (key) => Promise.resolve((store.get(key)?.value as string | undefined) ?? null),
    exists: (key) => Promise.resolve(Number(store.has(key))),
    set: (key, value, _expiry, _seconds, _mode) => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, { type: "string", value, expires: true });
      return Promise.resolve("OK");
    },
    hgetall: (key) => Promise.resolve((store.get(key)?.value ?? {}) as Record<string, string>),
    smembers: (key) => Promise.resolve(members(key) as string[]),
    lrange: (key, start, stop) => {
      const result = (members(key) as string[]).slice(start, stop === -1 ? undefined : stop + 1);
      // The queue is the last set the first scan reads: a sender the golden injects appears after it, before the resume decision.
      if (key === "queue:default" && (queueReads += 1) === 1) afterScan?.(store);
      return Promise.resolve(result);
    },
    zscanMembers: (key, text) =>
      Promise.resolve(
        (members(key) as [string, number][]).map(([member]) => member).filter((member) => member.includes(text)),
      ),
  };
  return { redis, store };
}

const entry = (klass: string, id: number) =>
  `{"class":"${klass}","args":[${id}],"jid":"jid${id}","queue":"default","retry":10,"created_at":1.0,"enqueued_at":1.0}`;
const lpush = (key: string, value: string) => (store: Map<string, Stored>) => {
  const list = store.get(key) ?? { type: "list", value: [], expires: false };
  store.set(key, { ...list, value: [value, ...(list.value as string[])] });
};
// The senders the golden's `after_scan` hooks add once the scans are done.
const AFTER_SCAN: Record<string, (store: Map<string, Stored>) => void> = {
  "a fully delivered blast whose sender reappears": lpush("queue:default", entry("SendPostBlastEmailsJob", 1)),
  "an unaccounted blast whose sender reappears": (store) =>
    store.set("retry", {
      type: "zset",
      value: [[entry("SendPostBlastEmailsSliceJob", 1), new RubyFloat(1_700_000_000)]],
      expires: false,
    }),
  "a dead blast whose sender reappears busy": (store) => {
    store.set("processes", { type: "set", value: ["host:1:abc"], expires: false });
    store.set("host:1:abc", { type: "hash", value: { info: "{}" }, expires: false });
    store.set("host:1:abc:work", {
      type: "hash",
      value: {
        tid1: JSON.stringify({ queue: "default", payload: entry("SendPostBlastEmailsJob", 1), run_at: 1_700_000_000 }),
      },
      expires: false,
    });
  },
};

// The pushes the job made on top of what the case started with: lpush puts them ahead, `queues` gains a member.
function merged(store: Map<string, Stored>, pushes: RedisSnapshot): RedisSnapshot {
  const result: RedisSnapshot = Object.fromEntries(store);
  for (const [key, entry] of Object.entries(pushes)) {
    const existing = result[key];
    if (existing?.type === "list")
      result[key] = { ...existing, value: [...(entry.value as string[]), ...(existing.value as string[])] };
    else if (existing?.type === "set")
      result[key] = {
        ...existing,
        value: [...new Set([...(existing.value as string[]), ...(entry.value as string[])])].sort(),
      };
    else result[key] = entry;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function run(
  c: Case,
  statements: Statement[] = c.statements.filter((s) => !sentBySetup(s)),
  options: {
    afterScan?: (store: Map<string, Stored>) => void;
    wrap?: (redis: StalledBlastRedis) => StalledBlastRedis;
  } = {},
) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  const scratch = scratchRedis(c.redis_before ?? {}, options.afterScan);
  const handler = alertOnStalledPostEmailBlastsJobWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    { redis: () => (options.wrap ? options.wrap(scratch.redis) : scratch.redis) },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording, scratch };
}

describe("AlertOnStalledPostEmailBlastsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const after = AFTER_SCAN[c.name];
      const { error, sql, recording, scratch } = await run(c, undefined, { afterScan: after });

      expect(sql.log).toEqual(sql.expected);
      if (removesDeadEntry(c)) {
        // Rails drops the dead entry through sidekiq-unique-jobs; Node hands the run back before its first resume write.
        expect(error?.name).toBe("HandBackToRuby");
        expect(recording.snapshot()).toEqual({});
        if (!after) expect(Object.fromEntries(scratch.store)).toEqual(c.redis_before ?? {});
        return;
      }
      expect(error).toBeNull();
      expect(merged(scratch.store, recording.snapshot())).toEqual(c.redis);
    });
  }

  const base = () => golden.cases.find((c) => c.name === "an unaccounted blast, auto-resume on")!;

  it("holds a resume marker for the four-hour stall window", async () => {
    const seconds: number[] = [];
    const { error } = await run(base(), undefined, {
      wrap: (redis) => ({
        ...redis,
        set: (key, value, expiry, ttl, mode) => {
          seconds.push(ttl);
          return redis.set(key, value, expiry, ttl, mode);
        },
      }),
    });

    expect(error).toBeNull();
    expect(seconds).toEqual([14_400]);
  });

  for (const [label, before] of [
    [
      "a flag on a percentage of time",
      { [FLAG]: { type: "hash", value: { percentage_of_time: "50" }, expires: false } },
    ],
    [
      "a flag with an expression gate",
      { [FLAG]: { type: "hash", value: { expression: '{"Boolean":true}' }, expires: false } },
    ],
    [
      "a quota deferral time that is not ISO 8601",
      { "blast:1:quota_deferred_until": { type: "string", value: "tomorrow", expires: false } },
    ],
    [
      "a dead set entry that is not JSON",
      { dead: { type: "zset", value: [["{broken SendPostBlastEmailsJob", 1]], expires: false } },
    ],
  ] as [string, RedisSnapshot][]) {
    it(`hands back ${label} before any resume write`, async () => {
      const c = {
        ...base(),
        redis_before: { [FLAG]: { type: "hash", value: { boolean: "true" }, expires: false }, ...before },
      };
      const { error, sql, recording, scratch } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
      expect(Object.fromEntries(scratch.store)).toEqual(c.redis_before);
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
