import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LOCK_ARGS } from "../lock-args.ts";
import { JOB_REGISTRY } from "../registry.generated.ts";
import type { JobDefinition } from "../registry-types.ts";
import { sidekiqPushCommand } from "./client.ts";
import { buildSidekiqItem, lockDigest } from "./item.ts";
import { dumpRubyJson, type JsonValue, parseRubyJson, RubyFloat } from "./ruby-json.ts";

// Produced by __fixtures__/generate-sidekiq-golden.rb with sidekiq 7.3.4 and
// sidekiq-unique-jobs 8.0.10 pushing to a real Redis.
type Golden = {
  now: number;
  digests: { class: string; queue: string; args: JsonValue[]; lock_args: JsonValue[]; lock_digest: string }[];
  pushes: {
    name: string;
    class: string;
    args: JsonValue[];
    in?: number;
    queue?: string;
    set?: Record<string, string | number>;
    jids: (string | null)[];
    redis: Record<string, { type: string; value?: JsonValue }>;
  }[];
};
const golden = parseRubyJson(readFileSync(new URL("../__fixtures__/sidekiq-wire.golden.json", import.meta.url), "utf8")) as unknown as Golden;
const now = golden.now;

const definitionFor = (name: string): JobDefinition => {
  const base = { file: "", sidekiqJob: true, customLockArgs: false, customRetryIn: false, retriesExhausted: false, runtime: "ruby" } as const;
  // Stub classes in the golden script that have no counterpart in app/sidekiq.
  const stubs: Record<string, JobDefinition> = {
    RetryFalseJob: { ...base, options: { retry: false, queue: "low" } },
    UntilExecutedWithTtlJob: { ...base, options: { retry: 5, queue: "default", lock: "until_executed", lock_ttl: 900 } },
  };
  return stubs[name] ?? (JOB_REGISTRY as Record<string, JobDefinition>)[name]!;
};

describe("sidekiq-unique-jobs lock digests match Ruby", () => {
  it.each(golden.digests.map((vector) => [vector.class, vector.queue, dumpRubyJson(vector.args), vector] as const))(
    "%s on %s with %s",
    (className, queue, _label, vector) => {
      const lockArgs = LOCK_ARGS[className]?.(vector.args) ?? vector.args;
      expect(dumpRubyJson(lockArgs)).toBe(dumpRubyJson(vector.lock_args));
      const uniqueAcrossQueues = Boolean(definitionFor(className).options.unique_across_queues);
      expect(lockDigest({ class: className, queue, lock_args: lockArgs }, uniqueAcrossQueues)).toBe(vector.lock_digest);
    },
  );
});

describe("Sidekiq wire format matches Ruby", () => {
  it.each(golden.pushes.map((push) => [push.name, push] as const))("%s", (_name, push) => {
    const item = buildSidekiqItem({
      className: push.class,
      definition: definitionFor(push.class),
      args: push.args,
      jid: "000000000000000000000001",
      now,
      ...(push.in === undefined ? {} : { at: now + push.in }),
      ...(push.queue === undefined ? {} : { queue: push.queue }),
      ...(push.set === undefined ? {} : { set: push.set }),
    });
    const command = sidekiqPushCommand(item, now);
    if (command.kind === "schedule") {
      const [[payload, score]] = push.redis.schedule!.value as [string, RubyFloat | number][] as [[string, RubyFloat | number]];
      expect(command.payload).toBe(payload);
      expect(Number(command.score)).toBe(score instanceof RubyFloat ? score.value : score);
    } else {
      expect([command.payload]).toEqual(push.redis[`queue:${command.queue}`]!.value);
    }
  });
});

describe("dumpRubyJson", () => {
  it("writes timestamps as Ruby Floats", () => {
    expect(dumpRubyJson([new RubyFloat(1761955200), new RubyFloat(1761955200.5)])).toBe("[1761955200.0,1761955200.5]");
  });

  it("writes bigints exactly and refuses unsafe numbers", () => {
    expect(dumpRubyJson([12345678901234567n])).toBe("[12345678901234567]");
    expect(() => dumpRubyJson([2 ** 60])).toThrow(/bigint/u);
  });

  it("refuses floats Ruby would print in exponent form differently", () => {
    expect(() => dumpRubyJson([1e-7])).toThrow(/serialize/u);
  });

  it("round-trips Ruby's integral floats and big integers", () => {
    expect(dumpRubyJson(parseRubyJson("[1.0,12345678901234567,0.1]"))).toBe("[1.0,12345678901234567,0.1]");
  });
});

describe("lock_args ports", () => {
  it("applies Ruby truthiness in SendPurchaseReceiptJob", () => {
    expect(LOCK_ARGS.SendPurchaseReceiptJob!([1, 0])).toEqual([1, true]);
    expect(LOCK_ARGS.SendPurchaseReceiptJob!([1, null])).toEqual([1, false]);
    expect(LOCK_ARGS.SendPurchaseReceiptJob!([1])).toEqual([1, false]);
  });
});
