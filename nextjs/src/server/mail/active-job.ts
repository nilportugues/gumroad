// `SomeMailer.some_mail(...).deliver_later` as Rails 8.1 + Sidekiq 7.3's ActiveJob adapter push it:
// a MailDeliveryJob (config.action_mailer.delivery_job) wrapped in Sidekiq's JobWrapper.
// __fixtures__/mail.golden.json pins the payload.
import { randomUUID } from "node:crypto";

import { addToBullmq } from "../jobs/enqueue.ts";
import type { JobDefinition } from "../jobs/registry-types.ts";
import type { JobsRuntime } from "../jobs/runtime.ts";
import { rawPushToSidekiq } from "../jobs/sidekiq/client.ts";
import type { SidekiqItem } from "../jobs/sidekiq/item.ts";
import { type JsonValue, RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export const ACTIVE_JOB_WRAPPER = "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper";
export const MAIL_DELIVERY_JOB = "MailDeliveryJob";
// config/initializers/mailer.rb: deliver_later_queue_name = :default.
const DELIVER_LATER_QUEUE = "default";
// GlobalID.app, from the Rails application's module name.
const GLOBAL_ID_APP = "gumroad";

// ActiveJob::Arguments, for the argument shapes mailers take. A Ruby Hash's keys are symbols or
// strings, which JavaScript cannot tell apart, so hashes say which they are.
export type ActiveJobArgument =
  | null
  | boolean
  | number
  | string
  | ActiveJobArgument[]
  | { readonly globalId: { readonly model: string; readonly id: number | bigint } }
  | { readonly symbolKeys: Readonly<Record<string, ActiveJobArgument>> };

export const record = (model: string, id: number | bigint): ActiveJobArgument => ({ globalId: { model, id } });
export const symbolHash = (hash: Record<string, ActiveJobArgument>): ActiveJobArgument => ({ symbolKeys: hash });

export function serializeArgument(argument: ActiveJobArgument): JsonValue {
  if (argument === null || typeof argument !== "object") {
    if (typeof argument === "number" && !Number.isInteger(argument)) throw new Error("Float arguments are not ported");
    return argument;
  }
  if (Array.isArray(argument)) return argument.map(serializeArgument);
  if ("globalId" in argument) return { _aj_globalid: `gid://${GLOBAL_ID_APP}/${argument.globalId.model}/${argument.globalId.id}` };
  const hash = argument.symbolKeys;
  for (const key of Object.keys(hash)) if (key.startsWith("_aj_")) throw new Error(`reserved ActiveJob key ${key}`);
  return { ...Object.fromEntries(Object.entries(hash).map(([key, value]) => [key, serializeArgument(value)])), _aj_symbol_keys: Object.keys(hash) };
}

// Time#iso8601(9) in UTC for an epoch in float seconds; Ruby's Time carries the microseconds a
// Float can hold, so the last three digits are zero.
export function iso8601Nanos(epochSeconds: number): string {
  const micros = Math.round(epochSeconds * 1e6);
  const iso = new Date(Math.floor(micros / 1000)).toISOString();
  return `${iso.slice(0, 19)}.${String(((micros % 1e6) + 1e6) % 1e6).padStart(6, "0")}000Z`;
}

export type DeliverLaterInput = {
  mailer: string;
  method: string;
  args: ActiveJobArgument[];
  queue?: string;
  waitSeconds?: number;
};

export type MailJobIdentity = { jobId: string; jid: string; now: number };

// ActiveJob::Base#serialize for the delivery job, then the adapter's Sidekiq::Client.push hash.
export function buildMailDeliveryItem(input: DeliverLaterInput, identity: MailJobIdentity): SidekiqItem {
  const queue = input.queue ?? DELIVER_LATER_QUEUE;
  const at = input.waitSeconds !== undefined ? identity.now + input.waitSeconds : undefined;
  const job: Record<string, JsonValue> = {
    job_class: MAIL_DELIVERY_JOB,
    job_id: identity.jobId,
    provider_job_id: null,
    queue_name: queue,
    priority: null,
    arguments: [input.mailer, input.method, "deliver_now", { args: input.args.map(serializeArgument), _aj_ruby2_keywords: ["args"] }],
    executions: 0,
    exception_executions: {},
    locale: "en",
    timezone: "UTC",
    enqueued_at: iso8601Nanos(identity.now),
    scheduled_at: at === undefined ? null : iso8601Nanos(at),
  };
  return {
    retry: 25,
    queue,
    backtrace: true,
    wrapped: MAIL_DELIVERY_JOB,
    args: [job],
    ...(at === undefined ? {} : { at: new RubyFloat(at) }),
    class: ACTIVE_JOB_WRAPPER,
    jid: identity.jid,
    created_at: new RubyFloat(identity.now),
  };
}

// MailDeliveryJob's retry_on list, as ActiveJob keys exception_executions by `exceptions.to_s`.
export const MAIL_RETRY_ON: readonly string[] = ["Net::OpenTimeout", "Net::ReadTimeout", "Net::SMTPServerBusy", "EOFError"];
const MAIL_RETRY_KEY = `[${MAIL_RETRY_ON.join(", ")}]`;
const MAIL_RETRY_ATTEMPTS = 10;
// ActiveJob::Base.retry_jitter
const RETRY_JITTER = 0.15;

// retry_on's handler, run after the attempt that raised one of MAIL_RETRY_ON: the same job with
// the attempt counted, rescheduled with :polynomially_longer, or null once the attempts are spent
// and the error propagates to Sidekiq's own retry. `item` is the wrapper item that attempt ran.
export function retryMailDeliveryItem(item: SidekiqItem, identity: { jid: string; now: number; random?: () => number }): SidekiqItem | null {
  const job = (item.args as Record<string, JsonValue>[])[0]!;
  const previous = (job.exception_executions ?? {}) as Record<string, JsonValue>;
  const count = Number(previous[MAIL_RETRY_KEY] ?? 0) + 1;
  if (count >= MAIL_RETRY_ATTEMPTS) return null;
  const base = count ** 4;
  const at = identity.now + base + (identity.random ?? Math.random)() * base * RETRY_JITTER + 2;
  const retried: Record<string, JsonValue> = {
    ...job,
    // JobWrapper#perform merges the Sidekiq jid in before ActiveJob deserializes the job.
    provider_job_id: String(item.jid),
    // perform_now counts the attempt before running it.
    executions: Number(job.executions ?? 0) + 1,
    exception_executions: { ...previous, [MAIL_RETRY_KEY]: count },
    enqueued_at: iso8601Nanos(identity.now),
    scheduled_at: iso8601Nanos(at),
  };
  return {
    retry: 25,
    queue: String(job.queue_name),
    backtrace: true,
    wrapped: MAIL_DELIVERY_JOB,
    args: [retried],
    at: new RubyFloat(at),
    class: ACTIVE_JOB_WRAPPER,
    jid: identity.jid,
    created_at: new RubyFloat(identity.now),
  };
}

// The registry entry BullMQ options are built from: JobWrapper declares no sidekiq_options, so
// only config/initializers/sidekiq.rb's defaults (already on the item) apply.
export const ACTIVE_JOB_WRAPPER_DEFINITION: JobDefinition = {
  file: "sidekiq/lib/active_job/queue_adapters/sidekiq_adapter.rb",
  sidekiqJob: true,
  options: {},
  customLockArgs: false,
  customRetryIn: false,
  retriesExhausted: false,
  runtime: "node",
};

export type MailJobRoute = "node" | "ruby";

// Where a mail delivery job goes: BullMQ when the Node worker delivers that mailer method,
// otherwise Sidekiq, where Rails delivers it exactly as for a Ruby `deliver_later`.
export async function pushMailDeliveryItem(runtime: JobsRuntime, item: SidekiqItem, route: MailJobRoute): Promise<void> {
  if (route === "node") return addToBullmq(runtime, ACTIVE_JOB_WRAPPER_DEFINITION, item);
  return rawPushToSidekiq(runtime.sidekiqRedis, item, runtime.now());
}

// Returns the ActiveJob job_id. `route` comes from delivery.ts's mailRoute.
export async function deliverLater(runtime: JobsRuntime, input: DeliverLaterInput, route: MailJobRoute = "ruby"): Promise<string> {
  const now = runtime.now();
  const item = buildMailDeliveryItem(input, { jobId: randomUUID(), jid: runtime.newJid(), now });
  await pushMailDeliveryItem(runtime, item, route);
  return String((item.args as Record<string, JsonValue>[])[0]!.job_id);
}
