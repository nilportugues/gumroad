// Replay support for fixtures recorded with a signed-in visitor: the recorded cookies are encrypted
// with the recording app's secret_key_base, so they are re-encrypted for the server under test, and
// the Redis state the request depended on (Flipper, impersonation) is put back.
import type { Redis } from "ioredis";

import {
  deriveRailsCookieSecrets,
  readEncryptedCookie,
  readSignedCookie,
  writeEncryptedCookie,
  writeSignedCookie,
} from "@/server/auth/rails-cookies";

import type { Fixture, FixtureRequest, RedisEntry } from "./fixture";
import type { RedisSeeder } from "./replay";

const REMEMBER_COOKIE = "remember_user_token";
const CURRENT_SELLER_COOKIE = "current_seller_id";
const SESSION_YEARS = 10;
const PERMANENT_YEARS = 20;
const REMEMBER_MONTHS = 1;
// Recorded expiries are far in the future; reading with the epoch as "now" never rejects an old fixture.
const EPOCH = new Date(0);

const inYears = (now: Date, years: number) =>
  new Date(
    Date.UTC(
      now.getUTCFullYear() + years,
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ),
  );
const inMonths = (now: Date, months: number) =>
  new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + months,
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ),
  );

// Devise's remember cookie holds `[[id], token, Time.now.utc.to_f.to_s]`; the generation time has to
// postdate users.remember_created_at, which the replay seeds relative to its own clock.
const generatedAt = (now: Date) => (now.getTime() / 1000).toFixed(6);

// `transformSession` adjusts the decrypted session before it is written back, for values recorded as
// absolute times that the action compares with the clock.
export function reencryptCookies(
  request: FixtureRequest,
  fixture: Fixture,
  targetSecretKeyBase: string,
  now: Date,
  transformSession: (session: unknown, now: Date) => unknown = (session) => session,
): FixtureRequest {
  if (!request.cookies || !fixture.secretKeyBase) return request;
  const from = deriveRailsCookieSecrets(fixture.secretKeyBase);
  const to = deriveRailsCookieSecrets(targetSecretKeyBase);
  const cookies = { ...request.cookies };
  for (const [name, raw] of Object.entries(request.cookies)) {
    if (name === fixture.sessionCookie) {
      const value = readEncryptedCookie(from, name, raw, EPOCH);
      if (value !== null)
        cookies[name] = writeEncryptedCookie(to, name, transformSession(value, now), {
          expiresAt: inYears(now, SESSION_YEARS),
        });
    } else if (name === CURRENT_SELLER_COOKIE) {
      const value = readEncryptedCookie(from, name, raw, EPOCH);
      if (value !== null)
        cookies[name] = writeEncryptedCookie(to, name, value, { expiresAt: inYears(now, PERMANENT_YEARS) });
    } else if (name === REMEMBER_COOKIE) {
      const value = readSignedCookie(from, name, raw, EPOCH);
      if (Array.isArray(value))
        cookies[name] = writeSignedCookie(to, name, [value[0], value[1], generatedAt(now)], {
          expiresAt: inMonths(now, REMEMBER_MONTHS),
        });
    }
  }
  return { ...request, cookies };
}

export function redisSeeder(redis: Redis): RedisSeeder {
  return {
    async reset(entries: Record<string, RedisEntry>) {
      await redis.flushdb();
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.type === "string") await redis.set(key, entry.value as string);
        else if (entry.type === "hash") await redis.hset(key, entry.value as Record<string, string>);
        else if ((entry.value as string[]).length > 0) await redis.sadd(key, ...(entry.value as string[]));
        if (entry.ttl) await redis.expire(key, entry.ttl);
      }
    },
  };
}
