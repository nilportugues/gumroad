// The reads and writes of the free checkout that go to Redis, to Flipper or to Ruby's random number generator rather than
// to MySQL. Each is a seam so a test can answer it from the Ruby recording (purchase-create.golden.json logs them in
// order beside the statements); production reads the real Redis and flags.
import { randomInt } from "node:crypto";

import { isFeatureEnabled } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";

export type CheckoutEffects = {
  // `Feature.active?(name, actor)`; the actor is a Flipper id such as "User;1"
  featureActive(name: string, actor?: string | null): Promise<boolean>;
  // `$redis.get(key)`
  redisGet(key: string): Promise<string | null>;
  // `$redis.mget(*keys)`
  redisMget(keys: string[]): Promise<(string | null)[]>;
  // Purchase::Blockable#delete_failed_purchases_count: PRODUCT_STREAK_CLEAR_SCRIPT over the product's four streak keys,
  // under the `failed_purchases_count` namespace
  clearProductFailureStreak(keys: string[]): Promise<void>;
  // `rand(max.seconds)`, as ElasticsearchIndexerWorker's low-priority update_by_query is spread over 72 hours
  randomDelaySeconds(maxSeconds: number): number;
};

// RedisKey namespace of Purchase::Blockable#failed_purchases_count_redis_namespace
const FAILED_PURCHASES_COUNT_NAMESPACE = "failed_purchases_count";
const PRODUCT_STREAK_CLEAR_SCRIPT = 'return redis.call("DEL", unpack(KEYS))\n';

export const defaultCheckoutEffects: CheckoutEffects = {
  featureActive: (name, actor) => isFeatureEnabled(name, actor ?? undefined),
  redisGet: (key) => getRedis("main").get(key),
  redisMget: (keys) => getRedis("main").mget(...keys),
  async clearProductFailureStreak(keys) {
    const namespaced = keys.map((key) => `${FAILED_PURCHASES_COUNT_NAMESPACE}:${key}`);
    await getRedis("main").eval(PRODUCT_STREAK_CLEAR_SCRIPT, namespaced.length, ...namespaced);
  },
  randomDelaySeconds: (maxSeconds) => randomInt(maxSeconds),
};
