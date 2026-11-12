// Replays scripts/golden/rails-cache.rb (real Marshal, ActiveSupport::Cache, Dalli and
// ActiveRecord) against the Node port.
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

import pako from "pako";
import { describe, expect, it } from "vitest";

import { dalliRetrieve, dalliStore, dumpEntry, loadEntry } from "./coder.ts";
import { buildRing, parseServer } from "./dalli-ring.ts";
import { type CacheName, expandedVersion, normalizeKey, relationCacheKeyWithVersion, versionText } from "./keys.ts";
import {
  MarshalRefusedError,
  RubyAsciiString,
  RubyFloat,
  RubySymbol,
  RubyTimeWithZone,
  marshalDump,
  marshalLoad,
  type MarshalValue,
} from "./marshal.ts";
import { type CacheOptions, createRailsCache, railsCacheNamespace } from "./rails-cache.ts";
import { type CacheTransport, createMemoryTransport, sanitizeTtl } from "./transport.ts";

type Desc =
  | { t: "nil" }
  | { t: "bool"; v: boolean }
  | { t: "int" | "str" | "bin" | "ascii" | "sym" | "float"; v: string }
  | { t: "twz"; sec: string; nsec: number }
  | { t: "arr"; v: Desc[] }
  | { t: "hash"; v: [Desc, Desc][] };

type Golden = {
  marshal: { value: Desc; dump: string; load: Desc }[];
  deflate: { input: string; output: string }[];
  entries: {
    value: Desc;
    expires_at: number | null;
    version: string | null;
    threshold: number | null;
    coder: string;
    dalli: string;
    flags: number;
    loaded: { value: Desc; expires_at: number | null; version: string | null };
  }[];
  keys: { name: CacheNameDesc; namespace: string | null; key: string; version: string | null }[];
  relations: { model: string; sql: string; size: number; max_updated_at: string | null; key: string }[];
  ttls: { ttl: number; now: number; sanitized: number }[];
  rings: { servers: string[]; keys: Record<string, string> }[];
  flow: {
    now: number;
    op: "write" | "read" | "fetch" | "delete" | "exist";
    name: CacheNameDesc;
    options: CacheOptions;
    value?: Desc;
    result: Desc | boolean | "miss";
    block_ran: boolean;
    ops: (string | number)[][];
    memcached: Record<string, { value: string; flags: number; exptime: number }>;
  }[];
};
type KeyedDesc = { cacheKey: string; cacheVersion: string | null };
type CacheNameDesc = string | KeyedDesc | (string | number | KeyedDesc)[];

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/rails-cache.golden.json", import.meta.url), "utf8"),
) as Golden;

function floatFromHex(hex: string): number {
  return Buffer.from(hex, "hex").readDoubleBE(0);
}

function build(desc: Desc): MarshalValue {
  switch (desc.t) {
    case "nil":
      return null;
    case "bool":
      return desc.v;
    case "int": {
      const value = BigInt(desc.v);
      return Number.isSafeInteger(Number(value)) ? Number(value) : value;
    }
    case "float":
      return new RubyFloat(floatFromHex(desc.v));
    case "str":
      return desc.v;
    case "bin":
      return Buffer.from(desc.v, "hex");
    case "ascii":
      return new RubyAsciiString(desc.v);
    case "sym":
      return new RubySymbol(desc.v);
    case "twz":
      return new RubyTimeWithZone(Number(desc.sec), desc.nsec);
    case "arr":
      return desc.v.map(build);
    case "hash":
      return new Map(desc.v.map(([key, value]) => [build(key), build(value)]));
  }
}

