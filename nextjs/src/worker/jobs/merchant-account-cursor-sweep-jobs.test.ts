// Replays closed-seller-connect-sweep-jobs.golden.json (scripts/golden/closed-seller-connect-sweep-jobs.rb): the two merchant account
// sweeps run by the real app as Sidekiq jobs. Node sends the candidate queries Rails sent and finishes a run with no candidate, with
// the cursor left where Rails left it. A run that reaches a candidate (the Stripe reads follow) is handed back right after the query
// that found it, with nothing written, so Rails starts it from the cursor it read.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

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
  alertOnStripeDobDriftJobWith,
  sweepClosedSellerConnectAccountsJobWith,
} from "./merchant-account-cursor-sweep-jobs.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/closed-seller-connect-sweep-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const handlers = {
  SweepClosedSellerConnectAccountsJob: sweepClosedSellerConnectAccountsJobWith,
  AlertOnStripeDobDriftJob: alertOnStripeDobDriftJobWith,
} as const;

const isCandidateQuery = (s: Statement) => s.sql.startsWith("SELECT `merchant_accounts`.* FROM");
const found = (s: Statement) => (s.result?.rows?.length ?? 0) > 0;
// The statements Node sends: the candidate queries up to the first that finds a row.
function nodeStatements(c: Case): Statement[] {
  const queries = c.statements.filter(isCandidateQuery);
  const first = queries.findIndex(found);
  return first === -1 ? queries : queries.slice(0, first + 1);
}

// The cursor key as a string redis, answering what the case started with.
function cursorRedis(c: Case) {
  const store = new Map<string, string>();
  for (const [key, entry] of Object.entries(c.redis_before ?? {})) store.set(key, String(entry.value));
  return {
    store,
    redis: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve("OK");
      },
    },
  };
}
const snapshotOf = (store: Map<string, string>): RedisSnapshot =>
  Object.fromEntries([...store].map(([key, value]) => [key, { type: "string", value, expires: false }]));

async function run(c: Case, args: JsonValue[] = c.args) {
  const sql = sqlReplay(nodeStatements(c));
  const cursor = cursorRedis(c);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = handlers[c.job as keyof typeof handlers]({ redis: () => cursor.redis });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, cursor, recording };
}

describe("merchant account cursor sweeps", () => {
  for (const c of golden.cases.filter((c) => c.error === null && !nodeStatements(c).some(found))) {
    it(c.name, async () => {
      const { error, sql, cursor, recording } = await run(c);

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(snapshotOf(cursor.store)).toEqual(c.redis);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => c.error === null && nodeStatements(c).some(found))) {
    it(`hands ${c.name} back before the cursor is written`, async () => {
      const { error, sql, cursor, recording } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(snapshotOf(cursor.store)).toEqual(c.redis_before ?? {});
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => c.error !== null)) {
    it(`${c.name}: rejects an argument, as perform takes none`, async () => {
      const { error, sql } = await run(c);

      expect(error?.message).toBe(c.error!.message);
      expect(sql.log).toEqual([]);
    });
  }
});
