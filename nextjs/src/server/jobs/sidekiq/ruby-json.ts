// JSON.generate as Ruby's json gem (2.13) writes it, for the values a job payload can hold.
//
// The bytes matter in two places: sidekiq-unique-jobs hashes JSON.generate output into the lock
// digest, and Sidekiq timestamps are Ruby Floats (`1761955200.0`, never `1761955200`). JavaScript
// cannot tell 1 from 1.0, so plain numbers are Ruby Integers here and floats that must stay floats
// are wrapped in RubyFloat. Integers past 2^53 must be passed as bigint.
export class RubyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type JsonValue = null | boolean | number | bigint | string | RubyFloat | JsonValue[] | { [key: string]: JsonValue };

function formatNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not valid JSON`);
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path}: ${value} is past 2^53; pass a bigint`);
    return Object.is(value, -0) ? "0" : String(value);
  }
  const text = String(value);
  // json 2.13 switches to exponent notation on different thresholds than V8 does.
  if (text.includes("e")) throw new TypeError(`${path}: ${text} would not serialize as Ruby does`);
  return text;
}

function formatFloat(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not valid JSON`);
  const text = String(value);
  if (text.includes("e")) throw new TypeError(`${path}: ${text} would not serialize as Ruby does`);
  return Number.isInteger(value) ? `${text}.0` : text;
}

export function dumpRubyJson(value: JsonValue, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatNumber(value, path);
    case "bigint":
      return value.toString();
    case "string":
      // V8 and Ruby's json agree on string escaping: ", \, and C0 controls (\b \f \n \r \t or
      // lowercase \u00xx); "/" and non-ASCII (U+2028 included) are written raw.
      return JSON.stringify(value);
  }
  if (value instanceof RubyFloat) return formatFloat(value.value, path);
  if (Array.isArray(value)) return `[${value.map((item, i) => dumpRubyJson(item, `${path}[${i}]`)).join(",")}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => {
      if (item === undefined) throw new TypeError(`${path}.${key} is undefined`);
      return `${JSON.stringify(key)}:${dumpRubyJson(item, `${path}.${key}`)}`;
    })
    .join(",")}}`;
}

// `Float#to_s`, which Sidekiq uses for the `schedule` score and unique-jobs for the lock score.
export function rubyFloatToS(value: number): string {
  return formatFloat(value, "score");
}

// JSON.parse that keeps integers past 2^53 as bigint, so a Ruby payload round-trips.
export function parseRubyJson(text: string): JsonValue {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && context?.source !== undefined) {
      if (/^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) return BigInt(context.source);
      if (/[.eE]/.test(context.source) && Number.isInteger(value)) return new RubyFloat(value);
    }
    return value;
  }) as JsonValue;
}
