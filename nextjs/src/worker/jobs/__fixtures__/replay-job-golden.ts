// Replays a job golden recorded with scripts/golden/support/rails_cases.rb against a Node handler: the statements Node sends equal
// the ones Rails sent, the Sidekiq pushes equal Rails', and the error message is Rails'. A case Rails runs to a marker exception
// (`hands_back: true`) is one Node hands back: it must send a prefix of Rails' statements and push nothing. `handsBackEarly` names
// the cases whose arguments Node does not reproduce: they hand back before any statement.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../../server/jobs/sidekiq/item.ts";
import { parseRubyJson, type JsonValue } from "../../../server/jobs/sidekiq/ruby-json.ts";
import type { RetriesExhausted } from "../../retry.ts";
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

export type JobCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  hands_back?: boolean;
};

// ActiveJob's job_id is a random UUID in production; the generators drew them in push order.
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

export function loadGolden(url: URL): { now: number; cases: JobCase[] } {
  return parseRubyJson(readFileSync(url, "utf8")) as unknown as { now: number; cases: JobCase[] };
}

export function replayJobGolden(
  title: string,
  golden: { now: number; cases: JobCase[] },
  handler: JobHandler,
  handsBackEarly: (c: JobCase) => boolean = () => false,
  options: { parseJsonOf?: string[] } = {},
): void {
  describe(title, () => {
    for (const c of golden.cases) {
      it(c.name, async () => {
        const sql = sqlReplay(c.statements, options);
        const recording = recordingSidekiqRedis();
        const jobs = createJobsRuntime({
          sidekiqRedis: recording.redis,
          bullmqRedis: recording.redis,
          registry: rubyRuntimeRegistry(),
          now: () => golden.now,
          newJid: sequentialJids(),
        });
        let error: unknown = null;
        try {
          await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
        } catch (e) {
          error = e;
        }

        if (handsBackEarly(c)) {
          expect((error as Error | null)?.name).toBe("HandBackToRuby");
          expect(sql.log).toEqual([]);
          expect(recording.snapshot()).toEqual({});
        } else if (c.hands_back) {
          expect((error as Error | null)?.name).toBe("HandBackToRuby");
          expect(sql.log.length).toBeGreaterThan(0);
          expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
          expect(recording.snapshot()).toEqual({});
        } else {
          expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
          expect(sql.log).toEqual(sql.expected);
          expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
        }
      });
    }
  });
}

// The same for a `sidekiq_retries_exhausted` block recorded with `hook: true`. A block that hands back (`hands_back`, or an id Node
// does not reproduce) throws HandBackToRuby, which the worker turns into a push to Ruby with `retry_count` one short of the maximum.
export function replayHookGolden(
  title: string,
  golden: { now: number; cases: JobCase[] },
  hook: RetriesExhausted,
  handsBackEarly: (c: JobCase) => boolean = () => false,
): void {
  describe(title, () => {
    for (const c of golden.cases) {
      it(c.name, async () => {
        const sql = sqlReplay(c.statements);
        const recording = recordingSidekiqRedis();
        const runtime = createJobsRuntime({
          sidekiqRedis: recording.redis,
          bullmqRedis: recording.redis,
          registry: rubyRuntimeRegistry(),
          now: () => golden.now,
          newJid: sequentialJids(),
        });
        let error: unknown = null;
        try {
          const msg = { args: c.args, jid: "hook-jid" } as unknown as SidekiqItem;
          await asSidekiqJob(() => hook(msg, new Error("boom"), { runtime }), golden.now);
        } catch (e) {
          error = e;
        }

        if (handsBackEarly(c)) {
          expect((error as Error | null)?.name).toBe("HandBackToRuby");
          expect(sql.log).toEqual([]);
        } else if (c.hands_back) {
          expect((error as Error | null)?.name).toBe("HandBackToRuby");
          expect(sql.log).toEqual(sql.expected);
        } else {
          expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
          expect(sql.log).toEqual(sql.expected);
        }
        expect(recording.snapshot()).toEqual({});
      });
    }
  });
}
