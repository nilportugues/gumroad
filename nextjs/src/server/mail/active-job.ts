// `SomeMailer.some_mail(...).deliver_later` as Rails 8.1 + Sidekiq 7.3's ActiveJob adapter push it:
// a MailDeliveryJob (config.action_mailer.delivery_job) wrapped in Sidekiq's JobWrapper.
// __fixtures__/mail.golden.json pins the payload.
import { randomUUID } from "node:crypto";

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

// Pushes to Sidekiq, where Rails delivers it, exactly as `deliver_later` from Ruby would. Returns
// the ActiveJob job_id.
export async function deliverLater(runtime: JobsRuntime, input: DeliverLaterInput): Promise<string> {
  const now = runtime.now();
  const item = buildMailDeliveryItem(input, { jobId: randomUUID(), jid: runtime.newJid(), now });
  await rawPushToSidekiq(runtime.sidekiqRedis, item, now);
  return String((item.args as Record<string, JsonValue>[])[0]!.job_id);
}
