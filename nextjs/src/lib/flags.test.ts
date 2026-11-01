import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/flags.golden.json" with { type: "json" };
import { defineFlags } from "./flags.ts";

// Vectors come from flag_shih_tzu itself with ActiveRecord's MySQL quoting
// (nextjs/scripts/golden/flags.rb), one entry per `has_flags` call in app/models.
type Vectors = { bit: string; condition: string; not_condition: string; aliased_condition: string; set_sql: string; unset_sql: string };
type Model = { table: string; column: string; query_mode: "bit_operator" | "in_list"; flags: Record<string, Vectors> };

const models = Object.entries(golden as Record<string, Model>);

function flagsFor(model: Model) {
  const mapping: Record<number, string> = {};
  for (const [name, v] of Object.entries(model.flags)) mapping[BigInt(v.bit).toString(2).length] = name;
  return defineFlags(model.table, mapping, { column: model.column, queryMode: model.query_mode });
}

describe.each(models)("flag_shih_tzu SQL parity for %s", (_, model) => {
  const flags = flagsFor(model);

  it.each(Object.entries(model.flags))("%s", (name, v) => {
    expect(flags.bit(name).toString()).toBe(v.bit);
    expect(flags.condition(name).sql).toBe(v.condition);
    expect(flags.condition(name, false).sql).toBe(v.not_condition);
    expect(flags.condition(name, true, { tableAlias: "t2" }).sql).toBe(v.aliased_condition);
    expect(flags.setSql(name, true).sql).toBe(v.set_sql);
    expect(flags.setSql(name, false).sql).toBe(v.unset_sql);
  });
});

describe("flag bit arithmetic", () => {
  const flags = defineFlags("users", { 1: "a", 63: "high" }, { queryMode: "bit_operator" });

  it("sets and clears bits above 2^53 without losing precision", () => {
    const set = flags.set(0n, "high", true);
    expect(set).toBe(1n << 62n);
    expect(flags.isSet(set, "high")).toBe(true);
    expect(flags.set(set, "high", false)).toBe(0n);
  });

  it("treats a NULL column as no flags set", () => {
    expect(flags.isSet(null, "a")).toBe(false);
  });
});
