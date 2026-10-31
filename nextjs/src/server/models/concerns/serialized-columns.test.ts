import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/serialize.golden.json" with { type: "json" };
import { hashFrom, type YamlValue } from "./psych";
import { RubyFloat, RubySymbol } from "./ruby-values";
import { jsonColumn, yamlColumn, type ObjectClass } from "./serialized-columns";

// Vectors come from ActiveRecord's own serialized attribute type (scripts/golden/serialize.rb).
type Tagged = null | boolean | string | Tagged[] | { $int: string } | { $float: string } | { $sym: string } | { $hash: [Tagged, Tagged][] } | { $error: string };

function untag(t: Tagged): YamlValue {
  if (t === null || typeof t === "boolean" || typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(untag);
  if ("$int" in t) {
    const n = BigInt(t.$int);
    return Number.isSafeInteger(Number(n)) ? Number(n) : n;
  }
  if ("$float" in t) {
    const f = Number(t.$float);
    return Number.isInteger(f) || !Number.isFinite(f) ? new RubyFloat(f) : f;
  }
  if ("$sym" in t) return new RubySymbol(t.$sym);
  if ("$hash" in t) {
    const entries = t.$hash.map(([k, v]) => [untag(k), untag(v)] as [YamlValue, YamlValue]);
    return hashFrom(entries);
  }
  throw new Error(`unexpected ${JSON.stringify(t)}`);
}

// toEqual cannot compare NaN inside RubyFloat or -0.0 reliably; compare the Ruby-visible form.
const normalize = (v: unknown): unknown =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? `${x}n` : x instanceof RubyFloat ? { float: Object.is(x.value, -0) ? "-0" : String(x.value) } : x));

const label = (v: { input: Tagged }) => JSON.stringify(v.input).slice(0, 70);

describe("YAML columns match Psych byte for byte", () => {
  it.each(golden.yaml.map((v) => [label(v as { input: Tagged }), v] as const))("dumps %s", (_, v) => {
    const column = yamlColumn("attr", v.type as ObjectClass);
    expect(column.dump(untag(v.input as Tagged))).toBe(v.yaml);
  });

  it.each(golden.yaml.filter((v) => v.yaml !== null).map((v) => [label(v as { input: Tagged }), v] as const))("loads %s back", (_, v) => {
    const column = yamlColumn("attr", v.type as ObjectClass);
    const expected = v.loads_back === true ? untag(v.input as Tagged) : (v.loads_back as Tagged);
    if (expected && typeof expected === "object" && "$error" in expected) {
      expect(() => column.load(v.yaml)).toThrow(/Tried to load unspecified class/u);
      return;
    }
    expect(normalize(column.load(v.yaml))).toBe(normalize(expected));
  });

  it.each(golden.yaml_load.map((v) => [JSON.stringify(v.yaml), v] as const))("loads %s like safe_load", (_, v) => {
    const column = yamlColumn("attr");
    const loaded = v.loaded as Tagged;
    if (loaded && typeof loaded === "object" && "$error" in loaded) {
      expect(() => column.load(v.yaml)).toThrow();
      return;
    }
    expect(normalize(column.load(v.yaml))).toBe(normalize(untag(loaded)));
  });
});

describe("JSON columns match JSON.dump", () => {
  it.each(golden.json.map((v) => [label(v as { input: Tagged }), v] as const))("dumps and loads %s", (_, v) => {
    const column = jsonColumn("attr");
    expect(column.dump(untag(v.input as Tagged))).toBe(v.json);
    expect(normalize(column.load(v.json))).toBe(normalize(untag(v.loaded as Tagged)));
  });
});

describe("serialized column types", () => {
  it("stores an empty Array-typed value as NULL and loads NULL as []", () => {
    const verticals = yamlColumn("verticals", "Array");
    expect(verticals.dump([])).toBeNull();
    expect(verticals.load(null)).toEqual([]);
  });

  it("refuses to dump a value of the wrong class", () => {
    expect(() => yamlColumn("query", "Hash").dump(["a"])).toThrow("can't dump `query`: was supposed to be a Hash, but was a Array");
  });
});
