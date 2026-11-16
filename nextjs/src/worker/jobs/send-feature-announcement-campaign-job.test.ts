// Replays send-feature-announcement-campaign-job.golden.json (scripts/golden/send-feature-announcement-campaign-job.rb):
// SendFeatureAnnouncementCampaignJob run by the real app as a Sidekiq job. Node sends the statements Rails sent (the campaign, the
// subscription batch after the cursor, the subscribers' emails, the state update), pushes the same MailDeliveryJob per subscriber and
// schedules the same next batch under the same unique-jobs lock. That lock is Lua, so this runs against a real Redis like
// update-sales-related-products-infos-job.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/33 npm test. It is flushed between cases.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { sendFeatureAnnouncementCampaignJobWith } from "./send-feature-announcement-campaign-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  batch_size?: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/send-feature-announcement-campaign-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

// ActiveJob's job_id is a random UUID in production; the generator numbered them in push order.
const withoutJobIds = (snapshot: unknown) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

async function run(args: JsonValue[], statements: Statement[], batchSize?: number) {
  await redis.flushdb();
  const sql = sqlReplay(statements);
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = sendFeatureAnnouncementCampaignJobWith(batchSize === undefined ? {} : { batchSize })({
    now: () => new Date(Math.round(golden.now * 1000)),
  });
  const error = await asSidekiqJob(() => handler(args, contextFor(runtime)), golden.now).then(
    () => null,
    (e: unknown) => e as Error,
  );
  return { sql, error };
}

describe.skipIf(!url)("SendFeatureAnnouncementCampaignJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, error } = await run(c.args, c.statements, c.batch_size);

      expect(error?.message).toEqual(c.error?.message);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(plain(await snapshotRedis(redis)))).toEqual(withoutJobIds(plain(c.redis)));
    });
  }

  for (const [name, args] of [
    ["a float campaign id", [1.5]],
    ["a null campaign id", [null]],
    ["a word for a cursor", [1, "abc"]],
    ["a float cursor", [1, 1.5]],
    ["a null cursor", [1, null]],
  ] as [string, JsonValue[]][]) {
    it(`hands ${name} back before any statement`, async () => {
      const { sql, error } = await run(args, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(await snapshotRedis(redis)).toEqual({});
    });
  }
});