function toDesc(value: MarshalValue | undefined): Desc {
  if (value === null || value === undefined) return { t: "nil" };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "bigint") return { t: "int", v: value.toString() };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { t: "int", v: String(value) };
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(value);
    return { t: "float", v: buffer.toString("hex") };
  }
  if (value instanceof RubyFloat) {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(value.value);
    return { t: "float", v: buffer.toString("hex") };
  }
  if (typeof value === "string") return { t: "str", v: value };
  if (value instanceof Uint8Array) return { t: "bin", v: Buffer.from(value).toString("hex") };
  if (value instanceof RubyAsciiString) return { t: "ascii", v: value.value };
  if (value instanceof RubySymbol) return { t: "sym", v: value.name };
  if (value instanceof RubyTimeWithZone) return { t: "twz", sec: String(value.seconds), nsec: value.nanoseconds };
  if (Array.isArray(value)) return { t: "arr", v: value.map(toDesc) };
  if (value instanceof Map)
    return { t: "hash", v: [...value].map(([key, element]) => [toDesc(key), toDesc(element)] as [Desc, Desc]) };
  return {
    t: "hash",
    v: Object.entries(value).map(([key, element]) => [toDesc(key), toDesc(element)] as [Desc, Desc]),
  };
}

function buildName(name: CacheNameDesc): CacheName {
  if (Array.isArray(name))
    return name.map((part) =>
      typeof part === "object" ? { cacheKey: part.cacheKey, cacheVersion: part.cacheVersion } : part,
    );
  return name;
}

// NaN has several bit patterns; Ruby and V8 both use the canonical quiet NaN here.
describe("Marshal subset", () => {
  it.each(golden.marshal.map((c) => [JSON.stringify(c.value).slice(0, 80), c] as const))(
    "dumps and loads %s",
    (_name, c) => {
      expect(marshalDump(build(c.value)).toString("hex")).toBe(c.dump);
      expect(toDesc(marshalLoad(Buffer.from(c.dump, "hex")))).toEqual(c.load);
    },
  );

  it("dumps plain JS numbers and objects as Ruby would", () => {
    expect(marshalDump([3, 40, 170]).toString("hex")).toBe(
      golden.marshal.find((c) => JSON.stringify(c.value) === JSON.stringify(toDesc([3, 40, 170])))!.dump,
    );
    expect(marshalDump({ a: 1, b: [1, 2] })).toEqual(
      marshalDump(
        new Map<MarshalValue, MarshalValue>([
          ["a", 1],
          ["b", [1, 2]],
        ]),
      ),
    );
    expect(marshalDump(12345.678)).toEqual(marshalDump(new RubyFloat(12345.678)));
  });

  it("refuses a TimeWithZone it cannot reproduce", () => {
    expect(() => new RubyTimeWithZone(Date.UTC(1899, 11, 31) / 1000)).toThrow(MarshalRefusedError);
    expect(() => new RubyTimeWithZone(Date.UTC(10000, 0, 1) / 1000)).toThrow(MarshalRefusedError);
    expect(() => new RubyTimeWithZone(0, 1e9)).toThrow(MarshalRefusedError);
    expect(() => new RubyTimeWithZone(1.5)).toThrow(MarshalRefusedError);
    const dumped = marshalDump(new RubyTimeWithZone(1_761_955_200, 789)).toString("hex");
    // The zone name changed from UTC to another three-letter name, and a truncation.
    expect(() => marshalLoad(Buffer.from(dumped.replace(/555443063a064546/u, "555453063a064546"), "hex"))).toThrow(MarshalRefusedError);
    expect(() => marshalLoad(Buffer.from(dumped.slice(0, -4), "hex"))).toThrow(MarshalRefusedError);
    const sharedTime = new RubyTimeWithZone(1, 1);
    expect(() => marshalDump([sharedTime, sharedTime])).toThrow(MarshalRefusedError);
  });

  it("refuses what it does not port", () => {
    expect(() => marshalDump(new Date() as never)).toThrow(MarshalRefusedError);
    const shared = [1];
    expect(() => marshalDump([shared, shared])).toThrow(MarshalRefusedError);
    // An ActiveSupport::TimeWithZone-like object ("o:"), a Hash with a default ("}"), a Struct ("S").
    for (const hex of ["04086f3a0954696d6500", "04087d0069066906", "0408533a0653"]) {
      expect(() => marshalLoad(Buffer.from(hex, "hex"))).toThrow(MarshalRefusedError);
    }
    // A String with a non-UTF-8 encoding ivar.
    expect(() => marshalLoad(Buffer.from("040849220661063a0d656e636f64696e67220f53686966745f4a4953", "hex"))).toThrow(
      MarshalRefusedError,
    );
  });
});

