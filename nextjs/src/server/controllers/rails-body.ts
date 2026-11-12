// `request.parameters` for a mutation: the JSON body Inertia sends, or a form body in Rack's nested syntax, over the query string.
// Whatever Rails would parse differently (a nil inside a list is cleaned by deep_munge, multipart uploads, repeated keys of a
// nested hash) hands the request back to Rails.
import { RubyFloat } from "../models/concerns/ruby-values.ts";

import { HandBackToRails } from "./application-controller.ts";

export type Params = Record<string, unknown>;

const isHash = (value: unknown): value is Params =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ActionDispatch::Request::Utils.perform_deep_munge removes nils from lists.
export function assertMunged(value: unknown): void {
  if (Array.isArray(value)) {
    if (value.some((item) => item === null)) throw new HandBackToRails("a nil inside a list parameter");
    for (const item of value) assertMunged(item);
  } else if (isHash(value)) for (const item of Object.values(value)) assertMunged(item);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw new HandBackToRails("an undecodable form body");
  }
}

// Rack::QueryParser for `a=1&b[c]=2&d[]=3`: nested hashes and flat lists only.
export function parseNestedQuery(query: string): Params {
  const out: Params = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    const value = index === -1 ? null : decode(pair.slice(index + 1));
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/u.exec(key);
    if (match === null) throw new HandBackToRails("a form key Rack parses specially");
    const path = [match[1]!, ...[...(match[2] ?? "").matchAll(/\[([^[\]]*)\]/gu)].map((part) => part[1]!)];
    let target = out;
    for (let i = 0; i < path.length; i++) {
      const name = path[i]!;
      const last = i === path.length - 1;
      const listNext = path[i + 1] === "";
      if (name === "") throw new HandBackToRails("a list of hashes in a form body");
      if (last) {
        if (name in target) throw new HandBackToRails("a repeated form key");
        target[name] = value;
      } else if (listNext) {
        if (i + 1 !== path.length - 1) throw new HandBackToRails("a nested list in a form body");
        const list = (target[name] ??= []);
        if (!Array.isArray(list)) throw new HandBackToRails("a form key used as a list and a hash");
        list.push(value);
        break;
      } else {
        const child = (target[name] ??= {});
        if (!isHash(child)) throw new HandBackToRails("a form key used as a value and a hash");
        target = child;
      }
    }
  }
  return out;
}

type NumberReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

// Ruby's JSON.parse makes a Float of every number written with a point or an exponent (`5.0`, `1e2`); JSON.parse here makes both a
// number. With `floats`, each such literal becomes a RubyFloat, read off the source text the reviver is given.
function parseJsonKeepingFloats(text: string): unknown {
  const reviver: NumberReviver = (_key, value, context) =>
    typeof value === "number" && context?.source !== undefined && /[.eE]/u.test(context.source)
      ? new RubyFloat(value)
      : value;
  return (JSON.parse as (text: string, reviver: NumberReviver) => unknown)(text, reviver);
}

export function parseBody(contentType: string | null, bytes: Uint8Array, floats = false): Params {
  const text = Buffer.from(bytes).toString("utf8");
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json") {
    if (text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = floats ? parseJsonKeepingFloats(text) : JSON.parse(text);
    } catch {
      throw new HandBackToRails("an invalid JSON body");
    }
    if (!isHash(parsed)) throw new HandBackToRails("a JSON body that is not an object");
    assertMunged(parsed);
    return parsed;
  }
  if (type === "application/x-www-form-urlencoded") return parseNestedQuery(text);
  if (text === "") return {};
  throw new HandBackToRails("a body Node does not parse");
}

// query parameters, then the body (`params` merges the body over the query string)
export function requestParams(url: URL, contentType: string | null, bytes: Uint8Array, floats = false): Params {
  return { ...parseNestedQuery(url.search.replace(/^\?/u, "")), ...parseBody(contentType, bytes, floats) };
}
