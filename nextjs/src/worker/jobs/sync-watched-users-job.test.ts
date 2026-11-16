// Replays sync-watched-users-job.golden.json (scripts/golden/sync-watched-users-job.rb): SyncWatchedUsersJob run by the real app as a
// Sidekiq job. Node sends the statements Rails sent (the alive watches, each user, the unpaid sum, the update), the same two
// Elasticsearch searches per watched user, and reports the same failures while the sweep goes on.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { syncWatchedUsersJobWith } from "./sync-watched-users-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
  errors: [string[], Record<string, string>][];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/sync-watched-users-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

async function run(c: Case) {
  const sql = sqlReplay(c.statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const notified: [string, string][] = [];
  const handler = syncWatchedUsersJobWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    {
      notify: (error, context) =>
        notified.push([(error as Error).message, `{watched_user_id: ${(context.context as { watched_user_id: bigint }).watched_user_id}}`]),
    },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, recording, notified };
}

describe("SyncWatchedUsersJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, es, error, recording, notified } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(notified).toEqual(c.errors.map(([messages, context]) => [messages[0], context.context]));
      expect(recording.snapshot()).toEqual({});
    });
  }
});