// The coder deflates with pako. Node's own zlib (Chromium's build) is checked only to show why:
// its streams inflate on both sides but are not always the bytes Ruby's zlib writes.
describe("Zlib::Deflate.deflate", () => {
  it.each(golden.deflate.map((c, i) => [i, c] as const))("case %i is byte-identical to Ruby", (_i, c) => {
    const input = Buffer.from(c.input, "hex");
    expect(Buffer.from(pako.deflate(input)).toString("hex")).toBe(c.output);
    expect(inflateSync(deflateSync(input))).toEqual(input);
  });

  it("includes inputs where node:zlib differs from Ruby", () => {
    expect(golden.deflate.some((c) => deflateSync(Buffer.from(c.input, "hex")).toString("hex") !== c.output)).toBe(
      true,
    );
  });
});

describe("ActiveSupport::Cache::Coder (7.1) and Dalli's value", () => {
  it.each(golden.entries.map((c, i) => [i, c] as const))("entry %i", (_i, c) => {
    const entry = { value: build(c.value), expiresAt: c.expires_at, version: c.version };
    const dumped = dumpEntry(entry, c.threshold ?? Infinity);
    expect(dumped.toString("hex")).toBe(c.coder);
    const wrapped = dalliStore(dumped);
    expect(wrapped.flags).toBe(c.flags);
    expect(wrapped.value.toString("hex")).toBe(c.dalli);

    const loaded = loadEntry(dalliRetrieve(Buffer.from(c.dalli, "hex"), c.flags));
    expect({ value: toDesc(loaded.value()), expires_at: loaded.expiresAt, version: loaded.version }).toEqual(c.loaded);
  });
});

describe("keys", () => {
  it.each(golden.keys.map((c) => [`${c.namespace}:${JSON.stringify(c.name).slice(0, 60)}`, c] as const))(
    "%s",
    (_name, c) => {
      const name = buildName(c.name);
      expect(normalizeKey(name, c.namespace)).toBe(c.key);
      const version = expandedVersion(name);
      expect(version === null ? null : versionText(version)).toBe(c.version);
    },
  );

  it.each(golden.relations.map((c) => [c.sql, c] as const))("relation cache_key_with_version for %s", (_sql, c) => {
    const max = c.max_updated_at
      ? { time: new Date(c.max_updated_at), micros: Number(c.max_updated_at.slice(20, 26)) }
      : null;
    expect(relationCacheKeyWithVersion(c.model, c.sql, c.size, max)).toBe(c.key);
  });
});

describe("Dalli", () => {
  it.each(golden.ttls.map((c) => [c.ttl, c] as const))("sanitizes TTL %i", (_ttl, c) => {
    expect(sanitizeTtl(c.ttl, c.now)).toBe(c.sanitized);
  });

  it.each(golden.rings.map((c) => [c.servers.join(","), c] as const))("ring %s picks Dalli's server", (_servers, c) => {
    const ring = buildRing(c.servers.map(parseServer));
    for (const [key, server] of Object.entries(c.keys)) expect(ring.serverFor(key).name).toBe(server);
  });
});

// Records what reaches memcached in the shape the Ruby script's fake server records it.
function recordingTransport(inner: CacheTransport, record: (op: (string | number)[]) => void): CacheTransport {
  return {
    async get(key) {
      record(["get", key]);
      return inner.get(key);
    },
    async set(key, value, flags, exptime) {
      record(["set", key, flags, exptime, value.toString("hex")]);
      return inner.set(key, value, flags, exptime);
    },
    async add(key, value, flags, exptime) {
      record(["add", key, flags, exptime, value.toString("hex")]);
      return inner.add(key, value, flags, exptime);
    },
    async delete(key) {
      record(["delete", key]);
      return inner.delete(key);
    },
    close: () => inner.close(),
  };
}

