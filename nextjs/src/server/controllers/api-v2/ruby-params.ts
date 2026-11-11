// Ruby's reading of a request parameter, for the v2 controllers that test one before their first write. Whatever Ruby would read in a way
// the port does not follow throws a NotPortedError, which hands the request to Rails whole.
import { NotPortedError } from "../../page-props/not-ported.ts";
import type { Params } from "../rails-body.ts";

export const notPorted = (reason: string): never => {
  throw new NotPortedError(reason);
};

export const isHash = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// String#blank? (the Unicode [[:space:]] class)
export const blank = (value: string) =>
  /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(value);

// `value.blank?` for a parameter of any type: nil, false, whitespace, [] and {}.
export function blankParam(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "string") return blank(value);
  if (Array.isArray(value)) return value.length === 0;
  return isHash(value) && Object.keys(value).length === 0;
}

// `value.to_s` of a scalar parameter. A list or a hash prints as Ruby's inspect, and a number outside the safe range as a Float.
export function rubyToS(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return notPorted("a parameter that is not text, a whole number or a boolean");
}

// String#to_i: leading ASCII whitespace, a sign, then digits with single underscores between them; anything else is 0.
export function rubyToI(text: string): bigint {
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+(?:_\d+)*)/u.exec(text);
  return match === null ? 0n : BigInt(`${match[1] === "-" ? "-" : ""}${match[2]!.replaceAll("_", "")}`);
}

// `Integer(value, exception: false)`, or null where Ruby returns nil. A string Ruby may read with a prefix, underscores or an octal
// zero, and a number that is not a safe whole number, stay in Rails.
export function rubyInteger(value: unknown): bigint | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? BigInt(value) : notPorted("a number that is not a safe whole number");
  if (typeof value !== "string") return notPorted("a value that is not a scalar");
  const text = value.replace(/^[ \t\n\v\f\r]+/u, "");
  const decimal = /^([+-]?(?:0|[1-9]\d*))[ \t\n\v\f\r]*$/u.exec(text);
  if (decimal) return BigInt(decimal[1]!);
  if (/^[+-]?\d/u.test(text)) return notPorted("an integer string Ruby may read with a prefix or underscores");
  return null;
}
