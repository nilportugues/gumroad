// Builds the job hash that Sidekiq 7.3's client and the sidekiq-unique-jobs 8.0 client middleware
// would push for the same call from Ruby, key order included. Pure: the clock and jid are inputs.
// __fixtures__/sidekiq-wire.golden.json, produced by the real gems, pins every branch here.
import { createHash } from "node:crypto";

import { LOCK_ARGS } from "../lock-args.ts";
import type { JobDefinition, SidekiqOptionValue } from "../registry-types.ts";
import { dumpRubyJson, type JsonValue, RubyFloat } from "./ruby-json.ts";

export type SidekiqItem = Record<string, JsonValue>;

// config/initializers/sidekiq.rb merges these over Sidekiq's own {"retry" => true, "queue" => "default"}.
const DEFAULT_JOB_OPTIONS: SidekiqItem = { retry: 25, queue: "default", backtrace: true };

// SidekiqUniqueJobs.config defaults; config/initializers/sidekiq.rb only sets `enabled`.
export const UNIQUE_JOBS = { lockPrefix: "uniquejobs", lockTimeout: 0, lockTtl: null, maxHistory: 1000 } as const;

// Lock types whose client middleware takes a lock before the push. while_executing locks only
// on the server.
const CLIENT_LOCKING_TYPES = new Set(["until_executed", "until_executing", "until_and_while_executing", "until_expired"]);

export type BuildItemInput = {
  className: string;
  definition: JobDefinition;
  args: JsonValue[];
  // `FooJob.set(queue: ...)`.
  queue?: string;
  // Epoch seconds, as Sidekiq's `at`. Ignored unless in the future, as in Sidekiq.
  at?: number;
  // `FooJob.set(...)` options beyond queue, e.g. GenerateSslCertificate::RENEWAL_LOCK_OPTIONS.
  set?: Record<string, SidekiqOptionValue>;
  jid: string;
  now: number;
};

function toJson(value: SidekiqOptionValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
}

function jobOptions(definition: JobDefinition): SidekiqItem {
  return { ...DEFAULT_JOB_OPTIONS, ...(toJson(definition.options) as SidekiqItem) };
}

// Sidekiq::Client#normalize_item after Sidekiq::Job's perform_async/perform_in.
export function buildSidekiqItem(input: BuildItemInput): SidekiqItem {
  const { className, definition, args, jid, now } = input;
  const at = input.at !== undefined && input.at > now ? new RubyFloat(input.at) : undefined;
  const setOptions: SidekiqItem = { ...(toJson(input.set ?? {}) as SidekiqItem), ...(input.queue === undefined ? {} : { queue: input.queue }) };

  // perform_async goes through Setter (`opts.merge("args" =>, "class" =>)`); the class-level
  // perform_in builds `{"class" =>, "args" =>}` and adds "at". `.set(...)` always goes through Setter.
  const raw: SidekiqItem =
    Object.keys(setOptions).length || !at
      ? { ...setOptions, ...(at ? { at } : {}), args, class: className }
      : { class: className, args, at };

  const item: SidekiqItem = { ...jobOptions(definition), ...raw };
  if (item.queue === null || item.queue === "") throw new Error(`${className}: job must include a valid queue name`);
  item.jid ??= jid;
  item.queue = String(item.queue);
  item.created_at ??= new RubyFloat(now);

  if (typeof item.lock === "string" && item.lock !== "") prepareUniqueItem(item, definition, now);
  return item;
}

function lockArgsFor(item: SidekiqItem): JsonValue[] {
  const args = item.args as JsonValue[];
  const custom = LOCK_ARGS[String(item.class)];
  // The gem round-trips args through JSON before handing them to a lock_args method.
  return custom ? custom(JSON.parse(dumpRubyJson(args)) as JsonValue[]) : args;
}

// SidekiqUniqueJobs::LockDigest: MD5 of JSON.generate(hash.slice(...).sort).
export function lockDigest(item: { class: string; queue: string; lock_args: JsonValue[] }, uniqueAcrossQueues: boolean): string {
  const pairs: [string, JsonValue][] = [
    ["class", item.class],
    ["lock_args", item.lock_args],
  ];
  if (!uniqueAcrossQueues) pairs.push(["queue", item.queue]);
  return `${UNIQUE_JOBS.lockPrefix}:${createHash("md5").update(dumpRubyJson(pairs)).digest("hex")}`;
}

// SidekiqUniqueJobs::Job.prepare, then the WhileExecuting constructor's digest suffix.
function prepareUniqueItem(item: SidekiqItem, definition: JobDefinition, now: number): void {
  const options = jobOptions(definition);

  item.lock_timeout = "lock_timeout" in definition.options ? (options.lock_timeout ?? null) : UNIQUE_JOBS.lockTimeout;

  const ttl = (item.lock_ttl ?? options.lock_ttl ?? UNIQUE_JOBS.lockTtl) as number | null;
  const at = item.at instanceof RubyFloat ? item.at.value : undefined;
  const untilScheduled = at === undefined ? 0 : Math.trunc(at) - Math.trunc(now);
  item.lock_ttl = ttl === null ? null : Math.trunc(ttl) + untilScheduled;

  item.lock_prefix = UNIQUE_JOBS.lockPrefix;
  item.lock_args = lockArgsFor(item);
  const uniqueAcrossQueues = Boolean(item.unique_across_queues ?? options.unique_across_queues);
  const digest = lockDigest({ class: String(item.class), queue: String(item.queue), lock_args: item.lock_args }, uniqueAcrossQueues);
  item.lock_digest = item.lock === "while_executing" ? `${digest}:RUN` : digest;
}

export function takesClientLock(item: SidekiqItem): boolean {
  return typeof item.lock === "string" && CLIENT_LOCKING_TYPES.has(item.lock);
}
