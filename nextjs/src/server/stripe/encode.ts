// stripe-ruby 12.5.0's form encoding (Util.objects_to_ids, flatten_params, encode_parameters,
// url_encode), which is what Stripe receives from Rails. stripe-node encodes with `qs`, which
// differs (nil values, nested arrays, `*`, `'`, `(`, `)`, `!` and spaces), hence this port.
import { RubyFloat, RubySymbol, rubyFloatToS } from "../models/concerns/ruby-values.ts";

// What a request parameter can hold. `undefined` and `null` are Ruby's nil. A Map keeps keys in
// insertion order where a plain object would move integer-like keys first.
export type StripeParam =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | RubyFloat
  | RubySymbol
  | StripeParam[]
  | StripeParams;
export type StripeParams = { [key: string]: StripeParam } | Map<string, StripeParam>;

function isParams(value: unknown): value is StripeParams {
  return value instanceof Map || (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RubyFloat) && !(value instanceof RubySymbol));
}

function entries(params: StripeParams): [string, StripeParam][] {
  return params instanceof Map ? [...params] : Object.entries(params);
}

// Util.objects_to_ids: drops nil values from hashes (not from arrays) at every depth.
export function objectsToIds(params: StripeParams): [string, StripeParam][] {
  const strip = (value: StripeParam): StripeParam => {
    if (Array.isArray(value)) return value.map(strip);
    if (isParams(value)) return new Map(objectsToIds(value));
    return value;
  };
  return entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [key, strip(value)]);
}

// `to_s` of a leaf value.
function rubyToS(value: StripeParam): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof RubySymbol) return value.name;
  if (value instanceof RubyFloat) return rubyFloatToS(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : rubyFloatToS(value);
  throw new TypeError(`Cannot form-encode ${Object.prototype.toString.call(value)}`);
}

// Util.flatten_params / flatten_params_array. A nested array is flattened under its parent's key
// with its own indexes, so `list: [["x", "y"]]` sends `list[0]=x&list[1]=y`, as Ruby does.
export function flattenParams(params: StripeParams | [string, StripeParam][], parentKey?: string): [string, StripeParam][] {
  const result: [string, StripeParam][] = [];
  for (const [key, value] of Array.isArray(params) ? params : entries(params)) {
    const calculatedKey = parentKey === undefined ? key : `${parentKey}[${key}]`;
    if (isParams(value)) result.push(...flattenParams(value, calculatedKey));
    else if (Array.isArray(value)) result.push(...flattenParamsArray(value, calculatedKey));
    else result.push([calculatedKey, value]);
  }
  return result;
}

function flattenParamsArray(values: StripeParam[], calculatedKey: string): [string, StripeParam][] {
  const result: [string, StripeParam][] = [];
  values.forEach((element, index) => {
    if (isParams(element)) result.push(...flattenParams(element, `${calculatedKey}[${index}]`));
    else if (Array.isArray(element)) result.push(...flattenParamsArray(element, calculatedKey));
    else result.push([`${calculatedKey}[${index}]`, element]);
  });
  return result;
}

const CGI_UNRESERVED = /[a-zA-Z0-9_.\-~]/u;

// CGI.escape: every byte outside `a-zA-Z0-9_.-~` percent-encoded, space as `+`. Resource paths
// interpolate ids through it (`format("/v1/accounts/%<id>s", id: CGI.escape(id))`).
export function cgiEscape(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === " ") out += "+";
    else if (CGI_UNRESERVED.test(char)) out += char;
    else for (const byte of Buffer.from(char, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// Util.url_encode: CGI.escape with `[` and `]` put back.
export function urlEncode(value: string): string {
  return cgiEscape(value).replaceAll("%5B", "[").replaceAll("%5D", "]");
}

// Util.encode_parameters over params that already went through objectsToIds.
export function encodeParameters(params: [string, StripeParam][]): string {
  return flattenParams(params)
    .map(([key, value]) => `${urlEncode(key)}=${urlEncode(rubyToS(value))}`)
    .join("&");
}
