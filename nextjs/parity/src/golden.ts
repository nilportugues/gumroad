import { readFileSync } from "node:fs";

import { type Json, parseJson } from "./canonical";

// A value as bin/golden writes it, with { "$big" } turned back into bigint.
export type GoldenValue = null | boolean | number | bigint | string | GoldenValue[] | { [key: string]: GoldenValue };
export type GoldenRaise = { $raises: string; message: string };
export type Golden = Record<string, Record<string, GoldenValue>>;

export function loadGolden(path: string | URL): Golden {
  return revive(parseJson(readFileSync(path, "utf8"))) as Golden;
}

// [input key, expected] pairs for it.each. Keys are the input itself for strings, JSON otherwise.
export function goldenCases(golden: Golden, group: string): [string, GoldenValue][] {
  const cases = golden[group];
  if (!cases) throw new Error(`Golden fixture has no group "${group}"`);
  return Object.entries(cases);
}

// Back from a key to the input bin/golden was given. A string input that is itself valid JSON
// ("42") reads back as the JSON value; groups whose inputs are such strings should use the key as is.
export function goldenInput(key: string): GoldenValue {
  try {
    return revive(parseJson(key));
  } catch {
    return key;
  }
}

export function isRaise(value: GoldenValue): value is GoldenRaise {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.$raises === "string";
}

function revive(value: Json): GoldenValue {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$big === "string") return BigInt(value.$big);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}
