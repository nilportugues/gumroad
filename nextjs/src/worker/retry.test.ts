// Sidekiq 7.3.4 JobRetry semantics (process_retry, delay_for, retries_exhausted) on the Node worker.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { ExhaustedHandBack, HandBackToRuby } from "../server/jobs/hand-back.ts";
import type { JobDefinition } from "../server/jobs/registry-types.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import type { SidekiqItem } from "../server/jobs/sidekiq/item.ts";
import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import { handleFailure, type RetriesExhausted, type RetryHooks, type RetryIn, retryDelayMs } from "./retry.ts";

const runtime = { now: () => 1_761_955_200.5 } as JobsRuntime;
const definition = { options: { retry: 3 } } as unknown as JobDefinition;
const item: SidekiqItem = { class: "SomeJob", jid: "abc", queue: "default", args: [7], retry: 3 };

function hooks(retryIn?: RetryIn, exhausted?: RetriesExhausted): RetryHooks {
  return { retryIn: retryIn ? { SomeJob: retryIn } : {}, retriesExhausted: exhausted ? { SomeJob: exhausted } : {} };
}

const fail = (attemptsMade: number, h: RetryHooks, overrides: Partial<{ item: SidekiqItem; random: () => number }> = {}) =>
  handleFailure(new Error("boom"), { item: overrides.item ?? item, definition, attemptsMade, runtime, hooks: h, random: overrides.random ?? (() => 0.35) });

describe("handleFailure", () => {
  it("uses count**4 + 15 + rand(10) * (count + 1) without a sidekiq_retry_in block", async () => {
    expect(retryDelayMs(await fail(0, hooks()))).toBe((0 + 15 + 3 * 1) * 1000);
    expect(retryDelayMs(await fail(2, hooks()))).toBe((16 + 15 + 3 * 3) * 1000);
  });

  it("takes a positive Integer from sidekiq_retry_in and still adds the jitter", async () => {
    const retryIn = vi.fn<RetryIn>(() => 600);
    expect(retryDelayMs(await fail(1, hooks(retryIn)))).toBe((600 + 3 * 2) * 1000);
    expect(retryIn).toHaveBeenCalledWith(1, expect.any(Error), expect.objectContaining({ retry_count: 1, error_message: "boom", error_class: "Error" }));
  });

  it("falls back to the default for nil, zero, negative and a raising block", async () => {
    for (const value of [null, undefined, 0, -5, "default"] as const) {
      expect(retryDelayMs(await fail(1, hooks(() => value)))).toBe((1 + 15 + 3 * 2) * 1000);
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(retryDelayMs(await fail(1, hooks(() => { throw new Error("bad block"); })))).toBe((1 + 15 + 3 * 2) * 1000);
    spy.mockRestore();
  });

  it("runs the exhausted hook once the retry count reaches `retry`, with Sidekiq's msg", async () => {
    const exhausted = vi.fn<RetriesExhausted>(async () => {});
    const retryIn = vi.fn<RetryIn>(() => 10);
    for (const attempts of [0, 1, 2]) await fail(attempts, hooks(retryIn, exhausted));
    expect(exhausted).not.toHaveBeenCalled();
    const error = await fail(3, hooks(retryIn, exhausted));
    expect(retryIn).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted.mock.calls[0]![0]).toEqual({
      ...item,
      error_message: "boom",
      error_class: "Error",
      retried_at: new RubyFloat(1_761_955_200.5),
      retry_count: 3,
    });
    expect(error).toBeInstanceOf(Error);
    expect(retryDelayMs(error)).toBeUndefined();
  });

  it("returns an ExhaustedHandBack when the hook hands back, with retry_count one below the maximum", async () => {
    const exhausted = vi.fn<RetriesExhausted>(async () => { throw new HandBackToRuby("money"); });
    const outcome = await fail(3, hooks(undefined, exhausted));
    expect(outcome).toBeInstanceOf(ExhaustedHandBack);
    expect((outcome as ExhaustedHandBack).item).toMatchObject({ jid: "abc", retry_count: 2, error_message: "boom", retried_at: new RubyFloat(1_761_955_200.5) });
    const killed = await fail(1, hooks(() => "kill", exhausted));
    expect(killed).toBeInstanceOf(ExhaustedHandBack);
    const once = await fail(0, hooks(undefined, exhausted), { item: { ...item, retry: 0 } });
    expect((once as ExhaustedHandBack).item).toMatchObject({ retry_count: 0 });
  });

  it("runs the exhausted hook on the only run of retry: 0, and never for retry: false", async () => {
    const exhausted = vi.fn<RetriesExhausted>(async () => {});
    await fail(0, hooks(undefined, exhausted), { item: { ...item, retry: 0 } });
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted.mock.calls[0]![0]).toMatchObject({ failed_at: new RubyFloat(1_761_955_200.5), retry_count: 0 });
    await fail(0, hooks(undefined, exhausted), { item: { ...item, retry: false } });
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("rescues an exhausted hook that raises", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await fail(3, hooks(undefined, async () => { throw new Error("hook failed"); }));
    expect((error as Error).message).toBe("boom");
    spy.mockRestore();
  });

  it("stops retrying on :discard and runs the exhausted hook on :kill", async () => {
    const exhausted = vi.fn<RetriesExhausted>(async () => {});
    expect(await fail(0, hooks(() => "discard", exhausted))).toBeInstanceOf(UnrecoverableError);
    expect(exhausted).not.toHaveBeenCalled();
    expect(await fail(0, hooks(() => "kill", exhausted))).toBeInstanceOf(UnrecoverableError);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("uses the Ruby class name of errors that carry one", async () => {
    const retryIn = vi.fn<RetryIn>(() => null);
    const error = Object.assign(new Error("nope"), { rubyClass: "Stripe::APIError" });
    await handleFailure(error, { item, definition, attemptsMade: 0, runtime, hooks: hooks(retryIn) });
    expect(retryIn.mock.calls[0]![2]).toMatchObject({ error_class: "Stripe::APIError", error_message: "nope" });
  });
});
