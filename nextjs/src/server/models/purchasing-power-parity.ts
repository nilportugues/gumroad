// Port of app/services/purchasing_power_parity_service.rb: the per-country price factors in the `ppp` Redis
// namespace, floored at the seller's own `min_ppp_factor` (User#min_ppp_factor). Golden:
// __fixtures__/purchasing-power-parity.golden.json (scripts/golden/purchasing-power-parity.rb, the real service
// against a scratch Redis, with the commands it sent).
import type { Redis } from "ioredis";

import { getRedis, namespacedKey } from "../infra/redis.ts";
import { isBlank, mapping } from "./compliance-countries.ts";
import { rubyStringToF } from "./concerns/currency-helper.ts";

export type PurchasingPowerParityDeps = {
  // $redis
  redis: () => Pick<Redis, "get" | "set" | "mget">;
};

const defaultDeps: PurchasingPowerParityDeps = { redis: () => getRedis("main") };
let deps = defaultDeps;

export function setPurchasingPowerParityDepsForTesting(next: Partial<PurchasingPowerParityDeps> | undefined): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

// `Redis::Namespace.new(:ppp, redis: $redis)`'s keys
const factorKey = (countryCode: string) => namespacedKey("ppp", countryCode);

// `(value.presence || 1).to_f`
const storedFactor = (value: string | null | undefined): number => (value == null || isBlank(value) ? 1 : rubyStringToF(value));

// User#min_ppp_factor: `purchasing_power_parity_limit?` is false for nil and 0.
export function minPppFactor(user: { purchasing_power_parity_limit: number | null }): number {
  const limit = user.purchasing_power_parity_limit;
  if (limit == null || limit === 0) return 0;
  return 1 - limit / 100;
}

// PurchasingPowerParityService#get_factor. A stalled or failed Redis read (every Redis::BaseError and
// RedisClient::Error) shows the buyer the unadjusted price.
export async function getFactor(countryCode: string | null | undefined, seller: { purchasing_power_parity_limit: number | null }): Promise<number> {
  let factor: number;
  try {
    factor = countryCode != null && !isBlank(countryCode) ? storedFactor(await deps.redis().get(factorKey(countryCode))) : 1;
  } catch {
    return Math.max(1, minPppFactor(seller));
  }
  return Math.max(factor, minPppFactor(seller));
}

// PurchasingPowerParityService#set_factor: redis-rb sends `factor.to_s`.
export async function setFactor(countryCode: string, factor: string): Promise<void> {
  await deps.redis().set(factorKey(countryCode), factor);
}

// PurchasingPowerParityService#get_all_countries_factors: every code of Compliance::Countries.mapping, in order.
export async function getAllCountriesFactors(seller: { purchasing_power_parity_limit: number | null }): Promise<Array<[string, number]>> {
  const countryCodes = mapping().map(([code]) => code);
  let values: Array<string | null> | undefined;
  try {
    values = await deps.redis().mget(...countryCodes.map(factorKey));
  } catch {
    values = undefined;
  }
  const floor = minPppFactor(seller);
  return countryCodes.map((code, index) => [code, Math.max(values === undefined ? 1 : storedFactor(values[index]), floor)]);
}
