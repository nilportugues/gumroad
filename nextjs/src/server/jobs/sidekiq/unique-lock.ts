// SidekiqUniqueJobs::Locksmith#lock and #unlock over the gem's own Lua (rendered verbatim into
// unique-jobs-lua.generated.ts), so Ruby and Node contend for the same digest keys with the same
// atomic steps: queue.lua, LMOVE queued→primed, lock.lua.
import { createHash } from "node:crypto";

import type { Redis } from "ioredis";

import { rubyFloatToS } from "./ruby-json.ts";
import { scheduledAtToS, type SidekiqItem, UNIQUE_JOBS } from "./item.ts";
import { LOCK_LUA, QUEUE_LUA, UNLOCK_LUA } from "./unique-jobs-lua.generated.ts";

const SCRIPTS = { queue: QUEUE_LUA, lock: LOCK_LUA, unlock: UNLOCK_LUA } as const;
type ScriptName = keyof typeof SCRIPTS;
const SHAS = Object.fromEntries(Object.entries(SCRIPTS).map(([name, source]) => [name, createHash("sha1").update(source).digest("hex")])) as Record<
  ScriptName,
  string
>;

// Locksmith::CLOCK_DRIFT_FACTOR
const CLOCK_DRIFT_FACTOR = 0.01;

export function lockKeys(digest: string): string[] {
  return [
    digest,
    `${digest}:QUEUED`,
    `${digest}:PRIMED`,
    `${digest}:LOCKED`,
    `${digest}:INFO`,
    "uniquejobs:changelog",
    "uniquejobs:digests",
    "uniquejobs:expiring_digests",
  ];
}

const redisVersions = new WeakMap<Redis, Promise<string>>();
function redisVersion(redis: Redis): Promise<string> {
  let version = redisVersions.get(redis);
  if (!version) {
    version = redis.info("server").then((info) => info.match(/^redis_version:(\S+)/mu)?.[1] ?? "0.0.0");
    redisVersions.set(redis, version);
  }
  return version;
}

// Locksmith#argv plus Script::Caller#do_call's injected arguments, stringified as redis-client
// would: nil/false become 0, Floats use Float#to_s.
async function argv(redis: Redis, item: SidekiqItem, script: ScriptName, now: number): Promise<string[]> {
  const ttl = typeof item.lock_ttl === "number" ? Math.trunc(item.lock_ttl) : 0;
  return [
    String(item.jid),
    String(ttl * 1000),
    String(item.lock),
    String(typeof item.lock_limit === "number" ? item.lock_limit : 1),
    item.at === undefined || item.at === null ? "" : scheduledAtToS(item.at),
    rubyFloatToS(now),
    "0",
    String(UNIQUE_JOBS.maxHistory),
    script,
    await redisVersion(redis),
  ];
}

async function callScript(redis: Redis, script: ScriptName, item: SidekiqItem, now: number): Promise<string | null> {
  const keys = lockKeys(String(item.lock_digest));
  const args = await argv(redis, item, script, now);
  try {
    return (await redis.evalsha(SHAS[script], keys.length, ...keys, ...args)) as string | null;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) throw error;
    return (await redis.eval(SCRIPTS[script], keys.length, ...keys, ...args)) as string | null;
  }
}

// LockConfig#timeout: `lock_timeout` defaults to 0 when absent, but an explicit nil stays nil.
function configTimeout(item: SidekiqItem): number | null {
  if (!("lock_timeout" in item)) return 0;
  return typeof item.lock_timeout === "number" ? Math.trunc(item.lock_timeout) : null;
}

// How Locksmith pops the primed token. `undefined` is LMOVE; a number is BLMOVE's timeout in
// seconds. primed_sync waits only when the job sets a positive lock_timeout; primed_async
// (runtime locks, and lock(wait:)) always blocks, for at least a second.
type PopMode = { primed: "sync" } | { primed: "async"; wait?: number };

