import { describe, expect, it } from "vitest";

import { contextFor, golden, goldenRuntime, recordingSidekiqRedis } from "./__fixtures__/golden.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";

describe("HandleSnsAwsConfigEventWorker matches the Ruby job", () => {
  it.each(golden.handle_sns_aws_config_event_worker.map((c) => [c.name!, c] as const))("%s", async (_name, c) => {
    const { redis, snapshot } = recordingSidekiqRedis();
    const run = handleSnsAwsConfigEventWorker(c.args, contextFor(goldenRuntime(redis)));
    if (c.error?.class === "ArgumentError") await expect(run).rejects.toThrow(c.error.message);
    else if (c.error) await expect(run).rejects.toThrow();
    else await run;
    expect(snapshot()).toEqual(c.redis);
  });
});
