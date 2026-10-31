// Sidekiq 7.3.4's JobRetry (lib/sidekiq/job_retry.rb) for Node-run jobs: `sidekiq_retry_in`
// picks the delay before the next attempt and `sidekiq_retries_exhausted` runs once the last
// retry fails. The processor calls `handleFailure` on every failed run; BullMQ then schedules the
// retry with the delay this computed (see `retryDelayMs`), or fails the job for good.
import { UnrecoverableError } from "bullmq";

import type { JobDefinition } from "../server/jobs/registry-types.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import type { SidekiqItem } from "../server/jobs/sidekiq/item.ts";
import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";

// Sidekiq's default max_retries, used when `retry` is true rather than a count.
const SIDEKIQ_MAX_RETRIES = 25;

// `sidekiq_retry_in do |count, exception, msg|`: seconds, or a strategy. Anything else (nil, 0, a
// negative number, :default) keeps the default `count**4 + 15`.
export type RetryIn = (count: number, error: unknown, msg: SidekiqItem) => number | "discard" | "kill" | "default" | null | undefined;

// `sidekiq_retries_exhausted do |msg, exception|`. Returning "discard" keeps it out of the dead
// set in Sidekiq; BullMQ keeps failed jobs regardless, so that return value has no effect here.
export type RetriesExhausted = (msg: SidekiqItem, error: unknown, context: { runtime: JobsRuntime }) => Promise<unknown>;

export type RetryHooks = { retryIn: Record<string, RetryIn>; retriesExhausted: Record<string, RetriesExhausted> };

const RETRY_DELAY = Symbol("sidekiqRetryDelayMs");

// The delay handleFailure attached to the error, for the worker's backoff strategy.
export function retryDelayMs(error: unknown): number | undefined {
  return error && typeof error === "object" ? (error as { [RETRY_DELAY]?: number })[RETRY_DELAY] : undefined;
}

function rubyClassName(error: unknown): string {
  if (error && typeof error === "object") {
    const rubyClass = (error as { rubyClass?: unknown }).rubyClass;
    if (typeof rubyClass === "string") return rubyClass;
    return error.constructor?.name ?? "Error";
  }
  return "RuntimeError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `retry_attempts_from`: an Integer `retry` is the count, anything else truthy the default.
function maxRetryAttempts(retry: unknown): number {
  return typeof retry === "number" && Number.isInteger(retry) ? retry : SIDEKIQ_MAX_RETRIES;
}

// `rv.to_i if rv.respond_to?(:to_i)`, then `Integer === rv && rv > 0`.
function retryInSeconds(value: ReturnType<RetryIn>): number | "discard" | "kill" | undefined {
  if (value === "discard" || value === "kill") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = Math.trunc(value);
    return seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

export type FailureContext = {
  item: SidekiqItem;
  definition: JobDefinition;
  // Failed runs before this one: Sidekiq's `retry_count` after it is bumped for this failure.
  attemptsMade: number;
  runtime: JobsRuntime;
  hooks: RetryHooks;
  random?: () => number;
};

// JobRetry#local + #process_retry. Returns the error to rethrow: the original one carrying the
// retry delay, or an UnrecoverableError when the job must not run again.
export async function handleFailure(error: unknown, context: FailureContext): Promise<unknown> {
  const { item, definition, attemptsMade, runtime, hooks } = context;
  const name = String(item.class);
  const retry = item.retry ?? definition.options.retry ?? true;
  // `raise e unless msg["retry"]`: no retry, no exhausted hook.
  if (retry === false || retry === null) return error;

  const count = attemptsMade;
  const now = new RubyFloat(runtime.now());
  const msg: SidekiqItem = {
    ...item,
    queue: item.retry_queue ?? item.queue,
    error_message: errorMessage(error),
    error_class: rubyClassName(error),
    ...(count === 0 ? { failed_at: now } : { retried_at: now }),
    retry_count: count,
  } as SidekiqItem;

  const exhaust = async () => {
    const hook = hooks.retriesExhausted[name];
    if (!hook) return;
    try {
      await hook(msg, error, { runtime });
    } catch (hookError) {
      console.error(`Error calling retries_exhausted for ${name} ${String(item.jid)}:`, hookError);
    }
  };

  if (count >= maxRetryAttempts(retry)) {
    await exhaust();
    return error;
  }

  let strategy: number | "discard" | "kill" | undefined;
  try {
    strategy = retryInSeconds(hooks.retryIn[name]?.(count, error, msg));
  } catch (hookError) {
    console.error(`Failure scheduling retry using the defined \`sidekiq_retry_in\` in ${name}, falling back to default:`, hookError);
    strategy = undefined;
  }
  if (strategy === "discard") return new UnrecoverableError(`${name} ${String(item.jid)} discarded by sidekiq_retry_in: ${errorMessage(error)}`);
  if (strategy === "kill") {
    await exhaust();
    return new UnrecoverableError(`${name} ${String(item.jid)} killed by sidekiq_retry_in: ${errorMessage(error)}`);
  }

  const delay = strategy ?? count ** 4 + 15;
  const jitter = Math.floor((context.random ?? Math.random)() * 10) * (count + 1);
  const carrier = error && typeof error === "object" ? error : new Error(errorMessage(error));
  (carrier as { [RETRY_DELAY]?: number })[RETRY_DELAY] = (delay + jitter) * 1000;
  return carrier;
}
