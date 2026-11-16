// Replays create-licenses-for-existing-customers-worker.golden.json (scripts/golden/create-licenses-for-existing-customers-worker.rb):
// the job run by the real app as a Sidekiq job. Node sends the statements Rails sent, in its order and through the query cache a
// write clears, and fails with the same Ruby error where Rails raised. An id Rails casts (a float, a word) hands back before any
// statement.
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
import {
  createLicensesForExistingCustomersWorkerWith,
  licenseSerial,
} from "./create-licenses-for-existing-customers-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/create-licenses-for-existing-customers-worker.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };

const CAST_IDS = new Set(["a product id given as a float", "a product id given as a word"]);

async function run(c: Case, statements: Statement[]) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements);
  // The golden's SecureRandom.uuid is a counter from 1 per case.
  let uuids = 0;
  const handler = createLicensesForExistingCustomersWorkerWith({
    now: () => new Date(Math.round(golden.now * 1000)),
    uuid: () => `00000000-0000-4000-8000-${(uuids += 1).toString(16).padStart(12, "0")}`,
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("CreateLicensesForExistingCustomersWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name))) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(error?.name ?? null).toEqual(c.error ? c.error.class.split("::").pop() : null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { error, sql } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("groups a uuid's digits in eights, upcased", () => {
    expect(licenseSerial("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).toBe("0A1B2C3D-4E5F4A6B-8C7D9E0F-1A2B3C4D");
  });
});