describe("MemCacheStore semantics", () => {
  it("replays the Ruby store flow step by step", async () => {
    let now = golden.flow[0]!.now;
    const memory = createMemoryTransport(() => now);
    let ops: (string | number)[][] = [];
    const store = createRailsCache({
      transport: recordingTransport(memory, (op) => ops.push(op)),
      namespace: "rev123",
      now: () => now,
    });

    for (const [index, step] of golden.flow.entries()) {
      now = step.now;
      ops = [];
      const name = buildName(step.name);
      let blockRan = false;
      let result: Desc | boolean | "miss";
      switch (step.op) {
        case "write":
          result = await store.write(name, build(step.value!), step.options);
          break;
        case "read": {
          const found = await store.read(name, step.options);
          result = found === undefined ? "miss" : toDesc(found);
          break;
        }
        case "fetch":
          result = toDesc(
            await store.fetch(name, step.options, () => {
              blockRan = true;
              return build(step.value!);
            }),
          );
          break;
        case "delete":
          result = await store.delete(name, step.options);
          break;
        case "exist":
          result = await store.exist(name, step.options);
          break;
      }
      const label = `step ${index} (${step.op} ${JSON.stringify(step.name).slice(0, 40)})`;
      expect({ label, result, blockRan, ops }).toEqual({
        label,
        result: step.result,
        blockRan: step.block_ran,
        ops: step.ops,
      });
      const state = Object.fromEntries(
        [...memory.entries]
          .filter(([, entry]) => entry.expiresAt === null || entry.expiresAt > Math.floor(now))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, entry]) => [
            key,
            { value: entry.value.toString("hex"), flags: entry.flags, exptime: entry.exptime },
          ]),
      );
      expect(state).toEqual(step.memcached);
    }
  });

  it("raises on a negative expiry, as raise_on_invalid_cache_expiration_time does", async () => {
    const store = createRailsCache({ transport: createMemoryTransport(), namespace: null });
    await expect(store.write("k", 1, { expiresIn: -1 })).rejects.toThrow("cannot be negative");
  });

  it("reads a transport failure as a miss and a failed write", async () => {
    const failing: CacheTransport = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
      add: () => Promise.reject(new Error("down")),
      delete: () => Promise.reject(new Error("down")),
      close: async () => {},
    };
    const errors: unknown[] = [];
    const store = createRailsCache({ transport: failing, namespace: null, onError: (error) => errors.push(error) });
    expect(await store.read("k")).toBeUndefined();
    expect(await store.write("k", 1)).toBe(false);
    expect(await store.fetch("k", {}, () => 7)).toBe(7);
    expect(errors).toHaveLength(4);
  });
});

describe("railsCacheNamespace", () => {
  it("follows production.rb and staging.rb", () => {
    const saved = { ...process.env };
    try {
      process.env.REVISION = "abc123";
      delete process.env.BRANCH_DEPLOYMENT;
      expect(railsCacheNamespace("production")).toBe("abc123");
      expect(railsCacheNamespace("staging")).toBe("abc123");
      // Ruby's `ENV["BRANCH_DEPLOYMENT"] &&` is true for any value, even an empty one.
      process.env.BRANCH_DEPLOYMENT = "";
      process.env.BRANCH = "feature-x";
      expect(railsCacheNamespace("staging")).toBe("feature-x-abc123");
      expect(railsCacheNamespace("production")).toBe("abc123");
      expect(railsCacheNamespace("development")).toBeNull();
      delete process.env.REVISION;
      expect(() => railsCacheNamespace("production")).toThrow('key not found: "REVISION"');
    } finally {
      process.env = saved;
    }
  });
});
