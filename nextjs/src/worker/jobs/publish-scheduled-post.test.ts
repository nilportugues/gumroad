// Replays publish-scheduled-post.golden.json (scripts/golden/publish-scheduled-post.rb): PublishScheduledPostJob and the
// Installment#publish! it calls, run by the real app as a Sidekiq job. Node must send the statements Rails sent, given the same
// answers, push the same Sidekiq payloads and fail with the same errors. A case Node hands back to Rails stops before the
// publish writes anything.
//
// The Redis cases need JOBS_REDIS_URL (a scratch database other than 0) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, rubyRuntimeRegistry, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import type { Installment } from "@prisma/client";

import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { Installments, markDeletedBang, unpublishBang } from "../../server/models/installment-writes.ts";
import { findByIdBang } from "../../server/models/row-reads.ts";
import { publishScheduledPostJobWith } from "./publish-scheduled-post-job.ts";

type Case = { name: string; kind?: string; params?: Record<string, unknown>; args: JsonValue[]; case_now: unknown; error: { class: string; message: string } | null; statements: Statement[]; redis: RedisSnapshot };
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/publish-scheduled-post.golden.json", import.meta.url), "utf8")) as unknown as { cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

// What installment-writes.ts leaves to Rails: a post that emails its audience, a file, a call to action, a missing slug.
const HANDED_BACK = new Set(["a post that emails its audience", "a post that only emails a single recipient", "a post with a file", "a post with a call to action", "a post without a slug", "unpublish!: a post that emails its audience"]);

const withoutJobIds = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof RubyFloat ? v.value : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");
const secondsOf = (value: unknown) => (typeof value === "number" ? value : (value as RubyFloat).value);

describe("PublishScheduledPostJob", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      await redis!.flushdb();
      const nowSeconds = secondsOf(c.case_now);
      const now = () => new Date(Math.round(nowSeconds * 1000));
      const sql = sqlReplay(c.statements);
      const runtime = createJobsRuntime({ sidekiqRedis: redis!, bullmqRedis: redis!, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() });
      let error: unknown = null;
      try {
        if (c.kind === undefined) {
          await asSidekiqJob(() => publishScheduledPostJobWith({ now })(c.args, contextFor(runtime)), nowSeconds);
        } else {
          await asSidekiqJob(
            () =>
              withJobsRuntime(runtime, async () => {
                const record = Installments.load(await findByIdBang<Installment>("Installment", 10n));
                if (c.kind === "unpublish!") await unpublishBang(record, { isUnpublishedByAdmin: c.params?.is_unpublished_by_admin === true, now });
                else await markDeletedBang(record, { now });
              }),
            nowSeconds,
          );
        }
      } catch (e) {
        error = e;
      }

      if (HANDED_BACK.has(c.name)) {
        // a job hands back to Rails; the model refuses with NotPortedError
        expect((error as Error | null)?.name).toBe(c.kind === undefined ? "HandBackToRuby" : "NotPortedError");
        const performed = sql.log.filter((statement, index) => !(statement === "ROLLBACK" && index === sql.log.length - 1));
        expect(performed).toEqual(sql.expected.slice(0, performed.length));
        expect(performed.some((statement) => /^(UPDATE|INSERT)/u.test(statement))).toBe(false);
        expect(await snapshotRedis(redis!)).toEqual({});
        return;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(JSON.parse(withoutJobIds(await snapshotRedis(redis!)))).toEqual(JSON.parse(withoutJobIds(c.redis)));
    });
  }
});
