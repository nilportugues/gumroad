// The subset of Ruby's Marshal (format 4.8, Ruby 3.4) that Rails.cache values from Node need:
// nil, booleans, Integer, Float, String (UTF-8, binary, US-ASCII), Symbol, Array and Hash.
// ActiveSupport::TimeWithZone in the app's UTC zone (`Time.current`) is the one object accepted.
// Anything else (other objects, Structs, Time, default-valued Hashes, other encodings) is refused on
// both sides. __fixtures__/rails-cache.golden.json pins every branch against Marshal.dump.
//
// Values: a RubyTimeWithZone is `Time.current` (UTC, to the nanosecond), a JS number that is an integer is a Ruby Integer (use bigint past 2^53), any other
// number is a Float, and RubyFloat forces a Float (1.0). A JS string is a UTF-8 String, a
// Uint8Array a binary String. Hashes load as Map, keeping Ruby's order and non-String keys.
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export { RubyFloat };

export class RubySymbol {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class RubyAsciiString {
  readonly value: string;
  constructor(value: string) {
    if (!/^[\x00-\x7f]*$/u.test(value)) throw new MarshalRefusedError("US-ASCII string with non-ASCII characters");
    this.value = value;
  }
}

// ActiveSupport::TimeWithZone in the UTC zone `config.time_zone` leaves unset: `seconds` is the Unix time floored
// (an integer, between 1900-01-01 and the end of 9999), `nanoseconds` the part of the second.
export class RubyTimeWithZone {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds = 0) {
    if (!Number.isInteger(seconds) || seconds < TIME_MIN_SECONDS || seconds > TIME_MAX_SECONDS)
      throw new MarshalRefusedError(`a Time at ${seconds}s (supported: 1900 to 9999)`);
    if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999_999_999)
      throw new MarshalRefusedError(`a Time with ${nanoseconds}ns`);
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static fromMilliseconds(ms: number): RubyTimeWithZone {
    const seconds = Math.floor(ms / 1000);
    return new RubyTimeWithZone(seconds, Math.round((ms - seconds * 1000) * 1_000_000));
  }

  // Epoch seconds as a Float, as `Time#to_f` (nanoseconds are lost past a microsecond or so, as in Ruby).
  toFloat(): number {
    return this.seconds + this.nanoseconds / 1e9;
  }
}

const TIME_MIN_SECONDS = Date.UTC(1900, 0, 1) / 1000;
const TIME_MAX_SECONDS = Date.UTC(10000, 0, 1) / 1000 - 1;

export type MarshalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | RubyFloat
  | RubySymbol
  | RubyAsciiString
  | RubyTimeWithZone
  | MarshalValue[]
  | Map<MarshalValue, MarshalValue>
  | { [key: string]: MarshalValue };

export class MarshalRefusedError extends Error {
  constructor(what: string) {
    super(`Marshal subset does not support ${what}`);
    this.name = "MarshalRefusedError";
  }
}

const FIXNUM_MIN = -(2 ** 30);
const FIXNUM_MAX = 2 ** 30 - 1;

// Ruby's flonum test (rb_float_new_inline): such Floats are immediates, so a repeated value is
// the same object and Marshal writes it as an `@` link.
function isFlonum(value: number): boolean {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  if (bits === 0n) return true;
  const top = Number((bits >> 60n) & 7n);
  return bits !== 0x3000000000000000n && (top === 3 || top === 4);
}

