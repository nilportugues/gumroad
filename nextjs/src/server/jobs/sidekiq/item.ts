// Builds the job hash that Sidekiq 7.3's client and the sidekiq-unique-jobs 8.0 client middleware
// would push for the same call from Ruby, key order included. Pure: the clock and jid are inputs.
// __fixtures__/sidekiq-wire.golden.json, produced by the real gems, pins every branch here.
import { createHash } from "node:crypto";

import { LOCK_ARGS } from "../lock-args.ts";
import type { JobDefinition, SidekiqOptionValue } from "../registry-types.ts";
import { dumpRubyJson, type JsonValue, RubyFloat, rubyFloatToS } from "./ruby-json.ts";

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
  // Called as `perform_in` / `perform_at`, which build the item without Setter even when the time
  // is not in the future and so leaves out "at".
  scheduled?: boolean;
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
    Object.keys(setOptions).length || (!at && !input.scheduled)
      ? { ...setOptions, ...(at ? { at } : {}), args, class: className }
      : { class: className, args, ...(at ? { at } : {}) };

  const item: SidekiqItem = { ...jobOptions(definition), ...raw };
  if (item.queue === null || item.queue === "") throw new Error(`${className}: job must include a valid queue name`);
  item.jid ??= jid;
  item.queue = String(item.queue);
  item.created_at ??= new RubyFloat(now);

  if (typeof item.lock === "string" && item.lock !== "") prepareUniqueItem(item, definition, now);
  return item;
}

export class SidekiqArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

// Sidekiq::JobUtil#normalize_item for a hash whose "class" is the job's Class (so its
// sidekiq_options are the defaults), as Sidekiq::Client#push and #push_bulk call it. Keys keep the
// order `defaults.merge(item)` gives them. `newJid` runs only when the item has no jid.
export function normalizeItem(definition: JobDefinition, item: SidekiqItem, newJid: () => string, now: number): SidekiqItem {
  if (!Object.hasOwn(item, "class") || !Object.hasOwn(item, "args")) throw new SidekiqArgumentError("Job must be a Hash with 'class' and 'args' keys");
  if (!Array.isArray(item.args)) throw new SidekiqArgumentError("Job args must be an Array");
  const normalized: SidekiqItem = { ...jobOptions(definition), ...item };
  if (normalized.queue === null || normalized.queue === undefined || normalized.queue === "") throw new SidekiqArgumentError("Job must include a valid queue name");
  if (normalized.jid === null || normalized.jid === undefined || normalized.jid === false) normalized.jid = newJid();
  normalized.class = String(normalized.class);
  normalized.queue = String(normalized.queue);
  if (normalized.retry_for !== null && normalized.retry_for !== undefined && normalized.retry_for !== false) normalized.retry_for = Math.trunc(Number(normalized.retry_for));
  if (normalized.created_at === null || normalized.created_at === undefined || normalized.created_at === false) normalized.created_at = new RubyFloat(now);
  return normalized;
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
export function prepareUniqueItem(item: SidekiqItem, definition: JobDefinition, now: number): void {
  prepareLockFields(item, definition, now);
  if (serverLockType(item, definition) === "while_executing") item.lock_digest = runtimeLockDigest(String(item.lock_digest));
}

// Lock::WhileExecuting::RUN_SUFFIX, which the runtime lock's constructor appends once.
export function runtimeLockDigest(digest: string): string {
  return digest.endsWith(":RUN") ? digest : `${digest}:RUN`;
}

// The lock class both middlewares pick: OptionsWithFallback#lock_type reads the class's
// sidekiq_options before the item, so a `.set(lock:)` only applies to classes without one.
export function serverLockType(item: SidekiqItem, definition: JobDefinition): string | undefined {
  const lock = definition.options.lock ?? item.lock;
  return typeof lock === "string" && lock !== "" ? lock : undefined;
}

// The item as SidekiqUniqueJobs::Middleware::Server sees it: Sidekiq's atomic_push drops `at`
// before a job reaches its queue, and Job.prepare runs again over the fetched payload. The
// runtime lock's `:RUN` suffix is left to the caller, as Lock::WhileExecuting.new adds it.
export function prepareServerItem(fetched: SidekiqItem, definition: JobDefinition): SidekiqItem {
  const { at: _at, ...item } = fetched;
  const lockType = serverLockType(item, definition);
  if (lockType === undefined) return item;
  item.lock ??= lockType;
  prepareLockFields(item, definition, 0);
  return item;
}

function prepareLockFields(item: SidekiqItem, definition: JobDefinition, now: number): void {
  const options = jobOptions(definition);

  item.lock_timeout = "lock_timeout" in definition.options ? (options.lock_timeout ?? null) : UNIQUE_JOBS.lockTimeout;

  const ttl = (item.lock_ttl ?? options.lock_ttl ?? UNIQUE_JOBS.lockTtl) as number | null;
  const at = scheduledAt(item);
  const untilScheduled = at === undefined ? 0 : Math.trunc(at) - Math.trunc(now);
  item.lock_ttl = ttl === null ? null : Math.trunc(ttl) + untilScheduled;

  item.lock_prefix = UNIQUE_JOBS.lockPrefix;
  item.lock_args = lockArgsFor(item);
  const uniqueAcrossQueues = Boolean(item.unique_across_queues ?? options.unique_across_queues);
  item.lock_digest = lockDigest({ class: String(item.class), queue: String(item.queue), lock_args: item.lock_args }, uniqueAcrossQueues);
}

// The item's `at`, which Sidekiq takes as any Numeric: perform_in writes a Float, push_bulk callers
// usually pass an Integer. undefined when the job is not scheduled.
export function scheduledAt(item: SidekiqItem): number | undefined {
  const at = item.at;
  if (at === undefined || at === null) return undefined;
  if (at instanceof RubyFloat) return at.value;
  if (typeof at === "number" || typeof at === "bigint") return Number(at);
  throw new TypeError(`${String(item.class)}: at must be Numeric`);
}

// `item["at"].to_s`: the schedule score and the lock score. A JS number with a fraction is a Float.
export function scheduledAtToS(at: JsonValue): string {
  if (at instanceof RubyFloat) return rubyFloatToS(at.value);
  if (typeof at === "bigint" || (typeof at === "number" && Number.isInteger(at))) return String(at);
  if (typeof at === "number") return rubyFloatToS(at);
  throw new TypeError("at must be Numeric");
}

export function takesClientLock(item: SidekiqItem): boolean {
  return typeof item.lock === "string" && CLIENT_LOCKING_TYPES.has(item.lock);
}
