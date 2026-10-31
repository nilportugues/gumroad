// Rails.cache for Node: ActiveSupport::Cache::MemCacheStore (activesupport 8.1, dalli 3.2.8)
// as config/environments/*.rb configure it, reading and writing the same memcached entries as
// Rails. Not ported: the per-request LocalCache layer, instrumentation, read_multi/fetch_multi,
// increment/decrement and `raw: true`.
import { existsSync } from "node:fs";
import path from "node:path";

import { railsEnv, railsRoot } from "../infra/rails-env.ts";
import { type CacheEntry, type CacheVersion, dalliRetrieve, dalliStore, DALLI_VALUE_MAX_BYTES, dumpEntry, loadEntry, type LoadedEntry } from "./coder.ts";
import { type CacheName, expandedVersion, normalizeKey, versionText } from "./keys.ts";
import { type MarshalValue, RubyAsciiString } from "./marshal.ts";
import { createMemcachedTransport } from "./memcached-client.ts";
import { type CacheTransport, createMemoryTransport, createNullTransport, sanitizeTtl } from "./transport.ts";

export type CacheOptions = {
  // Seconds; ActiveSupport::Duration#to_f.
  expiresIn?: number | null;
  // Epoch seconds or a Date.
  expiresAt?: number | Date;
  // Integer#to_param is US-ASCII, so a numeric version is stored Marshal-dumped, as in Ruby.
  version?: string | RubyAsciiString | number | bigint | null;
  raceConditionTtl?: number;
  skipNil?: boolean;
  unlessExist?: boolean;
  compress?: boolean;
  compressThreshold?: number;
  force?: boolean;
  namespace?: string | null;
};

// Store::WriteOptions: what a fetch block may change before its result is written.
export type WriteOptions = { version?: CacheOptions["version"]; expiresIn?: CacheOptions["expiresIn"]; expiresAt?: CacheOptions["expiresAt"] };

export type RailsCache = {
  read(name: CacheName, options?: CacheOptions): Promise<MarshalValue | undefined>;
  write(name: CacheName, value: MarshalValue, options?: CacheOptions): Promise<boolean>;
  fetch<T extends MarshalValue>(name: CacheName, options: CacheOptions, block: (name: CacheName, options: WriteOptions) => Promise<T> | T): Promise<T>;
  delete(name: CacheName, options?: CacheOptions): Promise<boolean>;
  exist(name: CacheName, options?: CacheOptions): Promise<boolean>;
  transport: CacheTransport;
};

const DEFAULT_COMPRESS_THRESHOLD = 1024;
const RACE_CONDITION_TTL_PADDING = 5 * 60;

type Merged = CacheOptions & { expiresIn?: number | null };

