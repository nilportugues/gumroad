// Replays update-purchase-email-to-match-account-worker.golden.json (scripts/golden/update-purchase-email-to-match-account-worker.rb):
// UpdatePurchaseEmailToMatchAccountWorker run by the real app as a Sidekiq job. Node sends the user read and the first find_each batch
// and finishes, or fails with RecordNotFound, exactly as Rails did when the user has no purchases; a user with a purchase is handed back
// right after that batch, before any write. An id Rails casts (nil, a float, a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { updatePurchaseEmailToMatchAccountWorkerWith } from "./update-purchase-email-to-match-account-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  at: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/update-purchase-email-to-match-account-worker.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { cases: Case[] };
const AT = 1_793_795_445.123;

const CAST_IDS = new Set(["a user id of nil", "a user id given as a float", "a user id given as a word"]);
const HANDED_BACK = (c: Case) => /with a purchase|and a purchase|with purchases/u.test(c.name);

async function run(args: JsonValue[], statements: Statement[]) {
  const sql = sqlReplay(statements);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => AT,
    newJid: sequentialJids(),
  });
  const handler = updatePurchaseEmailToMatchAccountWorkerWith({ now: () => new Date(Math.round(AT * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(args, contextFor(runtime)), AT);
  } catch (e) {
    error = e as Error;
  }
  return { sql, recording, error };
}

describe("UpdatePurchaseEmailToMatchAccountWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !HANDED_BACK(c))) {
    it(c.name, async () => {
      const { sql, recording, error } = await run(c.args, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter(HANDED_BACK)) {
    it(`hands ${c.name} back after the first batch`, async () => {
      const { sql, recording, error } = await run(c.args, c.statements.slice(0, 2));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, error } = await run(c.args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { error } = await run([], []);

    expect(error).not.toBeNull();
  });
});
