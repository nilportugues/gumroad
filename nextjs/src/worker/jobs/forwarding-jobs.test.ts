// Replays standalone-jobs.golden.json for the jobs that only forward to another job. The
// lock-taking cases need real Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/15 npm test.
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { UniqueJobConflictError } from "../../server/jobs/sidekiq/client.ts";
import { dumpRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { contextFor, golden, goldenRuntime, recordingSidekiqRedis, rubyRuntimeRegistry, snapshotRedis } from "./__fixtures__/golden.ts";
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { logSendgridEventWorker } from "./log-sendgrid-event-worker.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";

describe("LogSendgridEventWorker", () => {
  it.each(golden.log_sendgrid_event_worker.map((c) => [c] as const))("leaves Redis untouched", async (c) => {
    const { redis, snapshot } = recordingSidekiqRedis();
    await logSendgridEventWorker(c.args, contextFor(goldenRuntime(redis)));
    expect(snapshot()).toEqual(c.redis);
  });
});

describe("SyncStripeBusinessProfileUrlWorker", () => {
  it.each(golden.sync_stripe_business_profile_url_worker.map((c) => [dumpRubyJson(c.args), c] as const))(
    "pushes what Ruby pushes for %s",
    async (_label, c) => {
      const { redis, snapshot } = recordingSidekiqRedis();
      // SyncStripeBusinessProfileUrlJob now runs in Node; this checks the payload Ruby recorded.
      await syncStripeBusinessProfileUrlWorker(c.args, contextFor(goldenRuntime(redis, rubyRuntimeRegistry())));
      expect(snapshot()).toEqual(c.redis);
    },
  );

  it("rejects the arities Ruby rejects", async () => {
    const { redis } = recordingSidekiqRedis();
    await expect(syncStripeBusinessProfileUrlWorker([], contextFor(goldenRuntime(redis)))).rejects.toThrow(/wrong number of arguments/u);
    await expect(syncStripeBusinessProfileUrlWorker([1, "a", "b"], contextFor(goldenRuntime(redis)))).rejects.toThrow(/wrong number of arguments/u);
  });
});

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

describe.skipIf(!url)("EnqueueMarketingXReconnectEmailJob against Redis", () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(url!);
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it.each(golden.enqueue_marketing_x_reconnect_email_job.map((c) => [c.name!, c] as const))("%s", async (_name, c) => {
    const runtime = goldenRuntime(redis, rubyRuntimeRegistry());
    if (c.name === "delivery already locked") {
      await enqueueWith(runtime, "SendMarketingXReconnectEmailJob", c.args);
    }
    const run = enqueueMarketingXReconnectEmailJob(c.args, contextFor(runtime));
    if (c.error) await expect(run).rejects.toBeInstanceOf(UniqueJobConflictError);
    else await run;
    expect(await snapshotRedis(redis)).toEqual(c.redis);
  });
});
