// Port of the Ruby value semantics serialized columns depend on: Float vs Integer, Symbol, and
// Float#to_s formatting (numeric.c flo_to_s).
//
// JS numbers cannot tell 1 from 1.0, so a Ruby Float with an integral value is a RubyFloat.
// Non-integral JS numbers are always Floats; integral ones and bigints are Integers.

export class RubyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export class RubySymbol {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export type RubyValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | RubyFloat
  | RubySymbol
  | RubyValue[]
  | { [key: string]: RubyValue };

export function isRubyFloat(value: unknown): value is number | RubyFloat {
  return value instanceof RubyFloat || (typeof value === "number" && !Number.isInteger(value));
}

export function floatValue(value: number | RubyFloat): number {
  return value instanceof RubyFloat ? value.value : value;
}

// Float#to_s: shortest round-trip digits, fixed notation for -4 < exponent < 16, otherwise
// "d.ddde+XX". NaN and Infinity are left to the caller (Psych and JSON spell them differently).
export function rubyFloatToS(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1;
  if (decpt > 0 && (decpt < digits.length || decpt <= 15)) {
    if (decpt < digits.length) return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
    return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  }
  if (decpt <= 0 && decpt > -4) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  const e = decpt - 1;
  const fraction = digits.length > 1 ? digits.slice(1) : "0";
  return `${sign}${digits[0]}.${fraction}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

export function isPlainHash(value: unknown): value is { [key: string]: RubyValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RubyFloat) && !(value instanceof RubySymbol);
}

// String#inspect (for messages that quote a string, as Ruby's exceptions do).
export function rubyInspect(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (char === "\f") out += "\\f";
    else if (char === "\v") out += "\\v";
    else if (char === "\b") out += "\\b";
    else if (char === "\x07") out += "\\a";
    else if (char === "\x1b") out += "\\e";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += char;
  }
  // `#{`, `#$` and `#@` are escaped so the result reads back as the same String.
  return `${out.replace(/#(?=[{$@])/gu, "\\#")}"`;
}
