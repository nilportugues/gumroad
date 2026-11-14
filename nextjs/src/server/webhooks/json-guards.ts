// What a webhook handler needs to know before re-serialising a body Ruby parsed: a job argument is dumped by Sidekiq, so a value JS
// would write differently from Ruby sends the whole request to Rails.
import { NotPortedError } from "../page-props/not-ported.ts";

// Ruby writes 1.0 and 1e3 as floats and keeps integers of any size; JS folds the first two into integers and rounds the last.
export function assertPlainIntegers(text: string): void {
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    const token = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index))?.[0];
    if (token === undefined) continue;
    if (!/^-?\d+$/u.test(token) || !Number.isSafeInteger(Number(token)))
      throw new NotPortedError("a non-integer or unsafe number in a webhook body");
    index += token.length - 1;
  }
}

// JS orders integer-like keys first, which would reorder the hash Ruby keeps in insertion order.
const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d{0,8})$/u;

export function assertKeyOrderSurvives(value: unknown): void {
  if (Array.isArray(value)) for (const item of value) assertKeyOrderSurvives(item);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (ARRAY_INDEX_KEY.test(key) || key === "__proto__") throw new NotPortedError("a webhook key JS would reorder");
      assertKeyOrderSurvives(item);
    }
  }
}

// ActiveSupport::JSON.encode: the characters it escapes on top of what JSON.stringify does.
export function activeSupportJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

// Object#blank? for a parsed JSON value ([[:space:]] is Unicode white space, wider than \s on one side and narrower on the other).
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string")
    return /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
