import { crc32 } from "node:zlib";

import type { Redis } from "ioredis";

import { notifyError } from "./error-reporting";
import { getRedis } from "./redis";

// Read-only port of Flipper 1.3 over the Redis adapter Rails configures in
// config/initializers/feature_toggle.rb (flipper-redis on $redis, no key prefix), wrapped in
// lib/flipper/adapters/redis_fail_open.rb. Writes stay in Rails (Flipper UI, console).

/** Anything Rails passes as a Flipper actor: its `flipper_id`, e.g. "User;123". */
export type FlipperActor = string | { flipperId: string };

// Flipper::Identifier on User: "#{self.class.name};#{id}".
export function userActor(userId: bigint | number | string): string {
  return `User;${userId}`;
}

export type GateValues = {
  boolean: boolean;
  actors: Set<string>;
  groups: Set<string>;
  expression: unknown;
  percentageOfActors: number;
  percentageOfTime: number;
};

export class UnsupportedFlipperGateError extends Error {}

// Ruby String#to_i / #to_f: parse the leading number and ignore the rest.
function rubyToI(value: string): number {
  const match = /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
  return match ? Number.parseInt(match[0].replaceAll("_", ""), 10) : 0;
}

function rubyToF(value: string): number {
  const match = /^\s*[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?/u.exec(value);
  return match ? Number.parseFloat(match[0].replaceAll("_", "")) : 0;
}

// Flipper::Typecast.to_number
function toNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  return value.includes(".") ? rubyToF(value) : rubyToI(value);
}

// Flipper::Adapters::Redis#result_for_feature followed by Flipper::GateValues.new.
export function parseGateValues(doc: Record<string, string>): GateValues {
  const setFor = (gateKey: string) =>
    new Set(
      Object.keys(doc)
        .filter((field) => field.startsWith(`${gateKey}/`))
        .map((field) => field.slice(gateKey.length + 1)),
    );
  const expression = doc.expression;
  return {
    boolean: doc.boolean === "true" || doc.boolean === "1",
    actors: setFor("actors"),
    groups: setFor("groups"),
    expression: expression === undefined ? undefined : JSON.parse(expression),
    percentageOfActors: toNumber(doc.percentage_of_actors),
    percentageOfTime: toNumber(doc.percentage_of_time),
  };
}

function actorIds(actors: FlipperActor | FlipperActor[] | null | undefined): string[] {
  const list = actors === null || actors === undefined ? [] : Array.isArray(actors) ? actors : [actors];
  return list.map((actor) => (typeof actor === "string" ? actor : actor.flipperId));
}

const SCALING_FACTOR = 1_000;

// Flipper::Gates::PercentageOfActors#open?
export function percentageOfActorsOpen(featureName: string, ids: string[], percentage: number): boolean {
  if (ids.length === 0) return false;
  const sorted = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = crc32(Buffer.from(`${featureName}${sorted.join("")}`, "utf8"));
  return hash % (100 * SCALING_FACTOR) < percentage * SCALING_FACTOR;
}

/**
 * Flipper::Feature#enabled?: gates in Flipper's order (boolean, expression, actor, percentage of
 * actors, percentage of time, group). No groups are registered in the Rails app, so the group
 * gate never opens; expressions are not ported and fail loudly instead of guessing.
 */
export function evaluateFeature(
  featureName: string,
  values: GateValues,
  actors?: FlipperActor | FlipperActor[] | null,
  random: () => number = Math.random,
): boolean {
  const ids = actorIds(actors);
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null) {
    throw new UnsupportedFlipperGateError(`Feature ${featureName} uses an expression gate`);
  }
  if (ids.some((id) => values.actors.has(id))) return true;
  if (percentageOfActorsOpen(featureName, ids, values.percentageOfActors)) return true;
  if (random() < values.percentageOfTime / 100) return true;
  return false;
}

// RedisFailOpen: remember each feature's last successful read and serve it when Redis errors, so
// a Redis blip does not flip flags (some gate tax collection or webhook verification). A feature
// never read successfully still raises. Errors are reported at most once a minute.
const MAX_FEATURES = 1_000;
const REPORT_INTERVAL_MS = 60_000;
const lastKnown = new Map<string, Record<string, string>>();
let lastReportedAt: number | undefined;

function remember(key: string, doc: Record<string, string>): void {
  lastKnown.delete(key);
  lastKnown.set(key, doc);
  while (lastKnown.size > MAX_FEATURES) {
    const oldest = lastKnown.keys().next().value;
    if (oldest === undefined) break;
    lastKnown.delete(oldest);
  }
}

function report(error: unknown): void {
  try {
    const now = performance.now();
    if (lastReportedAt !== undefined && now - lastReportedAt < REPORT_INTERVAL_MS) return;
    lastReportedAt = now;
    notifyError(error, { adapter: "Flipper::Adapters::RedisFailOpen" });
  } catch {
    // Reporting must not turn a degraded flag read back into a failed request.
  }
}

export async function readFeatureDoc(name: string, redis: Redis = getRedis("main")): Promise<Record<string, string>> {
  try {
    const doc = await redis.hgetall(name);
    remember(name, doc);
    return doc;
  } catch (error) {
    report(error);
    const fallback = lastKnown.get(name);
    if (fallback === undefined) throw error;
    return { ...fallback };
  }
}

export function resetFlipperStateForTesting(): void {
  lastKnown.clear();
  lastReportedAt = undefined;
}

export type FeatureCheckOptions = {
  redis?: Redis;
  /** Per-request memo, like Flipper's Rails memoizer middleware. */
  memo?: Map<string, GateValues>;
};

/**
 * Feature.active?(name, actor) from lib/utilities/feature.rb. The `auto_marketing` special case
 * (Marketing::Eligibility) is not ported; asking for it with an actor throws.
 */
export async function isFeatureEnabled(
  name: string,
  actor?: FlipperActor | FlipperActor[] | null,
  options: FeatureCheckOptions = {},
): Promise<boolean> {
  if (name === "auto_marketing" && actor !== undefined && actor !== null) {
    throw new UnsupportedFlipperGateError("auto_marketing is decided by Marketing::Eligibility, which is not ported");
  }
  let values = options.memo?.get(name);
  if (values === undefined) {
    values = parseGateValues(await readFeatureDoc(name, options.redis));
    options.memo?.set(name, values);
  }
  return evaluateFeature(name, values, actor);
}