export function createRailsCache(config: { transport: CacheTransport; namespace: string | null; now?: () => number; onError?: (error: unknown) => void }): RailsCache {
  const { transport } = config;
  const now = config.now ?? (() => Date.now() / 1000);
  const onError = config.onError ?? ((error: unknown) => console.error("DalliError", error));

  // Store#merged_options. raise_on_invalid_cache_expiration_time is on (new_framework_defaults_7_1).
  const merge = (options: CacheOptions = {}): Merged => {
    if (options.expiresIn != null && options.expiresAt !== undefined) throw new Error("Either :expires_in or :expires_at can be supplied, but not both");
    const merged: Merged = { ...options };
    if (options.expiresAt !== undefined) {
      const at = options.expiresAt instanceof Date ? options.expiresAt.getTime() / 1000 : options.expiresAt;
      merged.expiresIn = at - now();
      delete merged.expiresAt;
    }
    if (merged.expiresIn != null && merged.expiresIn < 0) throw new Error(`Cache expiration time is invalid, cannot be negative: ${merged.expiresIn}`);
    return merged;
  };
  const keyFor = (name: CacheName, options: Merged) => normalizeKey(name, "namespace" in options ? (options.namespace ?? null) : config.namespace);
  const versionFor = (name: CacheName, options: Merged): CacheVersion | null => {
    const { version } = options;
    if (version == null) return expandedVersion(name);
    return typeof version === "number" || typeof version === "bigint" ? new RubyAsciiString(String(version)) : version;
  };
  const mismatched = (entry: { version: CacheVersion | null }, version: CacheVersion | null) =>
    entry.version !== null && version !== null && versionText(entry.version) !== versionText(version);
  const expired = (entry: { expiresAt: number | null }) => entry.expiresAt !== null && entry.expiresAt <= now();

  // Dalli raises DalliError subclasses (network, oversize values) that MemCacheStore rescues
  // into the fallback; our transports raise plain errors for the same cases.
  const rescue = async <T>(fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      onError(error);
      return fallback;
    }
  };

  const readEntry = async (key: string): Promise<LoadedEntry | null> => {
    const stored = await rescue(null, () => transport.get(key));
    return stored ? loadEntry(dalliRetrieve(stored.value, stored.flags)) : null;
  };

  const writeEntry = async (key: string, entry: CacheEntry, options: Merged) => {
    const threshold = options.compress === false ? Infinity : (options.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD);
    const { value, flags } = dalliStore(dumpEntry(entry, threshold));
    let expiresIn = Math.trunc(options.expiresIn ?? 0);
    if (options.raceConditionTtl !== undefined && expiresIn > 0) expiresIn += RACE_CONDITION_TTL_PADDING;
    return rescue(false, async () => {
      if (value.length > DALLI_VALUE_MAX_BYTES) throw new Error(`Value for ${key} over max size: ${DALLI_VALUE_MAX_BYTES} <= ${value.length}`);
      const exptime = sanitizeTtl(expiresIn, now());
      return options.unlessExist ? transport.add(key, value, flags, exptime) : transport.set(key, value, flags, exptime);
    });
  };

  const deleteEntry = (key: string) => rescue(false, () => transport.delete(key));

  const write = async (name: CacheName, value: MarshalValue, options: Merged) => {
    // Entry.new: expires_in.to_f + Time.now.to_f, where 0 still counts as an expiry.
    const expiresAt = options.expiresIn != null ? options.expiresIn + now() : null;
    return writeEntry(keyFor(name, options), { value, expiresAt, version: versionFor(name, options) }, options);
  };

  return {
    transport,
    async read(name, callOptions) {
      const options = merge(callOptions);
      const key = keyFor(name, options);
      const entry = await readEntry(key);
      if (!entry) return undefined;
      if (expired(entry)) {
        await deleteEntry(key);
        return undefined;
      }
      if (mismatched(entry, versionFor(name, options))) return undefined;
      return entry.value();
    },
    async write(name, value, callOptions) {
      return write(name, value, merge(callOptions));
    },
    async fetch(name, callOptions, block) {
      const options = merge(callOptions);
      const key = keyFor(name, options);
      if (!options.force) {
        let entry = await readEntry(key);
        // Store#handle_expired_entry: within race_condition_ttl of expiry, the stale value is
        // written back for race_condition_ttl more seconds while this caller regenerates it.
        if (entry && expired(entry)) {
          const raceTtl = Math.trunc(options.raceConditionTtl ?? 0);
          if (raceTtl > 0 && now() - entry.expiresAt! <= raceTtl) {
            const stale = { value: entry.value(), expiresAt: now() + raceTtl, version: entry.version };
            await writeEntry(key, stale, { ...options, expiresIn: raceTtl * 2 });
          } else await deleteEntry(key);
          entry = null;
        }
        if (entry && !mismatched(entry, versionFor(name, options))) return entry.value() as never;
      }
      const writeOptions: WriteOptions = { version: options.version, expiresIn: options.expiresIn };
      const result = await block(name, writeOptions);
      if (!(result === null && options.skipNil)) {
        const next: Merged = { ...options, version: writeOptions.version, expiresIn: writeOptions.expiresIn };
        if (writeOptions.expiresAt !== undefined) {
          delete next.expiresIn;
          next.expiresAt = writeOptions.expiresAt;
        }
        await write(name, result, merge(next));
      }
      return result;
    },
    async delete(name, callOptions) {
      return deleteEntry(keyFor(name, merge(callOptions)));
    },
    async exist(name, callOptions) {
      const options = merge(callOptions);
      const entry = await readEntry(keyFor(name, options));
      return entry !== null && !expired(entry) && !mismatched(entry, versionFor(name, options));
    },
  };
}

// The namespace production.rb and staging.rb give the store; ENV is read as Ruby's ENV.fetch.
export function railsCacheNamespace(env = railsEnv()): string | null {
  const required = (name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`key not found: "${name}"`);
    return value;
  };
  if (env === "production") return required("REVISION");
  if (env === "staging") return process.env.BRANCH_DEPLOYMENT !== undefined ? `${required("BRANCH")}-${required("REVISION")}` : required("REVISION");
  return null;
}

let singleton: RailsCache | undefined;

// config.cache_store per environment: memcached in production and staging (and development
// with tmp/caching-dev.txt), :null_store in development otherwise, and an in-memory store in
// test (Rails' :memory_store, which never shares entries with Ruby either).
export function railsCache(): RailsCache {
  if (singleton) return singleton;
  const env = railsEnv();
  let transport: CacheTransport;
  if (env === "test") transport = createMemoryTransport();
  else if (env === "development" && !existsSync(path.join(railsRoot(), "tmp/caching-dev.txt"))) transport = createNullTransport();
  else {
    const servers = process.env.MEMCACHE_SERVERS;
    if (servers === undefined) throw new Error('key not found: "MEMCACHE_SERVERS"');
    transport = createMemcachedTransport(servers.split(","));
  }
  singleton = createRailsCache({ transport, namespace: railsCacheNamespace(env) });
  return singleton;
}

export function resetRailsCacheForTesting(cache?: RailsCache): void {
  singleton = cache;
}
