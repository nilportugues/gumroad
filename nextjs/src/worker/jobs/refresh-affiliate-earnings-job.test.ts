// Replays refresh-affiliate-earnings-job.golden.json (scripts/golden/refresh-affiliate-earnings-job.rb): RefreshAffiliateEarningsJob and
// its retries-exhausted block run by the real app as a Sidekiq job, with Rails.cache spied on. Node sends the same statements (the
// affiliate read and the hinted sum), makes the same cache reads, writes (value, TTL, `unless_exist`) and deletes in the same order,
// and fails the same way when the sum does. An id Rails casts (a float, a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type MarshalValue, RubySymbol, RubyTimeWithZone } from "../../server/cache/marshal.ts";
import { type RailsCache, createRailsCache } from "../../server/cache/rails-cache.ts";
import { createMemoryTransport } from "../../server/cache/transport.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  refreshAffiliateEarningsJobRetriesExhaustedWith,
  refreshAffiliateEarningsJobWith,
} from "./refresh-affiliate-earnings-job.ts";

type Desc =
  | { t: "nil" }
  | { t: "bool"; v: boolean }
  | { t: "int" | "str" | "sym"; v: string }
  | { t: "twz"; sec: string; nsec: number }
  | { t: "hash"; v: [Desc, Desc][] };
type Case = {
  name: string;
  args: JsonValue[];
  hook?: boolean;
  error: { class: string; message: string } | null;
  statements: Statement[];
  cache_before: [string, Desc, number | null][];
  cache_ops: [string, string, ...unknown[]][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/refresh-affiliate-earnings-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: { sec: number; nsec: number }; cases: Case[] };
const NOW = new RubyTimeWithZone(golden.now.sec, golden.now.nsec);
const NOW_SECONDS = NOW.toFloat();

// Rails casts these ids; Node hands them back before any statement.
const CAST_IDS = new Set(["an affiliate id given as a float", "an affiliate id given as a word"]);

function build(desc: Desc): MarshalValue {
  switch (desc.t) {
    case "nil":
      return null;
    case "bool":
      return desc.v;
    case "int":
      return Number(desc.v);
    case "str":
      return desc.v;
    case "sym":
      return new RubySymbol(desc.v);
    case "twz":
      return new RubyTimeWithZone(Number(desc.sec), desc.nsec);
    case "hash":
      return new Map(desc.v.map(([key, value]) => [build(key), build(value)]));
  }
}

function describeValue(value: MarshalValue | undefined): Desc {
  if (value === undefined || value === null) return { t: "nil" };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "number" || typeof value === "bigint") return { t: "int", v: String(value) };
  if (typeof value === "string") return { t: "str", v: value };
  if (value instanceof RubySymbol) return { t: "sym", v: value.name };
  if (value instanceof RubyTimeWithZone) return { t: "twz", sec: String(value.seconds), nsec: value.nanoseconds };
  if (value instanceof Map) return { t: "hash", v: [...value].map(([k, v]) => [describeValue(k), describeValue(v)]) };
  throw new Error("cannot describe");
}

// Rails.cache over the Node store, recording what the job asks of it the way the generator's spy did.
function spiedCache() {
  const ops: unknown[][] = [];
  const store = createRailsCache({
    transport: createMemoryTransport(() => NOW_SECONDS),
    namespace: null,
    now: () => NOW_SECONDS,
  });
  const cache: RailsCache = {
    ...store,
    async read(name, options) {
      const value = await store.read(name, options);
      ops.push(["read", name, describeValue(value)]);
      return value;
    },
    async write(name, value, options) {
      const written = await store.write(name, value, options);
      const recorded: Record<string, unknown> = {};
      if (options?.expiresIn !== undefined) recorded.expires_in = options.expiresIn;
      if (options?.unlessExist) recorded.unless_exist = true;
      ops.push(["write", name, describeValue(value), recorded, written]);
      return written;
    },
    async delete(name, options) {
      const deleted = await store.delete(name, options);
      ops.push(["delete", name, deleted]);
      return deleted;
    },
  };
  return { cache, ops, store };
}

async function run(c: Case) {
  const sql = sqlReplay(c.statements);
  const { cache, ops, store } = spiedCache();
  for (const [key, value, expiresIn] of c.cache_before)
    await store.write(key, build(value), expiresIn === null ? {} : { expiresIn });
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW_SECONDS,
    newJid: sequentialJids(),
  });
  const deps = { now: () => NOW, cache: () => cache };
  let error: Error | null = null;
  try {
    await asSidekiqJob(
      () =>
        c.hook
          ? refreshAffiliateEarningsJobRetriesExhaustedWith(deps)(
              { args: c.args } as unknown as SidekiqItem,
              new Error("boom"),
              { runtime },
            )
          : refreshAffiliateEarningsJobWith(deps)(c.args, contextFor(runtime)),
      NOW_SECONDS,
    );
  } catch (e) {
    error = e as Error;
  }
  return { sql, ops, error, recording };
}

describe("RefreshAffiliateEarningsJob", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name))) {
    it(c.name, async () => {
      const { sql, ops, error, recording } = await run(c);

      // Rails wraps a database error as `Mysql2::Error: <message>`.
      if (c.error) expect(c.error.message).toContain(error?.message ?? "no error");
      else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(plain(ops)).toEqual(plain(c.cache_ops));
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, ops, error } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(ops).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { cache } = spiedCache();
    const sql = sqlReplay([]);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => NOW_SECONDS,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(
        () => refreshAffiliateEarningsJobWith({ now: () => NOW, cache: () => cache })([], contextFor(runtime)),
        NOW_SECONDS,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(sql.log).toEqual([]);
  });

  it("hands back a cached value that is not a time, before it writes", async () => {
    const { cache, ops, store } = spiedCache();
    await store.write(
      "affiliate/7/total_cents_earned",
      new Map<MarshalValue, MarshalValue>([
        [new RubySymbol("cents"), 1],
        [new RubySymbol("computed_at"), "yesterday"],
      ]),
    );
    const sql = sqlReplay(golden.cases.find((c) => c.name === "a value cached a minute ago")!.statements);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => NOW_SECONDS,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(
        () => refreshAffiliateEarningsJobWith({ now: () => NOW, cache: () => cache })([7], contextFor(runtime)),
        NOW_SECONDS,
      ),
    ).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(ops.map((op) => op[0])).toEqual(["read"]);
    expect(sql.log).toHaveLength(1);
  });
});