function popTimeout(item: SidekiqItem, mode: PopMode): number | undefined {
  const timeout = configTimeout(item);
  if (mode.primed === "async") return Math.trunc(mode.wait ?? timeout ?? 0) || 1;
  return timeout === null || timeout > 0 ? (timeout ?? undefined) : undefined;
}

// BLMOVE blocks its connection, so it never runs on the shared one: each waiter borrows a
// duplicate, as the gem's Concurrent::Promises future borrows a pooled connection.
const idleBlocking = new WeakMap<Redis, Redis[]>();

async function withBlockingConnection<T>(redis: Redis, fn: (connection: Redis) => Promise<T>): Promise<T> {
  let idle = idleBlocking.get(redis);
  if (!idle) idleBlocking.set(redis, (idle = []));
  const connection = idle.pop() ?? redis.duplicate();
  try {
    return await fn(connection);
  } finally {
    idle.push(connection);
  }
}

export function closeBlockingConnections(redis: Redis): void {
  for (const connection of idleBlocking.get(redis) ?? []) connection.disconnect();
  idleBlocking.delete(redis);
}

// Locksmith#lock! up to the lock.lua call: true once this jid holds the digest.
async function lockBang(redis: Redis, item: SidekiqItem, now: number, mode: PopMode): Promise<boolean> {
  const jid = String(item.jid);
  const [digest] = lockKeys(String(item.lock_digest));
  if ((await redis.hexists(`${digest}:LOCKED`, jid)) === 1) return true;

  const started = performance.now();
  const queued = await callScript(redis, "queue", item, now);
  if (queued !== jid && queued !== "1") return false;

  const pttl = typeof item.lock_ttl === "number" ? Math.trunc(item.lock_ttl) * 1000 : 0;
  const validity = pttl - (performance.now() - started) - (pttl + 2) * CLOCK_DRIFT_FACTOR;
  if (!(validity >= 0 || pttl === 0)) return false;

  // `unlock.lua` leaves a "1" in QUEUED to wake waiters, so the popped value may be that marker.
  const wait = popTimeout(item, mode);
  const primed =
    wait === undefined
      ? await redis.lmove(`${digest}:QUEUED`, `${digest}:PRIMED`, "RIGHT", "LEFT")
      : await withBlockingConnection(redis, (connection) => connection.blmove(`${digest}:QUEUED`, `${digest}:PRIMED`, "RIGHT", "LEFT", wait));
  if (primed !== jid && primed !== "1") return false;

  return (await callScript(redis, "lock", item, now)) !== null;
}

// Locksmith#lock without `wait`, which is how the client middleware calls it. Returns false when
// another job holds the digest; the caller then applies the on_conflict strategy.
export function acquireClientLock(redis: Redis, item: SidekiqItem, now: number): Promise<boolean> {
  return lockBang(redis, item, now, { primed: "sync" });
}

// Locksmith#lock(wait:), the relock after a failed run.
export function relock(redis: Redis, item: SidekiqItem, now: number, wait: number): Promise<boolean> {
  return lockBang(redis, item, now, { primed: "async", wait });
}

// Locksmith#execute: takes the lock (blocking up to lock_timeout), runs `body` and, as every
// lock's execute block does in its `ensure`, unlocks afterwards. False when the lock was not
// taken, so the caller applies the server on_conflict strategy.
export async function executeLocked(redis: Redis, item: SidekiqItem, now: () => number, body: () => Promise<void>): Promise<boolean> {
  if (!(await lockBang(redis, item, now(), { primed: "async" }))) return false;
  try {
    await body();
  } finally {
    await releaseLock(redis, item, now());
  }
  return true;
}

// Locksmith#unlock, for the Node worker running a job whose lock was taken on enqueue.
export async function releaseLock(redis: Redis, item: SidekiqItem, now = Date.now() / 1000): Promise<boolean> {
  const [digest] = lockKeys(String(item.lock_digest));
  if ((await redis.hexists(`${digest}:LOCKED`, String(item.jid))) === 0) return false;
  return (await callScript(redis, "unlock", item, now)) === item.jid;
}
