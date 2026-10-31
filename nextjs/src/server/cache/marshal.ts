// The subset of Ruby's Marshal (format 4.8, Ruby 3.4) that Rails.cache values from Node need:
// nil, booleans, Integer, Float, String (UTF-8, binary, US-ASCII), Symbol, Array and Hash.
// Anything else (objects, Structs, Time, default-valued Hashes, other encodings) is refused on
// both sides. __fixtures__/rails-cache.golden.json pins every branch against Marshal.dump.
//
// Values: a JS number that is an integer is a Ruby Integer (use bigint past 2^53), any other
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
    if (!/^[\x00-\x7f]*$/.test(value)) throw new MarshalRefusedError("US-ASCII string with non-ASCII characters");
    this.value = value;
  }
}

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

type DumpState = { out: number[]; symbols: Map<string, number>; objects: number; flonums: Map<number, number>; seen: Set<object> };

function wBytes(state: DumpState, bytes: Uint8Array): void {
  wLong(state.out, bytes.length);
  for (const byte of bytes) state.out.push(byte);
}

const utf8 = new TextEncoder();
const isAscii = (text: string) => /^[\x00-\x7f]*$/.test(text);

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
  const state: DumpState = { out: [4, 8], symbols: new Map(), objects: 0, flonums: new Map(), seen: new Set() };
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
  if (rSymbol(state) !== "E") throw new MarshalRefusedError("strings in encodings other than UTF-8, US-ASCII and binary");
  const flag = byte(state);
  if (flag === 0x54) return "UTF-8";
  if (flag === 0x46) return "US-ASCII";
  throw new MarshalRefusedError("an unexpected encoding flag");
}

function register<T extends MarshalValue>(state: LoadState, value: T): T {
  state.objects.push(value);
  return value;
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
      if (state.pos + length > state.bytes.length) throw new MarshalRefusedError("truncated data (marshal data too short)");
      const raw = state.bytes.subarray(state.pos, state.pos + length);
      state.pos += length;
      let magnitude = 0n;
      for (let i = raw.length - 1; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(raw[i]!);
      const value = sign === 0x2d ? -magnitude : magnitude;
      return register(state, Number.isSafeInteger(Number(value)) && BigInt(Number(value)) === value ? Number(value) : value);
    }
    case 0x66: {
      const text = new TextDecoder().decode(rBytes(state));
      const value = text === "inf" ? Infinity : text === "-inf" ? -Infinity : text === "nan" ? NaN : Number(text);
      return register(state, Number.isInteger(value) || !Number.isFinite(value) || Object.is(value, -0) ? new RubyFloat(value) : value);
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
