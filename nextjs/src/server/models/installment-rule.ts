// Read side of app/models/installment_rule.rb: the version Redis caches for each workflow
// installment, and the delay a creator entered. The writes (`advance_version!`, the pending-version
// Lua scripts, the callbacks around `before_save`) stay in Ruby.
import type { Redis } from "ioredis";

import { getRedis } from "../infra/redis.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";

export const INSTALLMENT_RULE_VERSION_CACHE_TTL_SECONDS = 24 * 60 * 60;

const HOUR_SECONDS = 3600;
// 1.hour, 1.day, 1.week and 1.month as ActiveSupport durations: a month is 2629746 seconds, not 30 days.
const PERIOD_SECONDS: Record<string, number> = { hour: HOUR_SECONDS, day: 24 * HOUR_SECONDS, week: 7 * 24 * HOUR_SECONDS, month: 2_629_746 };

// RedisKey.workflow_installment_rule_version / _pending_token
export const ruleVersionKey = (installmentId: number | bigint) => `workflow_installment_rule:${installmentId}:version`;
export const rulePendingTokenKey = (installmentId: number | bigint) => `workflow_installment_rule:${installmentId}:pending_token`;

// `InstallmentRule.cached_version(installment_id)`: nil when nothing is cached.
export async function cachedVersion(installmentId: number | bigint, redis: Redis = getRedis("main")): Promise<number | null> {
  const value = await redis.get(ruleVersionKey(installmentId));
  return value === null ? null : rubyToI(value);
}

// `InstallmentRule.cached_version_state(installment_id)`: the cached version and whether a pending
// write holds the key (`owner.present?`).
export async function cachedVersionState(installmentId: number | bigint, redis: Redis = getRedis("main")): Promise<[number | null, boolean]> {
  const [version, owner] = await redis.mget(ruleVersionKey(installmentId), rulePendingTokenKey(installmentId));
  return [version === null || version === undefined ? null : rubyToI(version), owner !== null && owner !== undefined && owner.trim() !== ""];
}

// InstallmentRule::CACHE_COMMITTED_VERSION_SCRIPT, byte for byte
export const CACHE_COMMITTED_VERSION_SCRIPT = `local current = redis.call("GET", KEYS[1])
local owner = redis.call("GET", KEYS[2])
if current and tonumber(current) > tonumber(ARGV[1]) then
  return tonumber(current)
end
if owner and (ARGV[2] == "" or owner ~= ARGV[2]) then
  return current and tonumber(current) or false
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
redis.call("DEL", KEYS[2])
return tonumber(ARGV[1])
`;

// `InstallmentRule.cache_committed_version!(installment_id:, version:, expected_pending_token:, expires_in:)`: the version the
// cache holds afterwards, or nil when a pending write holds the key and nothing is cached.
export async function cacheCommittedVersion(
  installmentId: number | bigint,
  version: number,
  redis: Redis = getRedis("main"),
  { expectedPendingToken = "", expiresIn = INSTALLMENT_RULE_VERSION_CACHE_TTL_SECONDS }: { expectedPendingToken?: string; expiresIn?: number } = {},
): Promise<number | null> {
  const result = await redis.eval(CACHE_COMMITTED_VERSION_SCRIPT, 2, ruleVersionKey(installmentId), rulePendingTokenKey(installmentId), String(version), expectedPendingToken, String(expiresIn));
  return result === null || result === undefined ? null : rubyToI(String(result));
}

// `rule.cache_version!`: nothing for a rule without an installment.
export async function cacheVersionBang(rule: { installment_id: number | bigint | null; version: number }, redis: Redis = getRedis("main")): Promise<number | null> {
  if (rule.installment_id === null) return null;
  return cacheCommittedVersion(rule.installment_id, rule.version, redis);
}

// `displayable_time_duration`: the delay back in the unit the creator picked (`(delay / period).to_i`).
// A rule whose `time_period` is none of the four has no period, which Ruby fails on.
export function displayableTimeDuration(rule: { delayed_delivery_time: number | null; time_period: string | null }): number {
  const period = PERIOD_SECONDS[rule.time_period ?? ""];
  if (rule.delayed_delivery_time === null) throw new TypeError("undefined method '/' for nil");
  if (period === undefined) throw new TypeError("nil can't be coerced into Integer");
  return Math.trunc(rule.delayed_delivery_time / period);
}