// marshal.c w_float: shortest round-trip digits, laid out by its own rules.
export function marshalFloatText(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, exponent] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decpt = Number(exponent) + 1;
  const sign = value < 0 ? "-" : "";
  if (decpt < -3 || decpt > digits.length) {
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${decpt - 1}`;
  }
  if (decpt > 0) return `${sign}${digits.slice(0, decpt)}${digits.length > decpt ? `.${digits.slice(decpt)}` : ""}`;
  return `${sign}0.${"0".repeat(-decpt)}${digits}`;
}

function wLong(out: number[], n: number): void {
  if (n === 0) out.push(0);
  else if (n > 0 && n < 123) out.push(n + 5);
  else if (n < 0 && n > -124) out.push((n - 5) & 0xff);
  else {
    const bytes: number[] = [];
    let x = n;
    for (let i = 1; i <= 4; i++) {
      bytes.push(x & 0xff);
      x >>= 8;
      if (x === 0) return void out.push(i, ...bytes);
      if (x === -1) return void out.push(-i & 0xff, ...bytes);
    }
    throw new MarshalRefusedError(`length ${n}`);
  }
}

type DumpState = {
  out: number[];
  symbols: Map<string, number>;
  objects: number;
  flonums: Map<number, number>;
  seen: Set<object>;
  // Object indexes of the "UTC" strings every TimeWithZone shares (the Time's zone ivar and the zone name).
  utcStrings: { zone?: number; name?: number };
};

function wBytes(state: DumpState, bytes: Uint8Array): void {
  wLong(state.out, bytes.length);
  for (const byte of bytes) state.out.push(byte);
}

const utf8 = new TextEncoder();
const isAscii = (text: string) => /^[\x00-\x7f]*$/u.test(text);

function wSymbol(state: DumpState, name: string): void {
  const index = state.symbols.get(name);
  if (index !== undefined) {
    state.out.push(0x3b); // ';'
    return wLong(state.out, index);
  }
  const ascii = isAscii(name);
  if (!ascii) state.out.push(0x49); // 'I'
  state.out.push(0x3a); // ':'
  wBytes(state, utf8.encode(name));
  state.symbols.set(name, state.symbols.size);
  if (!ascii) {
    wLong(state.out, 1);
    wSymbol(state, "E");
    state.out.push(0x54); // true
  }
}

function wString(state: DumpState, bytes: Uint8Array, encoding: "UTF-8" | "BINARY" | "US-ASCII"): void {
  state.objects++;
  if (encoding !== "BINARY") state.out.push(0x49);
  state.out.push(0x22); // '"'
  wBytes(state, bytes);
  if (encoding !== "BINARY") {
    wLong(state.out, 1);
    wSymbol(state, "E");
    state.out.push(encoding === "UTF-8" ? 0x54 : 0x46);
  }
}

function wInteger(state: DumpState, value: bigint): void {
  if (value >= BigInt(FIXNUM_MIN) && value <= BigInt(FIXNUM_MAX)) {
    state.out.push(0x69); // 'i'
    return wLong(state.out, Number(value));
  }
  state.objects++;
  state.out.push(0x6c, value < 0n ? 0x2d : 0x2b); // 'l', '-' / '+'
  let magnitude = value < 0n ? -value : value;
  const bytes: number[] = [];
  while (magnitude > 0n) {
    bytes.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  if (bytes.length % 2) bytes.push(0);
  wLong(state.out, bytes.length / 2);
  state.out.push(...bytes);
}

function wFloat(state: DumpState, value: number): void {
  if (isFlonum(value)) {
    const link = state.flonums.get(value);
    if (link !== undefined) {
      state.out.push(0x40); // '@'
      return wLong(state.out, link);
    }
    state.flonums.set(value, state.objects);
  }
  state.objects++;
  state.out.push(0x66); // 'f'
  wBytes(state, utf8.encode(marshalFloatText(value)));
}

function remember(state: DumpState, value: object): void {
  // Ruby would write a shared or cyclic reference as an `@` link; not needed, so refused.
  if (state.seen.has(value)) throw new MarshalRefusedError("shared or cyclic references");
  state.seen.add(value);
  state.objects++;
}

// Time#_dump (marshal.c time_mdump): two little-endian words, UTC flag and calendar fields.
function timeBytes(time: RubyTimeWithZone): Uint8Array {
  const date = new Date(time.seconds * 1000);
  const microseconds = Math.floor(time.nanoseconds / 1000);
  const p =
    (1 << 31) |
    (1 << 30) |
    ((date.getUTCFullYear() - 1900) << 14) |
    (date.getUTCMonth() << 10) |
    (date.getUTCDate() << 5) |
    date.getUTCHours();
  const s = (date.getUTCMinutes() << 26) | (date.getUTCSeconds() << 20) | microseconds;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setUint32(0, p >>> 0, true);
  bytes.setUint32(4, s >>> 0, true);
  return new Uint8Array(bytes.buffer);
}

// Ruby keeps one frozen "UTC" String per role, so a second TimeWithZone in a payload links to the first one's.
function wSharedUtc(state: DumpState, role: "zone" | "name", encoding: "UTF-8" | "US-ASCII"): void {
  const index = state.utcStrings[role];
  if (index !== undefined) {
    state.out.push(0x40); // '@'
    return wLong(state.out, index);
  }
  state.utcStrings[role] = state.objects;
  wString(state, utf8.encode("UTC"), encoding);
}

// ActiveSupport::TimeWithZone#marshal_dump is [utc, zone name, time]; in UTC `time` is the same Time as `utc`,
// so the third element is an `@` link to it. A Time is remembered after its ivars (marshal.c w_object).
function wTimeWithZone(state: DumpState, time: RubyTimeWithZone): void {
  remember(state, time);
  state.out.push(0x55); // 'U'
  wSymbol(state, "ActiveSupport::TimeWithZone");
  state.objects++; // the marshal_dump Array
  state.out.push(0x5b);
  wLong(state.out, 3);
  const sub = time.nanoseconds % 1000;
  state.out.push(0x49, 0x75); // 'I', 'u'
  wSymbol(state, "Time");
  wBytes(state, timeBytes(time));
  wLong(state.out, sub === 0 ? 1 : 4);
  if (sub !== 0) {
    wSymbol(state, "nano_num");
    wInteger(state, BigInt(sub));
    wSymbol(state, "nano_den");
    wInteger(state, 1n);
    wSymbol(state, "submicro");
    const digits = String(sub).padStart(3, "0");
    // Packed BCD, with the trailing zero byte left off when the last digit is 0.
    const packed = [(Number(digits[0]) << 4) | Number(digits[1]), Number(digits[2]) << 4];
    wString(state, Uint8Array.from(sub % 10 === 0 ? packed.slice(0, 1) : packed), "BINARY");
  }
  wSymbol(state, "zone");
  wSharedUtc(state, "zone", "US-ASCII");
  const timeIndex = state.objects++;
  wSharedUtc(state, "name", "UTF-8");
  state.out.push(0x40); // '@'
  wLong(state.out, timeIndex);
}

function wObject(state: DumpState, value: MarshalValue): void {
  if (value === null) return void state.out.push(0x30);
  if (value === true) return void state.out.push(0x54);
  if (value === false) return void state.out.push(0x46);
  if (typeof value === "bigint") return wInteger(state, value);
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Object.is(value, -0)) {
      if (!Number.isSafeInteger(value)) throw new MarshalRefusedError(`integer ${value} past 2^53 (pass a bigint)`);
      return wInteger(state, BigInt(value));
    }
    return wFloat(state, value);
  }
  if (value instanceof RubyFloat) return wFloat(state, value.value);
  if (typeof value === "string") return wString(state, utf8.encode(value), "UTF-8");
  if (value instanceof Uint8Array) return wString(state, value, "BINARY");
  if (value instanceof RubyAsciiString) return wString(state, utf8.encode(value.value), "US-ASCII");
  if (value instanceof RubySymbol) return wSymbol(state, value.name);
  if (value instanceof RubyTimeWithZone) return wTimeWithZone(state, value);
  if (Array.isArray(value)) {
    remember(state, value);
    state.out.push(0x5b); // '['
    wLong(state.out, value.length);
    for (const element of value) wObject(state, element);
    return;
  }
  if (value instanceof Map) {
    remember(state, value);
    state.out.push(0x7b); // '{'
    wLong(state.out, value.size);
    for (const [key, element] of value) {
      wObject(state, key);
      wObject(state, element);
    }
    return;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    remember(state, value);
    const entries = Object.entries(value);
    state.out.push(0x7b);
    wLong(state.out, entries.length);
    for (const [key, element] of entries) {
      wObject(state, key);
      wObject(state, element);
    }
    return;
  }
  throw new MarshalRefusedError(`a ${Object.prototype.toString.call(value)} value`);
}

export function marshalDump(value: MarshalValue): Buffer {
  const state: DumpState = {
    out: [4, 8],
    symbols: new Map(),
    objects: 0,
    flonums: new Map(),
    seen: new Set(),
    utcStrings: {},
  };
  wObject(state, value);
  return Buffer.from(state.out);
}

type LoadState = { bytes: Uint8Array; pos: number; symbols: (string | undefined)[]; objects: MarshalValue[] };

function byte(state: LoadState): number {
  if (state.pos >= state.bytes.length) throw new MarshalRefusedError("truncated data (marshal data too short)");
  return state.bytes[state.pos++]!;
}

function rLong(state: LoadState): number {
  const c = (byte(state) << 24) >> 24;
  if (c === 0) return 0;
  if (c > 0) {
    if (c > 4) return c - 5;
    let x = 0;
    for (let i = 0; i < c; i++) x += byte(state) * 2 ** (8 * i);
    return x;
  }
  if (c < -4) return c + 5;
  let x = -1;
  for (let i = 0; i < -c; i++) {
    x &= ~(0xff << (8 * i));
    x |= byte(state) << (8 * i);
  }
  return x;
}

function rBytes(state: LoadState): Uint8Array {
  const length = rLong(state);
  if (state.pos + length > state.bytes.length) throw new MarshalRefusedError("truncated data (marshal data too short)");
  const slice = state.bytes.subarray(state.pos, state.pos + length);
  state.pos += length;
  return slice;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function rSymbol(state: LoadState): string {
  const type = byte(state);
  if (type === 0x3b) {
    const name = state.symbols[rLong(state)];
    if (name === undefined) throw new MarshalRefusedError("a dangling symbol link");
    return name;
  }
  if (type === 0x3a) return rSymbolBody(state, false);
  if (type === 0x49 && byte(state) === 0x3a) return rSymbolBody(state, true);
  throw new MarshalRefusedError(`symbol type byte 0x${type.toString(16)}`);
}

function rSymbolBody(state: LoadState, withEncoding: boolean): string {
  const raw = rBytes(state);
  const index = state.symbols.length;
  state.symbols.push(undefined);
  if (withEncoding) readEncoding(state);
  const name = strictUtf8.decode(raw);
  state.symbols[index] = name;
  return name;
}

// The encoding ivar on a String or Symbol: only `E => true` (UTF-8) and `E => false`
// (US-ASCII) are accepted.
function readEncoding(state: LoadState): "UTF-8" | "US-ASCII" {
  if (rLong(state) !== 1) throw new MarshalRefusedError("strings with instance variables");
  if (rSymbol(state) !== "E")
    throw new MarshalRefusedError("strings in encodings other than UTF-8, US-ASCII and binary");
  const flag = byte(state);
  if (flag === 0x54) return "UTF-8";
  if (flag === 0x46) return "US-ASCII";
  throw new MarshalRefusedError("an unexpected encoding flag");
}

function register<T extends MarshalValue>(state: LoadState, value: T): T {
  state.objects.push(value);
  return value;
}

function rInteger(state: LoadState): number {
  if (byte(state) !== 0x69) throw new MarshalRefusedError("a Time ivar that is not a small Integer");
  return rLong(state);
}

// The Time inside a TimeWithZone: `Iu:\tTime` + 8 bytes + ivars. It is registered after its ivars (marshal.c).
function rTime(state: LoadState): RubyTimeWithZone {
  if (byte(state) !== 0x49 || byte(state) !== 0x75 || rSymbol(state) !== "Time")
    throw new MarshalRefusedError("a TimeWithZone member that is not a Time");
  const raw = rBytes(state);
  if (raw.length !== 8) throw new MarshalRefusedError("a Time of an unknown encoding");
  const view = new DataView(raw.buffer, raw.byteOffset, 8);
  const p = view.getUint32(0, true);
  const s = view.getUint32(4, true);
  if (p >>> 31 !== 1 || ((p >>> 30) & 1) !== 1) throw new MarshalRefusedError("a Time that is not UTC");
  const year = ((p >>> 14) & 0xffff) + 1900;
  if (year > 9999) throw new MarshalRefusedError("a Time past year 9999");
  const microseconds = s & 0xfffff;
  const seconds = Date.UTC(year, (p >>> 10) & 0xf, (p >>> 5) & 0x1f, p & 0x1f, s >>> 26, (s >>> 20) & 0x3f) / 1000;
  let sub = 0;
  let zoneSeen = false;
  const ivars = rLong(state);
  for (let i = 0; i < ivars; i++) {
    const name = rSymbol(state);
    if (name === "nano_num") sub = rInteger(state);
    else if (name === "nano_den") {
      if (rInteger(state) !== 1) throw new MarshalRefusedError("a Time with sub-nanosecond precision");
    } else if (name === "submicro") {
      if (byte(state) !== 0x22) throw new MarshalRefusedError("a submicro that is not a String");
      state.objects.push(null);
      const digits = rBytes(state);
      const expected = String(sub).padStart(3, "0");
      const text = `${digits[0]! >> 4}${digits[0]! & 15}${(digits[1] ?? 0) >> 4}`;
      if (digits.length < 1 || digits.length > 2 || text !== expected || (digits.length === 1) !== (sub % 10 === 0))
        throw new MarshalRefusedError("a Time whose submicro disagrees with nano_num");
    } else if (name === "zone") {
      const kind = byte(state);
      if (kind === 0x40) {
        const linked = state.objects[rLong(state)];
        if (!(linked instanceof RubyAsciiString) || linked.value !== "UTC")
          throw new MarshalRefusedError("a Time zone link to anything but UTC");
      } else {
        if (kind !== 0x49 || byte(state) !== 0x22) throw new MarshalRefusedError("a Time zone that is not a String");
        const zone = Buffer.from(rBytes(state)).toString("latin1");
        if (readEncoding(state) !== "US-ASCII" || zone !== "UTC")
          throw new MarshalRefusedError(`a Time in zone ${zone}`);
        state.objects.push(new RubyAsciiString(zone));
      }
      zoneSeen = true;
    } else throw new MarshalRefusedError(`a Time with the ivar ${name}`);
  }
  if (!zoneSeen) throw new MarshalRefusedError("a Time without a zone");
  return new RubyTimeWithZone(seconds, microseconds * 1000 + sub);
}

function rTimeWithZone(state: LoadState): RubyTimeWithZone {
  if (rSymbol(state) !== "ActiveSupport::TimeWithZone")
    throw new MarshalRefusedError("a user-marshalled object other than TimeWithZone");
  const index = state.objects.length;
  state.objects.push(null);
  if (byte(state) !== 0x5b || rLong(state) !== 3)
    throw new MarshalRefusedError("a TimeWithZone that is not [utc, zone, time]");
  state.objects.push(null);
  const time = rTime(state);
  const timeIndex = state.objects.length;
  state.objects.push(time);
  if (rObject(state) !== "UTC") throw new MarshalRefusedError("a TimeWithZone outside the UTC zone");
  if (rObject(state) !== time || state.objects[timeIndex] !== time)
    throw new MarshalRefusedError("a TimeWithZone whose local time is not its UTC time");
  state.objects[index] = time;
  return time;
}

function rObject(state: LoadState): MarshalValue {
  const type = byte(state);
  switch (type) {
    case 0x30:
      return null;
    case 0x54:
      return true;
    case 0x46:
      return false;
    case 0x69:
      return rLong(state);
    case 0x3a:
    case 0x3b:
      state.pos--;
      return new RubySymbol(rSymbol(state));
    case 0x40: {
      const index = rLong(state);
      if (index >= state.objects.length) throw new MarshalRefusedError("a dangling object link");
      return state.objects[index]!;
    }
    case 0x6c: {
      const sign = byte(state);
      const length = rLong(state) * 2;
      if (state.pos + length > state.bytes.length)
        throw new MarshalRefusedError("truncated data (marshal data too short)");
      const raw = state.bytes.subarray(state.pos, state.pos + length);
      state.pos += length;
      let magnitude = 0n;
      for (let i = raw.length - 1; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(raw[i]!);
      const value = sign === 0x2d ? -magnitude : magnitude;
      return register(
        state,
        Number.isSafeInteger(Number(value)) && BigInt(Number(value)) === value ? Number(value) : value,
      );
    }
    case 0x66: {
      const text = new TextDecoder().decode(rBytes(state));
      const value = text === "inf" ? Infinity : text === "-inf" ? -Infinity : text === "nan" ? NaN : Number(text);
      return register(
        state,
        Number.isInteger(value) || !Number.isFinite(value) || Object.is(value, -0) ? new RubyFloat(value) : value,
      );
    }
    case 0x22:
      return register(state, Buffer.from(rBytes(state)));
    case 0x49: {
      const inner = byte(state);
      if (inner === 0x3a) return new RubySymbol(rSymbolBody(state, true));
      if (inner !== 0x22) throw new MarshalRefusedError("instance variables on anything but a String or Symbol");
      const index = state.objects.length;
      state.objects.push(null);
      const raw = rBytes(state);
      const encoding = readEncoding(state);
      const text = strictUtf8.decode(raw);
      const value = encoding === "UTF-8" ? text : new RubyAsciiString(text);
      state.objects[index] = value;
      return value;
    }
    case 0x55:
      return rTimeWithZone(state);
    case 0x5b: {
      const array: MarshalValue[] = register(state, []);
      const length = rLong(state);
      for (let i = 0; i < length; i++) array.push(rObject(state));
      return array;
    }
    case 0x7b: {
      const hash = register(state, new Map<MarshalValue, MarshalValue>());
      const length = rLong(state);
      for (let i = 0; i < length; i++) {
        const key = rObject(state);
        hash.set(key, rObject(state));
      }
      return hash;
    }
    default:
      throw new MarshalRefusedError(`type byte ${JSON.stringify(String.fromCharCode(type))}`);
  }
}

export function marshalLoad(bytes: Uint8Array): MarshalValue {
  if (bytes[0] !== 4 || bytes[1] !== 8) throw new MarshalRefusedError("a payload without the 4.8 header");
  const state: LoadState = { bytes, pos: 2, symbols: [], objects: [] };
  const value = rObject(state);
  if (state.pos !== bytes.length) throw new MarshalRefusedError("trailing bytes");
  return value;
}
