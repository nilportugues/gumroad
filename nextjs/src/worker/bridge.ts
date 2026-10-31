// Forwards jobs that Rails enqueued for Node. lib/sidekiq_node_bridge.rb runs as the last
// Sidekiq client middleware: after sidekiq-unique-jobs has taken the lock it LPUSHes the
// finished payload here instead of to `queue:<name>`. See src/server/jobs/README.md.
import type { Redis } from "ioredis";

import { addToBullmq, resolveJobClass } from "../server/jobs/enqueue.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import { rawPushToSidekiq } from "../server/jobs/sidekiq/client.ts";
import type { SidekiqItem } from "../server/jobs/sidekiq/item.ts";
import { parseRubyJson } from "../server/jobs/sidekiq/ruby-json.ts";

export const BRIDGE_INBOX = "nextjs:bridge:inbox";
export const BRIDGE_PROCESSING = "nextjs:bridge:processing";
const POLL_TIMEOUT_SECONDS = 5;

export async function forwardBridgedJob(runtime: JobsRuntime, raw: string): Promise<void> {
  const item = parseRubyJson(raw) as SidekiqItem;
  const { definition } = resolveJobClass(String(item.class), runtime.registry);
  if (definition.runtime === "node") return addToBullmq(runtime, definition, item);
  // Rails read a stale node-owned list (the job moved back to Ruby): its lock is already held,
  // so push it as Sidekiq::Client#atomic_push would.
  return rawPushToSidekiq(runtime.sidekiqRedis, item, runtime.now());
}

// Forwarding is idempotent (the BullMQ jobId is the jid), so anything a crashed consumer left in
// the processing list is replayed on start rather than lost.
export async function runBridge(runtime: JobsRuntime, blockingRedis: Redis, signal: AbortSignal): Promise<void> {
  for (const raw of await runtime.sidekiqRedis.lrange(BRIDGE_PROCESSING, 0, -1)) {
    await forwardBridgedJob(runtime, raw);
    await runtime.sidekiqRedis.lrem(BRIDGE_PROCESSING, 1, raw);
  }
  // Closing the connection is what ends a pending BLMOVE on stop; the timeout alone is not
  // relied on (some Redis builds never fire it).
  signal.addEventListener("abort", () => blockingRedis.disconnect(), { once: true });
  while (!signal.aborted) {
    let raw: string | null;
    try {
      raw = await blockingRedis.blmove(BRIDGE_INBOX, BRIDGE_PROCESSING, "RIGHT", "LEFT", POLL_TIMEOUT_SECONDS);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (raw === null) continue;
    try {
      await forwardBridgedJob(runtime, raw);
      await runtime.sidekiqRedis.lrem(BRIDGE_PROCESSING, 1, raw);
    } catch (error) {
      // Left in the processing list, so the next start replays it.
      console.error("Failed to forward a job from Rails", error);
    }
  }
}
