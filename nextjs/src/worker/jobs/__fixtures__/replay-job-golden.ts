// Replays a job golden recorded with scripts/golden/support/rails_cases.rb against a Node handler: the statements Node sends equal
// the ones Rails sent, the Sidekiq pushes equal Rails', and the error message is Rails'. A case Rails runs to a marker exception
// (`hands_back: true`) is one Node hands back: it must send a prefix of Rails' statements and push nothing. `handsBackEarly` names
// the cases whose arguments Node does not reproduce: they hand back before any statement.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../../server/jobs/sidekiq/ruby-json.ts";
import type { JobHandler } from "../types.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./golden.ts";
import { ratelimitSnapshot, resetRatelimitRedis } from "./ratelimit-redis.ts";
import { sqlReplay, type Statement } from "./sql-replay.ts";

export type JobCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  hands_back?: boolean;
  // With capture_http!: each request Rails sent (`wire_path` is the request line, `url` WebMock's normalized form) and each answer it got.
  http?: { method: string; url: string; wire_path: string; headers: Record<string, string>; body: string | null }[];
  http_responses?: { status?: number; body?: string; headers?: Record<string, string> }[];
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
  options: {
    parseJsonOf?: string[];
    // Cases Rails serves that Node hands back after the same reads and before any vendor call.
    handsBack?: (c: JobCase) => boolean;
    // The vendor's origin: the requests Node sends are compared with Rails' (request line, authorization, order), the rate-limit writes with its Redis.
    vendor?: string;
  } = {},
): void {
  describe(title, () => {
    beforeEach(() => {
      resetRatelimitRedis();
      // The rate limit buckets Date.now() into five seconds.
      if (options.vendor !== undefined) vi.useFakeTimers({ now: Math.round(golden.now * 1000), toFake: ["Date"] });
    });
    afterEach(() => {
      if (options.vendor !== undefined) vi.useRealTimers();
      vi.unstubAllGlobals();
    });

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
        const sent: { method: string; url: string; headers: Record<string, string> }[] = [];
        const answers = [...(c.http_responses ?? [])];
        if (options.vendor !== undefined)
          vi.stubGlobal("fetch", (url: string | URL, init: RequestInit = {}) => {
            sent.push({
              method: init.method ?? "GET",
              url: String(url),
              headers: Object.fromEntries(new Headers(init.headers)),
            });
            const answer = answers.shift() ?? {};
            return Promise.resolve(
              new Response(answer.body ?? "{}", { status: answer.status ?? 200, headers: answer.headers }),
            );
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
          expect(sent).toEqual([]);
        } else if (c.hands_back || options.handsBack?.(c)) {
          expect(sent).toEqual([]);
          expect(ratelimitSnapshot()).toEqual({});
          expect((error as Error | null)?.name).toBe("HandBackToRuby");
          expect(sql.log.length).toBeGreaterThan(0);
          expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
          expect(recording.snapshot()).toEqual({});
        } else {
          expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
          expect(sql.log).toEqual(sql.expected);
          expect(withoutJobIds({ ...recording.snapshot(), ...ratelimitSnapshot() })).toEqual(withoutJobIds(c.redis));
          expect(sent.map((r) => [r.method, r.url, r.headers.authorization])).toEqual(
            (c.http ?? []).map((r) => [r.method, `${options.vendor ?? ""}${r.wire_path}`, r.headers.Authorization]),
          );
        }
      });
    }
  });
}
