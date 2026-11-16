// The Ruby value semantics Product::Searchable and SearchProducts lean on, for params that arrive as
// JSON-shaped values (strings from a query string, numbers/booleans/arrays/hashes from application
// code). JavaScript cannot tell an Integer from a Float with a whole value, so a whole number is an
// Integer here; a request never carries either, only strings.
import { isBlank } from "../models/runtime/validators.ts";

export type Params = Record<string, unknown>;

export class RubyError extends Error {
  readonly rubyClass: string;
  constructor(rubyClass: string, message: string) {
    super(message);
    this.name = rubyClass;
    this.rubyClass = rubyClass;
  }
}

export const hasKey = (params: Params, key: string): boolean => Object.hasOwn(params, key);

// Only nil and false are falsy in Ruby: "", 0 and [] are truthy.
export const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

export const isNil = (value: unknown): boolean => value === undefined || value === null;

// Object#present?
export const present = (value: unknown): boolean => !isBlank(value);

export const isHash = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Array.wrap
export function arrayWrap(value: unknown): unknown[] {
  if (isNil(value)) return [];
  return Array.isArray(value) ? value : [value];
}

// Kernel#Array: a Hash becomes its pairs.
export function kernelArray(value: unknown): unknown[] {
  if (isNil(value)) return [];
  if (Array.isArray(value)) return value;
  if (isHash(value)) return Object.entries(value);
  return [value];
}

function describe(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  if (Array.isArray(value)) return "an instance of Array";
  if (isHash(value)) return "an instance of Hash";
  return "an instance of Object";
}

// Object#to_s for the values a param holds. Collections would print their inspect form.
export function rubyToS(value: unknown): string {
  if (isNil(value)) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new RubyError("NotPortedError", "to_s of a collection is its Ruby inspect form, which is not ported");
}

const TO_I = /^[\t\n\v\f\r ]*([+-]?\d+(?:_\d+)*)/u;

// to_i on nil, String, Integer and Float; anything else raises NoMethodError as Ruby does.
export function toI(value: unknown): bigint {
  if (isNil(value)) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RubyError("FloatDomainError", String(value));
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const match = TO_I.exec(value);
    return match ? BigInt(match[1]!.replaceAll("_", "")) : 0n;
  }
  throw new RubyError("NoMethodError", `undefined method 'to_i' for ${describe(value)}`);
}

// A JSON integer: a Number while it is a safe one.
export function intJson(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

// ActiveModel::Type::Boolean#cast
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
export function castBoolean(value: unknown): boolean | null {
  if (value === "" || isNil(value)) return null;
  return !FALSE_VALUES.has(value);
}

// String#tr(" ", "-")
export const trSpaceToHyphen = (value: string): string => value.replaceAll(" ", "-");

// String#split(sep) without a limit: trailing empty strings are dropped, and "" splits to [].
export function rubySplit(value: string, separator: string): string[] {
  const parts = value.split(separator);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// String#strip: leading whitespace and NUL-free trailing whitespace/NUL.
export const rubyStrip = (value: string): string => value.replace(/^[\t\n\v\f\r ]+/u, "").replace(/[\t\n\v\f\r \0]+$/u, "");
