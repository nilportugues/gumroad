// Sidekiq::Client#push for a job still implemented in Ruby: unique-jobs client lock, then the
// same Redis writes as Sidekiq::Client#atomic_push. Sidekiq's Redis has no namespace here
// (config/initializers/sidekiq.rb), so the keys are the bare `queue:<name>`, `queues`, `schedule`.
import { createHash } from "node:crypto";

import type { Redis } from "ioredis";

import { type SidekiqItem, takesClientLock } from "./item.ts";
import { dumpRubyJson, type JsonValue, RubyFloat, rubyFloatToS } from "./ruby-json.ts";
import { acquireClientLock } from "./unique-lock.ts";

export class UniqueJobConflictError extends Error {}

// ActiveSupport's Object#to_json with escape_html_entities_in_json (the Rails default).
const HTML_UNSAFE = new RegExp("[<>&\\u2028\\u2029]", "g");
function activeSupportJson(value: JsonValue): string {
  return dumpRubyJson(value).replace(HTML_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

type Strategy = (redis: Redis, item: SidekiqItem) => Promise<void>;

// Client-side on_conflict strategies used by app/sidekiq. An unknown one throws instead of
// silently dropping the job.
const CLIENT_STRATEGIES: Record<string, Strategy> = {
  // OnConflict::NullStrategy
  none: async () => {},
  log: async (_redis, item) => {
    console.info(`Skipping job with id (${String(item.jid)}) because lock_digest: (${String(item.lock_digest)}) already exists`);
  },
  raise: async (_redis, item) => {
    throw new UniqueJobConflictError(`${String(item.class)} with digest ${String(item.lock_digest)} is already locked`);
  },
  // SendToElasticsearchWorker::MarkForTrailingRun
  mark_for_trailing_run: async (redis, item) => {
    const key = `send_to_elasticsearch_worker:trailing:${createHash("sha1").update(activeSupportJson(item.args as JsonValue[])).digest("hex")}`;
    await redis.call("SET", key, "1", "EX", 600);
  },
};

function clientStrategyName(item: SidekiqItem): string {
  const onConflict = item.on_conflict;
  if (onConflict && typeof onConflict === "object" && !Array.isArray(onConflict) && !(onConflict instanceof RubyFloat)) {
    return typeof (onConflict as Record<string, JsonValue>).client === "string" ? String((onConflict as Record<string, JsonValue>).client) : "none";
  }
  return typeof onConflict === "string" ? onConflict : "none";
}

// The unique-jobs client middleware: true when the job may be pushed. `redis` is the Sidekiq
// server, which holds the locks whichever runtime the job runs on.
export async function lockForPush(redis: Redis, item: SidekiqItem, now: number): Promise<boolean> {
  if (!takesClientLock(item) || (await acquireClientLock(redis, item, now))) return true;
  const name = clientStrategyName(item);
  const strategy = CLIENT_STRATEGIES[name];
  if (!strategy) throw new Error(`on_conflict strategy ${name} for ${String(item.class)} has no Node port`);
  await strategy(redis, item);
  return false;
}

export type PushCommand = { kind: "schedule"; score: string; payload: string } | { kind: "queue"; queue: string; payload: string };

// What Sidekiq::Client#atomic_push writes for one item: scheduled jobs go to the `schedule` zset
// scored by `at` (and lose `at`/`enqueued_at`), the rest get `enqueued_at` and go to their queue.
export function sidekiqPushCommand(item: SidekiqItem, now: number): PushCommand {
  if (item.at instanceof RubyFloat) {
    const { at, enqueued_at: _enqueuedAt, ...payload } = item;
    return { kind: "schedule", score: rubyFloatToS(at.value), payload: dumpRubyJson(payload) };
  }
  return { kind: "queue", queue: String(item.queue), payload: dumpRubyJson({ ...item, enqueued_at: new RubyFloat(now) }) };
}

// Pushes without taking a lock: for items whose lock is already held.
export async function rawPushToSidekiq(redis: Redis, item: SidekiqItem, now: number): Promise<void> {
  const command = sidekiqPushCommand(item, now);
  const pipeline = redis.pipeline();
  if (command.kind === "schedule") pipeline.zadd("schedule", command.score, command.payload);
  else pipeline.sadd("queues", command.queue).lpush(`queue:${command.queue}`, command.payload);
  const results = await pipeline.exec();
  const failed = results?.find(([error]) => error);
  if (failed) throw failed[0];
}

// Returns the jid, or null when a unique lock dropped the push, as perform_async does.
export async function pushToSidekiq(redis: Redis, item: SidekiqItem, now: number): Promise<string | null> {
  if (!(await lockForPush(redis, item, now))) return null;
  await rawPushToSidekiq(redis, item, now);
  return String(item.jid);
}
