// What the cache store needs from memcached. `exptime` is already sanitized
// (sanitizeTtl), so a transport passes it to the server as is.
export type StoredValue = { value: Buffer; flags: number };

export type CacheTransport = {
  get(key: string): Promise<StoredValue | null>;
  // `add` stores only when the key is absent. Both resolve to whether the server stored it.
  set(key: string, value: Buffer, flags: number, exptime: number): Promise<boolean>;
  add(key: string, value: Buffer, flags: number, exptime: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  close(): Promise<void>;
};

// Dalli::Protocol::TtlSanitizer: memcached reads an exptime past 30 days as a Unix timestamp,
// so a longer interval is turned into one (unless it already is a future timestamp).
const MAX_ACCEPTABLE_EXPIRATION_INTERVAL = 30 * 24 * 60 * 60;

export function sanitizeTtl(ttl: number, nowSeconds: number): number {
  const ttlI = Math.trunc(ttl);
  if (ttlI <= MAX_ACCEPTABLE_EXPIRATION_INTERVAL) return ttlI;
  const now = Math.floor(nowSeconds);
  return ttlI > now ? ttlI : now + ttlI;
}

// memcached's own reading of an exptime, for the in-memory transport.
function expiresAtSeconds(exptime: number, nowSeconds: number): number | null {
  if (exptime === 0) return null;
  return exptime <= MAX_ACCEPTABLE_EXPIRATION_INTERVAL ? Math.floor(nowSeconds) + exptime : exptime;
}

export type MemoryTransport = CacheTransport & {
  entries: Map<string, StoredValue & { exptime: number; expiresAt: number | null }>;
};

// A memcached stand-in for tests and Rails' test environment (which uses :memory_store, so it
// never shares state with Ruby). Expiry follows memcached's whole-second clock.
export function createMemoryTransport(now: () => number = () => Date.now() / 1000): MemoryTransport {
  const entries: MemoryTransport["entries"] = new Map();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Math.floor(now())) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const store = (key: string, value: Buffer, flags: number, exptime: number) => {
    entries.set(key, { value: Buffer.from(value), flags, exptime, expiresAt: expiresAtSeconds(exptime, now()) });
    return true;
  };
  return {
    entries,
    async get(key) {
      const entry = live(key);
      return entry ? { value: Buffer.from(entry.value), flags: entry.flags } : null;
    },
    async set(key, value, flags, exptime) {
      return store(key, value, flags, exptime);
    },
    async add(key, value, flags, exptime) {
      return live(key) ? false : store(key, value, flags, exptime);
    },
    async delete(key) {
      return live(key) ? entries.delete(key) : false;
    },
    async close() {},
  };
}

// :null_store (development without tmp/caching-dev.txt): nothing is ever stored.
export function createNullTransport(): CacheTransport {
  return {
    get: async () => null,
    set: async () => true,
    add: async () => true,
    delete: async () => false,
    close: async () => {},
  };
}
