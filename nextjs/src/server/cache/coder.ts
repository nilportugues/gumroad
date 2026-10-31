// What MemCacheStore puts in memcached: ActiveSupport::Cache::Coder's 7.1 entry format
// (cache_format_version = 7.1, Marshal71WithFallback + Zlib), which Dalli then Marshal.dumps
// once more as a binary String with FLAG_SERIALIZED, because MemCacheStore configures Dalli with
// `serializer: Marshal, compress: false` and never passes `raw: true` for ordinary writes.
import { deflateSync, inflateSync } from "node:zlib";

import { marshalDump, marshalLoad, MarshalRefusedError, RubyAsciiString, type MarshalValue } from "./marshal.ts";

export type CacheEntry = {
  value: MarshalValue;
  // Epoch seconds as a Ruby Float (Entry#expires_at), or null for no expiry.
  expiresAt: number | null;
  // A US-ASCII version (Integer#to_param, an empty Array#join) is stored Marshal-dumped.
  version: CacheVersion | null;
};

export type CacheVersion = string | RubyAsciiString;
// A loaded entry whose value is decoded on first use, as Coder::LazyEntry does.
export type LoadedEntry = { expiresAt: number | null; version: CacheVersion | null; value(): MarshalValue };

const SIGNATURE = Buffer.from([0x00, 0x11]);
const OBJECT_DUMP_TYPE = 0x01;
const STRING_TYPES = { "UTF-8": 0x02, BINARY: 0x03, "US-ASCII": 0x04 } as const;
const COMPRESSED_FLAG = 0x80;
const HEADER_SIZE = SIGNATURE.length + 1 + 8 + 4;

// Dalli::Protocol::ValueSerializer::FLAG_SERIALIZED and ValueCompressor::FLAG_COMPRESSED.
export const DALLI_FLAG_SERIALIZED = 0x1;
export const DALLI_FLAG_COMPRESSED = 0x2;
// Dalli's value_max_bytes default; a bigger value raises ValueOverMaxSize, which the store
// rescues into a failed write.
export const DALLI_VALUE_MAX_BYTES = 1024 * 1024;

function stringPayload(value: MarshalValue): [number, Buffer] | undefined {
  if (typeof value === "string") return [STRING_TYPES["UTF-8"], Buffer.from(value, "utf8")];
  if (value instanceof Uint8Array) return [STRING_TYPES.BINARY, Buffer.from(value)];
  if (value instanceof RubyAsciiString) return [STRING_TYPES["US-ASCII"], Buffer.from(value.value, "utf8")];
  return undefined;
}

// Coder#dump_compressed. `threshold` is Infinity when the store's :compress option is off.
export function dumpEntry(entry: CacheEntry, threshold: number): Buffer {
  let [type, payload] = stringPayload(entry.value) ?? [OBJECT_DUMP_TYPE, marshalDump(entry.value)];
  if (payload.length >= threshold) {
    const compressed = deflateSync(payload);
    if (compressed.length < payload.length) {
      payload = compressed;
      type |= COMPRESSED_FLAG;
    }
  }
  // Coder#dump_version: a version that would look like Marshal data is itself Marshal-dumped.
  const version =
    entry.version === null
      ? null
      : typeof entry.version !== "string" || entry.version.startsWith("\x04\x08")
        ? marshalDump(entry.version)
        : Buffer.from(entry.version, "utf8");
  const header = Buffer.alloc(HEADER_SIZE);
  SIGNATURE.copy(header, 0);
  header.writeUInt8(type, 2);
  header.writeDoubleLE(entry.expiresAt ?? -1.0, 3);
  header.writeInt32LE(version === null ? -1 : version.length, 11);
  return Buffer.concat([header, ...(version ? [version] : []), payload]);
}

function decodeString(type: number, payload: Buffer): MarshalValue {
  if (type === STRING_TYPES["UTF-8"]) return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  if (type === STRING_TYPES.BINARY) return payload;
  return new RubyAsciiString(payload.toString("latin1"));
}

// Coder#load. Payloads without the 7.1 signature come from older formats; only 7.0's
// (`\x00`/`\x01` + Marshal of [value, expires_at, version]) is understood.
export function loadEntry(dumped: Buffer): LoadedEntry {
  if (dumped.length < SIGNATURE.length || !dumped.subarray(0, 2).equals(SIGNATURE)) return loadEntry70(dumped);
  const type = dumped.readUInt8(2);
  const expiresAt = dumped.readDoubleLE(3);
  const versionLength = dumped.readInt32LE(11);
  let version: CacheVersion | null = null;
  if (versionLength >= 0) {
    const raw = dumped.subarray(HEADER_SIZE, HEADER_SIZE + versionLength);
    if (raw[0] === 4 && raw[1] === 8) {
      const loaded = marshalLoad(raw);
      if (typeof loaded !== "string" && !(loaded instanceof RubyAsciiString)) throw new MarshalRefusedError("a non-String entry version");
      version = loaded;
    } else version = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  }
  const payload = dumped.subarray(HEADER_SIZE + Math.max(versionLength, 0));
  let resolved: { value: MarshalValue } | undefined;
  return {
    expiresAt: expiresAt < 0 ? null : expiresAt,
    version,
    value() {
      if (!resolved) {
        const raw = type & COMPRESSED_FLAG ? inflateSync(payload) : payload;
        const base = type & ~COMPRESSED_FLAG;
        resolved = { value: base === OBJECT_DUMP_TYPE ? marshalLoad(raw) : decodeString(base, raw) };
      }
      return resolved.value;
    },
  };
}

function loadEntry70(dumped: Buffer): LoadedEntry {
  if (dumped[0] !== 0x00 && dumped[0] !== 0x01) throw new MarshalRefusedError("a cache payload in neither the 7.1 nor the 7.0 format");
  const raw = dumped[0] === 0x01 ? inflateSync(dumped.subarray(1)) : dumped.subarray(1);
  const packed = marshalLoad(raw);
  if (!Array.isArray(packed)) throw new MarshalRefusedError("a 7.0 entry that is not a packed Array");
  const [value = null, expiresAt = null, version = null] = packed;
  const expires = typeof expiresAt === "number" ? expiresAt : expiresAt === null ? null : Number((expiresAt as { value: number }).value);
  if (version !== null && typeof version !== "string" && !(version instanceof RubyAsciiString)) throw new MarshalRefusedError("a non-String entry version");
  return { expiresAt: expires, version, value: () => value };
}

// Dalli::Protocol::ValueMarshaller#store for a serialized (non-raw) value.
export function dalliStore(payload: Buffer): { value: Buffer; flags: number } {
  return { value: marshalDump(payload), flags: DALLI_FLAG_SERIALIZED };
}

// Dalli::Protocol::ValueMarshaller#retrieve, narrowed to the String that MemCacheStore stored.
export function dalliRetrieve(value: Buffer, flags: number): Buffer {
  const raw = flags & DALLI_FLAG_COMPRESSED ? inflateSync(value) : value;
  if (!(flags & DALLI_FLAG_SERIALIZED)) return raw;
  const loaded = marshalLoad(raw);
  if (loaded instanceof Uint8Array) return Buffer.from(loaded);
  if (typeof loaded === "string") return Buffer.from(loaded, "utf8");
  throw new MarshalRefusedError("a memcached value that is not a Marshal-dumped String");
}
