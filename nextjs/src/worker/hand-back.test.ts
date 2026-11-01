import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { BridgedJobData } from "../server/jobs/enqueue.ts";
import { beforeSideEffects, HandBackToRuby } from "../server/jobs/hand-back.ts";
import type { JobDefinition } from "../server/jobs/registry-types.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import { dumpRubyJson, parseRubyJson } from "../server/jobs/sidekiq/ruby-json.ts";
import { NotPortedError } from "../server/models/user.ts";
import { createProcessor } from "./processor.ts";

const definition = { file: "app/sidekiq/some_job.rb", sidekiqJob: true, options: {}, runtime: "node" } as unknown as JobDefinition;

function fakeRuntime() {
  const commands: [string, ...unknown[]][] = [];
  const pipeline = {
    sadd: (...args: unknown[]) => (commands.push(["sadd", ...args]), pipeline),
    lpush: (...args: unknown[]) => (commands.push(["lpush", ...args]), pipeline),
    zadd: (...args: unknown[]) => (commands.push(["zadd", ...args]), pipeline),
    exec: async () => [],
  };
  const runtime = { now: () => 1_761_955_200.5, registry: { SomeJob: definition }, sidekiqRedis: { pipeline: () => pipeline } } as unknown as JobsRuntime;
  return { runtime, commands };
}

const job = (item: Record<string, unknown>) => ({ data: { sidekiq: dumpRubyJson(item as never) }, attemptsMade: 0 }) as unknown as Job<BridgedJobData>;

describe("handing a job back to Rails", () => {
  it("pushes the original item onto its Sidekiq queue instead of failing", async () => {
    const { runtime, commands } = fakeRuntime();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const process = createProcessor(runtime, { SomeJob: async () => { throw new HandBackToRuby("payout action"); } });

    await expect(process(job({ class: "SomeJob", jid: "abc", queue: "low", args: [1], retry: 5, at: 1_761_955_100 }))).resolves.toBeUndefined();

    expect(commands[0]).toEqual(["sadd", "queues", "low"]);
    const pushed = parseRubyJson(String(commands[1]![2])) as Record<string, unknown>;
    expect(commands[1]![1]).toBe("queue:low");
    expect(pushed).toMatchObject({ class: "SomeJob", jid: "abc", queue: "low", args: [1], retry: 5 });
    expect(pushed).not.toHaveProperty("at");
    info.mockRestore();
  });

  it("lets every other error go through Sidekiq's retry", async () => {
    const { runtime, commands } = fakeRuntime();
    const process = createProcessor(runtime, { SomeJob: async () => { throw new Error("boom"); } });
    await expect(process(job({ class: "SomeJob", jid: "abc", queue: "low", args: [], retry: 5 }))).rejects.toThrow("boom");
    expect(commands).toEqual([]);
  });

  it("turns only NotPortedError raised before side effects into a hand-back", async () => {
    await expect(beforeSideEffects(() => { throw new NotPortedError("X", "x.rb:1"); })).rejects.toBeInstanceOf(HandBackToRuby);
    await expect(beforeSideEffects(() => { throw new TypeError("bad"); })).rejects.toBeInstanceOf(TypeError);
    await expect(beforeSideEffects(() => 7)).resolves.toBe(7);
  });
});
