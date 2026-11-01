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

// `displayable_time_duration`: the delay back in the unit the creator picked (`(delay / period).to_i`).
// A rule whose `time_period` is none of the four has no period, which Ruby fails on.
export function displayableTimeDuration(rule: { delayed_delivery_time: number | null; time_period: string | null }): number {
  const period = PERIOD_SECONDS[rule.time_period ?? ""];
  if (rule.delayed_delivery_time === null) throw new TypeError("undefined method '/' for nil");
  if (period === undefined) throw new TypeError("nil can't be coerced into Integer");
  return Math.trunc(rule.delayed_delivery_time / period);
}
