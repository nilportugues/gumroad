// Ruby's `to_s` for the scalar values a parsed JSON document can hold, which is what string
// interpolation and redis-rb's `set` produce. Pinned by src/worker/jobs/__fixtures__.
import { type JsonValue, RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";

// Ruby's DBL_DIG.
const DBL_DIG = 15;

// Float#to_s (numeric.c flo_to_s): shortest round-trip digits, like V8, but switching to
// exponent form on different thresholds and always keeping a ".0".
export function rubyFloatToS(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const sign = value < 0 ? "-" : "";
  const [mantissa, exponent] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  // The value is 0.<digits> * 10**decpt.
  const decpt = Number(exponent) + 1;

  if (decpt > 0) {
    if (decpt < digits.length) return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
    if (decpt <= DBL_DIG) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  } else if (decpt > -4) {
    return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  }
  const exp = decpt - 1;
  const expText = `${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  return `${sign}${digits[0]}.${digits.slice(1) || "0"}e${expText}`;
}

// Throws for arrays and hashes rather than reimplementing Ruby's #inspect.
export function rubyToS(value: JsonValue): string {
  if (value === null) return "";
  if (value instanceof RubyFloat) return rubyFloatToS(value.value);
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
    case "bigint":
      return String(value);
    case "number":
      return Number.isInteger(value) ? String(value) : rubyFloatToS(value);
  }
  throw new TypeError(`Ruby's to_s of ${Array.isArray(value) ? "an Array" : "a Hash"} is not ported`);
}
