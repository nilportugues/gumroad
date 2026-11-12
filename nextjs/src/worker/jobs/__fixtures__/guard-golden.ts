// Replays the golden of a job Node runs up to the point where Rails would call something that stays ported to Ruby (see the
// `guards` goldens such as process-asset-preview-retina-worker.golden.json). Three kinds of case:
//   - run:    Rails stopped before that point; Node sends the same statements, pushes the same Sidekiq items and raises the same error.
//   - reach:  Rails reached the recorded call (`reached(case)` is true); Node hands the job back after the same statements.
//   - cast:   Rails casts an argument Node does not (`castBefore`); Node hands back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../../server/jobs/sidekiq/ruby-json.ts";
import type { JobDeps } from "../support/job-deps.ts";
import type { JobHandler } from "../types.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./golden.ts";
import { sqlReplay, type Statement } from "./sql-replay.ts";

export type GuardCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  [key: string]: unknown;
};

export function loadGuardGolden(file: string): { now: number; cases: GuardCase[] } {
  const golden = parseRubyJson(readFileSync(new URL(file, import.meta.url), "utf8")) as unknown as {
    now: number | RubyFloat;
    cases: GuardCase[];
  };
  // A whole-second `now` is parsed as a RubyFloat.
  return { now: golden.now instanceof RubyFloat ? golden.now.value : golden.now, cases: golden.cases };
}

export function describeGuardedJob(options: {
  title: string;
  file: string;
  make: (deps: Partial<JobDeps>) => JobHandler;
  reached: (c: GuardCase) => boolean;
  castBefore?: (c: GuardCase) => boolean;
  // Cases the caller replays itself (a unique-jobs lock needs a real Redis).
  skip?: (c: GuardCase) => boolean;
}): void {
  const golden = loadGuardGolden(options.file);
  golden.cases = golden.cases.filter((c) => !(options.skip?.(c) ?? false));
  const cast = options.castBefore ?? (() => false);

  async function run(c: GuardCase, statements: Statement[]) {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const sql = sqlReplay(statements);
    let lagChecks = 0;
    const handler = options.make({
      now: () => new Date(Math.round(golden.now * 1000)),
      watchReplicaLag: () => {
        lagChecks += 1;
        return Promise.resolve();
      },
    });
    let error: Error | null = null;
    try {
      await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
    } catch (e) {
      error = e as Error;
    }
    return { error, sql, recording, lagChecks: () => lagChecks };
  }

  describe(options.title, () => {
    for (const c of golden.cases.filter((c) => !cast(c) && !options.reached(c))) {
      it(c.name, async () => {
        const { error, sql, recording, lagChecks } = await run(c, c.statements);

        expect(sql.log).toEqual(sql.expected);
        expect(error?.message ?? null).toEqual(c.error?.message ?? null);
        expect(recording.snapshot()).toEqual(c.redis);
        if (typeof c.lag_checks === "number") expect(lagChecks()).toBe(c.lag_checks);
      });
    }

    for (const c of golden.cases.filter((c) => !cast(c) && options.reached(c))) {
      it(`hands ${c.name} back after reading it`, async () => {
        const { error, sql, recording, lagChecks } = await run(c, c.statements);

        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected);
        expect(recording.snapshot()).toEqual({});
        if (typeof c.lag_checks === "number") expect(lagChecks()).toBe(c.lag_checks);
      });
    }

    for (const c of golden.cases.filter(cast)) {
      it(`hands ${c.name} back before any statement`, async () => {
        const { error, sql } = await run(c, []);

        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
      });
    }
  });
}
