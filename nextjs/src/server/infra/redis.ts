import { Redis, type RedisOptions } from "ioredis";

// One client per Redis that Rails talks to. Rails reads these straight from ENV (not GlobalConfig),
// and every *_HOST value carries its own database, e.g. "localhost:6379/1".
export type RedisPurpose = "main" | "sidekiq" | "rpush" | "rackAttack" | "anycable";

export function redisUrl(purpose: RedisPurpose): string {
  switch (purpose) {
    case "main": // config/redis.rb ($redis); Flipper and every Redis::Namespace sit on it
      return `redis://${process.env.REDIS_HOST ?? ""}`;
    case "sidekiq": // config/initializers/sidekiq.rb
      return `redis://${process.env.SIDEKIQ_REDIS_HOST ?? ""}`;
    case "rpush": // config/initializers/rpush.rb
      return `redis://${process.env.RPUSH_REDIS_HOST ?? ""}`;
    case "rackAttack": // config/initializers/rack_attack.rb uses ENV.fetch, so it is required
      return `redis://${requiredEnv("RACK_ATTACK_REDIS_HOST")}`;
    case "anycable": // config/cable.yml (production)
      return process.env.ANYCABLE_REDIS_URL ?? `redis://${requiredEnv("REDIS_HOST")}/5`;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`key not found: "${name}"`);
  return value;
}

const clients = new Map<string, Redis>();

function cached(key: string, build: () => Redis): Redis {
  let client = clients.get(key);
  if (!client) {
    client = build();
    clients.set(key, client);
  }
  return client;
}

function options(extra: RedisOptions = {}): RedisOptions {
  // Connect on first command so importing this module never opens sockets (Next.js build, tests).
  return { lazyConnect: true, ...extra };
}

export function getRedis(purpose: RedisPurpose = "main"): Redis {
  return cached(purpose, () => new Redis(redisUrl(purpose), options()));
}

// Every Redis::Namespace.new(:name, redis: $redis) in the Rails app. Keys are stored as "name:key".
export const REDIS_NAMESPACES = [
  "currencies",
  "failed_purchases_count",
  "license_verifications",
  "max_tax_rate_per_state_cache_us",
  "paypal_partner_rest_auth_token",
  "ppp",
  "product_duplicator_service",
  "robots_redis_namespace",
  "ssl_cert_check_namespace",
  "subdomain_redirect_namespace",
  "taxjar_calculations",
  "transient_braintree_customer_store",
  "two_factor_auth_redis_namespace",
  "user_mailer_redis_namespace",
] as const;

export type RedisNamespace = (typeof REDIS_NAMESPACES)[number];

export function namespacedKey(namespace: RedisNamespace, key: string): string {
  return `${namespace}:${key}`;
}

/**
 * A client on the main Redis whose key arguments are prefixed like Redis::Namespace.
 * Unlike Redis::Namespace, ioredis does not prefix KEYS/SCAN patterns or strip the prefix from
 * their replies; use `namespacedKey` with the unprefixed main client for those.
 */
export function getNamespacedRedis(namespace: RedisNamespace): Redis {
  return cached(`ns:${namespace}`, () => new Redis(redisUrl("main"), options({ keyPrefix: `${namespace}:` })));
}

export async function closeAllRedis(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((client) => client.quit().catch(() => client.disconnect())));
}
