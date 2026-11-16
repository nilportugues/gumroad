// Sidekiq::Client.push_bulk (sidekiq 7.3.4) and Sidekiq::Job.perform_bulk, with the client
// middleware run per item as Sidekiq runs it: the sidekiq-unique-jobs lock, then, for a class the
// Node worker owns, the hand-off SidekiqNodeBridge makes (here: straight to BullMQ).
//
// Quirks kept from Sidekiq: normalize_item draws one jid that every item then replaces; a given
// "jid" is dropped; `at` is copied verbatim (an Integer stays an Integer) and puts every item on
// the schedule zset even when it is not in the future; each slice of `batch_size` is checked and
// pushed before the next, so a bad later slice raises after earlier ones were pushed.
import { addToBullmq, resolveJobClass } from "./enqueue.ts";
import type { JobsRuntime } from "./runtime.ts";
import { lockForPush, rawPushAllToSidekiq } from "./sidekiq/client.ts";
import { normalizeItem, prepareUniqueItem, SidekiqArgumentError, type SidekiqItem, takesClientLock } from "./sidekiq/item.ts";
import { type JsonValue, RubyFloat } from "./sidekiq/ruby-json.ts";
import { releaseLock } from "./sidekiq/unique-lock.ts";

const DEFAULT_BATCH_SIZE = 1000;

// The hash a Ruby caller passes, keys in the caller's order. "class" names the job class.
export type PushBulkItems = { class: string; args: JsonValue[][]; at?: JsonValue; jid?: JsonValue; batch_size?: number } & Record<string, JsonValue | undefined>;

const isNumeric = (value: unknown) => value instanceof RubyFloat || typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value));
const isTruthy = (value: unknown) => value !== undefined && value !== null && value !== false;

function eachSlice<T>(list: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let i = 0; i < list.length; i += size) slices.push(list.slice(i, i + size));
  return slices;
}

// Returns one jid per args entry, null where a client middleware stopped the push.
export async function pushBulkWith(runtime: JobsRuntime, input: PushBulkItems): Promise<(string | null)[]> {
  const items: Record<string, JsonValue | undefined> = { ...input };
  const batchSize = isTruthy(items.batch_size) ? Number(items.batch_size) : DEFAULT_BATCH_SIZE;
  delete items.batch_size;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new SidekiqArgumentError("invalid slice size");

  const args = items.args as JsonValue[][];
  const at = items.at;
  delete items.at;
  if (isTruthy(at)) {
    const list = Array.isArray(at) ? at : [at];
    if (list.length === 0 || !list.every(isNumeric)) throw new SidekiqArgumentError("Job 'at' must be a Numeric or an Array of Numeric timestamps");
    if (Array.isArray(at) && at.length !== args.length) throw new SidekiqArgumentError("Job 'at' Array must have same size as 'args' Array");
  }

  const jid = items.jid;
  delete items.jid;
  if (isTruthy(jid) && args.length > 1) throw new SidekiqArgumentError("Explicitly passing 'jid' when pushing more than one job is not supported");

  const { className, definition } = resolveJobClass(String(items.class), runtime.registry);
  const now = runtime.now();
  const normed = normalizeItem(definition, { ...(items as SidekiqItem), class: className }, runtime.newJid, now);

  const result: (string | null)[] = [];
  let sliceIndex = 0;
  for (const slice of eachSlice(args, batchSize)) {
    if (!slice.every(Array.isArray)) throw new SidekiqArgumentError("Bulk arguments must be an Array of Arrays: [[1], [2]]");

    const payloads: (SidekiqItem | null)[] = [];
    for (const [index, jobArgs] of slice.entries()) {
      const copy: SidekiqItem = { ...normed, args: jobArgs, jid: runtime.newJid() };
      if (isTruthy(at)) copy.at = Array.isArray(at) ? at[sliceIndex + index]! : at!;
      payloads.push(await runClientMiddleware(runtime, definition, copy, now));
    }
    sliceIndex += batchSize;

    if (definition.runtime === "ruby") await rawPushAllToSidekiq(runtime.sidekiqRedis, payloads.filter((p): p is SidekiqItem => p !== null), now);
    result.push(...payloads.map((payload) => (payload === null ? null : String(payload.jid))));
  }
  return result;
}

// The unique-jobs client middleware, then SidekiqNodeBridge's hand-off for Node-owned classes.
async function runClientMiddleware(runtime: JobsRuntime, definition: Parameters<typeof addToBullmq>[1], item: SidekiqItem, now: number): Promise<SidekiqItem | null> {
  if (typeof item.lock === "string" && item.lock !== "") prepareUniqueItem(item, definition, now);
  if (!(await lockForPush(runtime.sidekiqRedis, item, now))) return null;
  if (definition.runtime === "ruby") return item;
  try {
    await addToBullmq(runtime, definition, item);
  } catch (error) {
    if (takesClientLock(item)) await releaseLock(runtime.sidekiqRedis, item);
    throw error;
  }
  return item;
}

// `FooJob.perform_bulk(args, batch_size:)`, or `FooJob.set(opts).perform_bulk(...)` with `set`.
export function performBulkWith(
  runtime: JobsRuntime,
  jobClass: string,
  args: JsonValue[][],
  options: { batchSize?: number; set?: Record<string, JsonValue> } = {},
): Promise<(string | null)[]> {
  return pushBulkWith(runtime, { ...(options.set ?? {}), class: jobClass, args, batch_size: options.batchSize ?? DEFAULT_BATCH_SIZE });
}
