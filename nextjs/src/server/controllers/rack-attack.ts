// Rack::Attack's throttle counter (config/initializers/rack_attack.rb) in Node, over the same Redis keys, expiry and limits, so a throttled
// route Node serves is counted exactly once and in the counter Rails reads. A request Node then hands back is uncounted first: Rails counts it.
import { getRedis } from "../infra/redis.ts";
import { secureHeaders } from "../infra/secure-headers.ts";
import { remoteIp } from "../page-props/audience/events.ts";

import { forwarded, forwardToRails, HandBackToRails } from "./application-controller.ts";
import { parseQuery } from "./rails-query.ts";

// `discriminator` is the throttle block's value: the client address unless a rule keys on something else, and null when the rule does not apply
// to the request. It may throw HandBackToRails for a shape Rack's parameter parser reads differently.
export type Tier = {
  name: string;
  limit: number;
  period: number;
  discriminator?: (incoming: Request, ip: string) => string | null;
};

// `throttle_with_exponential_backoff`: the base window, then `rpm * level` requests per `8 ** level` seconds for each level up to `maxLevel`.
export function exponentialBackoff(
  name: string,
  requests: number,
  period: number,
  maxLevel: number,
  discriminator?: Tier["discriminator"],
): Tier[] {
  const requestsPerMinute = (requests / period) * 60;
  const tiers: Tier[] = [{ name, limit: requests, period, discriminator }];
  for (let level = 2; level <= maxLevel; level += 1)
    tiers.push({ name: `${name}/${level}`, limit: requestsPerMinute * level, period: 8 ** level, discriminator });
  return tiers.map((tier) =>
    tier.discriminator === undefined ? { name: tier.name, limit: tier.limit, period: tier.period } : tier,
  );
}

// `throttle_by_ip path:, requests:, period:` (no `method`): `/ip:<path>`, keyed by Request#remote_ip.
export const throttleByIp = (path: string, requests: number, period: number, maxLevel = 5): Tier[] =>
  exponentialBackoff(`/ip:${path}`, requests, period, maxLevel);

// Request#remote_ip: `CF-Connecting-IP`, else the client Rails derives from X-Forwarded-For. A request with neither reached Node directly,
// as a loopback client does (production traffic always carries the load balancer's header), and the localhost safelist skips it.
export function clientIp(headers: Headers): string {
  return (headers.get("cf-connecting-ip") ?? remoteIp(headers) ?? "127.0.0.1").toString();
}

// `safelist("allow from localhost", &:localhost?)`
const localhost = (ip: string) => ip === "127.0.0.1" || ip === "::1";

// Rack::Attack.throttle_discriminator_normalizer
const normalized = (discriminator: string) => discriminator.trim().toLowerCase();

const unprefixedKey = (tier: Tier, discriminator: string, epochSeconds: number) =>
  `rack::attack:${Math.trunc(epochSeconds / tier.period)}:${tier.name}:${normalized(discriminator)}`;

export type Counted = { response: Response | null; uncount(): Promise<void> };

// Rack::Attack#call for the throttles of one route: each tier is counted in order and the first one past its limit answers 429
// (`throttled?` is `any?`, so the later tiers are not counted for that request).
export async function countThrottles(incoming: Request, tiers: Tier[]): Promise<Counted> {
  const ip = clientIp(incoming.headers);
  if (localhost(ip)) return { response: null, uncount: async () => undefined };

  const redis = getRedis("rackAttack");
  const counted: string[] = [];
  const uncount = async () => {
    // Redis::BaseConnectionError is swallowed by the store proxy; a lost decrement leaves the window one request high.
    if (counted.length > 0)
      await redis
        .pipeline(counted.map((key) => ["decr", key]))
        .exec()
        .catch(() => undefined);
  };
  for (const tier of tiers) {
    let discriminator: string | null;
    try {
      discriminator = tier.discriminator === undefined ? ip : tier.discriminator(incoming, ip);
    } catch (error) {
      await uncount();
      throw error;
    }
    if (discriminator === null) continue;
    const epoch = Math.trunc(Date.now() / 1000);
    const key = unprefixedKey(tier, discriminator, epoch);
    // Cache#key_and_expiry: one second past the end of the window.
    const expiresIn = tier.period - (epoch % tier.period) + 1;
    let count = 1;
    try {
      const results = await redis.pipeline().incrby(key, 1).expire(key, expiresIn).exec();
      const value = results?.[0]?.[1];
      count = typeof value === "number" ? value : 1;
      counted.push(key);
    } catch {
      // `result || 1`: a store that cannot be reached never throttles.
    }
    if (count > tier.limit) {
      const retryAfter = tier.period - (epoch % tier.period);
      return {
        response: new Response("Retry later\n", {
          status: 429,
          // The middleware answers outside the controller: the SecureHeaders non-CSP headers, Rack::Cors' Vary and no cache.
          headers: {
            ...secureHeaders({ optOutOfCsp: true }),
            "cache-control": "no-cache",
            vary: "Origin",
            "content-type": "text/plain",
            "retry-after": String(retryAfter),
          },
        }),
        uncount: async () => undefined,
      };
    }
  }
  return { response: null, uncount };
}

// Runs `respond` behind the throttles. A response that was handed to Rails (`forwardToRails`) is uncounted.
export async function throttled(incoming: Request, tiers: Tier[], respond: () => Promise<Response>): Promise<Response> {
  let counted: Counted;
  try {
    counted = await countThrottles(incoming, tiers);
  } catch (error) {
    if (error instanceof HandBackToRails) return forwardToRails(incoming);
    throw error;
  }
  if (counted.response !== null) return counted.response;
  const response = await respond();
  if (forwarded(incoming)) await counted.uncount();
  return response;
}

// GROUPED_RECEIPT_LOOKUP_PATHS: `/ip:<path>` (3 in 20 seconds) for each, and one per-recipient budget shared by the first two (6 in a minute,
// to level 6), keyed on the stripped, downcased `email` parameter, nothing when it is blank. A parameter that is not a plain string reads
// differently in Rack than in the port, so the request goes to Rails.
const GROUPED_RECEIPT_EMAIL_PATHS = new Set(["/charge_data", "/license_key_lookup_data"]);
const emailParam = (incoming: Request): string | null => {
  const email = parseQuery(new URL(incoming.url).search.replace(/^\?/u, "")).email;
  if (email === undefined) return null;
  if (typeof email !== "string") throw new HandBackToRails("an email parameter that is not a plain string");
  return email.trim().toLowerCase() === "" ? null : email.trim().toLowerCase();
};

export function groupedReceiptThrottles(path: string): Tier[] {
  return [
    ...exponentialBackoff(`/ip:${path}`, 3, 20, 5),
    ...(GROUPED_RECEIPT_EMAIL_PATHS.has(path)
      ? exponentialBackoff("/params:grouped_receipt:email", 6, 60, 6, emailParam)
      : []),
  ];
}
