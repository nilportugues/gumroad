// Port of the throttle counter of the rack-attack gem (6.7) as config/initializers/rack_attack.rb configures it: the same Redis
// (RACK_ATTACK_REDIS_HOST), key, expiry and limit, so a request Node answers counts against the same bucket Rails would have used.
import { AsyncLocalStorage } from "node:async_hooks";

import { railsEnv } from "./rails-env.ts";
import { getRedis } from "./redis.ts";

const KEY_PREFIX = "rack::attack";
const MAX_LEVEL = 5;
const LEVEL_BASE = 8;

export type ThrottleRule = {
  // `throttle_by_ip` ("/ip", exponential backoff) or `throttle_by_ip_for_period` ("/ip/period", one window).
  kind: "ip" | "ip_for_period" | "ip_and_params";
  // Ruby's Regexp#source of a regexp path, or the literal path. The rule name embeds Regexp#to_s of it.
  path: { regexpSource: string } | { literal: string };
  // Absent: every method counts, and the name has no method suffix.
  method?: "get" | "post" | "put" | "patch" | "delete";
  requests: number;
  periodSeconds: number;
  maxLevel?: number;
  // The rule sits inside `if Rails.env.production?` in rack_attack.rb.
  productionOnly?: boolean;
  // `throttle_by_ip_and_params`: the request parameter appended to the IP in the discriminator (a missing one is an empty string).
  param?: (params: Record<string, unknown>) => unknown;
};

type Tier = { name: string; limit: number; period: number };

// `throttle_name`: "#{prefix}:#{path}:#{method}" where a Regexp path is interpolated through Regexp#to_s.
export function throttleName(rule: ThrottleRule): string {
  const prefix = { ip: "/ip", ip_for_period: "/ip/period", ip_and_params: "/ip/params" }[rule.kind];
  const path = "literal" in rule.path ? rule.path.literal : `(?-mix:${rule.path.regexpSource})`;
  return rule.method === undefined ? `${prefix}:${path}` : `${prefix}:${path}:${rule.method}`;
}

// `throttle_with_exponential_backoff`: the base window, then a window of 8**level seconds at rpm * level requests for each further level.
export function tiersOf(rule: ThrottleRule): Tier[] {
  const name = throttleName(rule);
  const base: Tier = { name, limit: rule.requests, period: rule.periodSeconds };
  if (rule.kind === "ip_for_period") return [base];
  const rpm = (rule.requests / rule.periodSeconds) * 60;
  const tiers = [base];
  for (let level = 2; level <= (rule.maxLevel ?? MAX_LEVEL); level++) {
    tiers.push({ name: `${name}/${level}`, limit: rpm * level, period: LEVEL_BASE ** level });
  }
  return tiers;
}

function pathMatches(rule: ThrottleRule, pathname: string): boolean {
  if ("literal" in rule.path) return pathname === rule.path.literal;
  return new RegExp(rule.path.regexpSource.replaceAll("\\A", "^").replaceAll("\\z", "$"), "u").test(pathname);
}

// Rack::Attack::Request#localhost? is safelisted ("allow from localhost"); its remote_ip prefers CF-Connecting-IP.
export function throttleIdentity(headers: Headers, remoteIp: string | null): string {
  return (headers.get("cf-connecting-ip") ?? remoteIp ?? "127.0.0.1").trim();
}

const isLocalhost = (ip: string) => ip === "127.0.0.1" || ip === "::1";

export type ThrottleOutcome = { throttled: false } | { throttled: true; retryAfter: number };

// Keys a request incremented, so a request handed back to Rails (which counts it again) can be uncounted first.
const counted = new AsyncLocalStorage<string[]>();

export function withThrottleScope<T>(run: () => Promise<T>): Promise<T> {
  return counted.run([], run);
}

// Rack::Attack::Cache#count: INCRBY and EXPIRE in one pipeline, the expiry running to one second past the window.
async function count(key: string, period: number): Promise<number> {
  const epoch = Math.floor(Date.now() / 1000);
  const redisKey = `${KEY_PREFIX}:${Math.floor(epoch / period)}:${key}`;
  const results = await getRedis("rackAttack")
    .pipeline()
    .incrby(redisKey, 1)
    .expire(redisKey, period - (epoch % period) + 1)
    .exec();
  counted.getStore()?.push(redisKey);
  return Number(results?.[0]?.[1] ?? 1);
}

// Configuration#throttled?: every matching tier is counted in order until one is over its limit.
export async function throttleRequest(
  rules: readonly ThrottleRule[],
  input: { pathname: string; method: string; ip: string; params?: Record<string, unknown> },
): Promise<ThrottleOutcome> {
  if (isLocalhost(input.ip)) return { throttled: false };
  for (const rule of rules) {
    if ((rule.method !== undefined && input.method.toLowerCase() !== rule.method) || !pathMatches(rule, input.pathname))
      continue;
    if (rule.productionOnly && railsEnv() !== "production") continue;
    const identifier =
      rule.param === undefined ? input.ip : `${input.ip}:${String(rule.param(input.params ?? {}) ?? "")}`;
    // A regexp path puts the request path in front of the IP: one bucket per post, community or comment, not per route.
    const discriminator = "regexpSource" in rule.path ? `${input.pathname}:${identifier}` : identifier;
    for (const tier of tiersOf(rule)) {
      const total = await count(`${tier.name}:${discriminator}`, tier.period);
      if (total > tier.limit) {
        const epoch = Math.floor(Date.now() / 1000);
        return { throttled: true, retryAfter: tier.period - (epoch % tier.period) };
      }
    }
  }
  return { throttled: false };
}

// Undoes this request's increments when it is handed to Rails, whose own Rack::Attack counts it once.
export async function releaseThrottleCounts(): Promise<void> {
  const keys = counted.getStore();
  if (keys === undefined || keys.length === 0) return;
  const pipeline = getRedis("rackAttack").pipeline();
  for (const key of keys.splice(0)) pipeline.decr(key);
  await pipeline.exec();
}

export function throttledResponse(retryAfter: number): Response {
  return new Response("Retry later\n", {
    status: 429,
    headers: { "content-type": "text/plain", "retry-after": String(retryAfter) },
  });
}
