// Cache key handling of ActiveSupport::Cache::Store and MemCacheStore (activesupport 8.1).
import { createHash } from "node:crypto";

import type { CacheVersion } from "./coder.ts";
import { RubyAsciiString } from "./marshal.ts";

// An object passed as (part of) a key, standing in for anything that responds to cache_key /
// cache_version (a record or relation): its `cache_key` and optional `cache_version`.
export type CacheKeyed = { cacheKey: string; cacheVersion?: CacheVersion | null };
export type CacheKeyPart = string | number | bigint | CacheKeyed;
export type CacheName = CacheKeyPart | CacheKeyPart[];

// ActiveSupport::Cache::MAX_KEY_SIZE, MemCacheStore's default :max_key_size.
export const MAX_KEY_SIZE = 250;
const ESCAPE_KEY_CHARS = /[\x00-\x20%\x7f-\xff]/g;

// ActiveSupport::Digest.hexdigest with load_defaults 8.1's hash_digest_class (SHA256).
export function activeSupportHexdigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isKeyed(part: CacheKeyPart): part is CacheKeyed {
  return typeof part === "object";
}

function partToParam(part: CacheKeyPart): string {
  return isKeyed(part) ? part.cacheKey : String(part);
}

// Store#expanded_key: cache_key if present, arrays joined by "/" (Array#to_param).
export function expandedKey(name: CacheName): string {
  if (Array.isArray(name)) return name.length === 1 ? expandedKey(name[0]!) : name.map(partToParam).join("/");
  return partToParam(name);
}

// Store#normalize_version without an explicit :version: a String key has none, an Array key
// has the "/"-joined versions of its parts, which is "" when none of them has one.
// Array#join takes its first element's encoding, and is US-ASCII when empty, which the coder
// then stores Marshal-dumped.
export function expandedVersion(name: CacheName): CacheVersion | null {
  if (Array.isArray(name)) {
    const versions = name.map((part) => (isKeyed(part) ? (part.cacheVersion ?? null) : null)).filter((version) => version !== null);
    const joined = versions.map(versionText).join("/");
    return versions[0] === undefined || versions[0] instanceof RubyAsciiString ? new RubyAsciiString(joined) : joined;
  }
  return isKeyed(name) ? (name.cacheVersion ?? null) : null;
}

export function versionText(version: CacheVersion): string {
  return typeof version === "string" ? version : version.value;
}

// MemCacheStore#normalize_key: expand, namespace, escape bytes memcached rejects (as `%` plus
// unpadded uppercase hex, so "\x01" becomes "%1"), then Store#truncate_key.
export function normalizeKey(name: CacheName, namespace: string | null): string {
  const expanded = expandedKey(name);
  if (expanded === "") throw new Error("key cannot be blank");
  const namespaced = namespace === null ? expanded : `${namespace}:${expanded}`;
  const escaped = Buffer.from(namespaced, "utf8")
    .toString("latin1")
    .replace(ESCAPE_KEY_CHARS, (match) => `%${match.charCodeAt(0).toString(16).toUpperCase()}`);
  if (escaped.length <= MAX_KEY_SIZE) return escaped;
  const suffix = `:hash:${activeSupportHexdigest(escaped)}`;
  return `${escaped.slice(0, MAX_KEY_SIZE - suffix.length)}${suffix}`;
}

// Time#to_fs(:usec) of a UTC time: "%Y%m%d%H%M%S%6N". `micros` carries what a JS Date cannot.
export function usecTimestamp(time: Date, micros = time.getUTCMilliseconds() * 1000): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${time.getUTCFullYear()}${pad(time.getUTCMonth() + 1)}${pad(time.getUTCDate())}` +
    `${pad(time.getUTCHours())}${pad(time.getUTCMinutes())}${pad(time.getUTCSeconds())}${pad(micros, 6)}`
  );
}

// ActiveRecord::Relation#cache_key_with_version with collection_cache_versioning on: the key is
// "<model_name.cache_key>/query-<digest of to_sql>", the version "<COUNT(*)>-<MAX(updated_at)>"
// from the relation's own SELECT COUNT(*) AS `size`, MAX(updated_at) AS timestamp query.
export function relationCacheKey(modelCacheKey: string, sql: string): string {
  return `${modelCacheKey}/query-${activeSupportHexdigest(sql)}`;
}

export function relationCacheVersion(size: number | bigint, maxUpdatedAt: { time: Date; micros?: number } | null): string {
  return maxUpdatedAt ? `${size}-${usecTimestamp(maxUpdatedAt.time, maxUpdatedAt.micros)}` : `${size}`;
}

export function relationCacheKeyWithVersion(
  modelCacheKey: string,
  sql: string,
  size: number | bigint,
  maxUpdatedAt: { time: Date; micros?: number } | null,
): string {
  return `${relationCacheKey(modelCacheKey, sql)}-${relationCacheVersion(size, maxUpdatedAt)}`;
}
