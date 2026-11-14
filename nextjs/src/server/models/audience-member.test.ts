// Replays audience-member-filter.golden.json (scripts/golden/audience-member-filter.rb): the text of every statement
// AudienceMember.filter builds, for a matrix of params and options, written the way the real relation writes it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { audienceSql, countSql, filterAudience, firstSql, type FilterOptions, type FilterParams } from "./audience-member.ts";

type Case = {
  params: FilterParams;
  options: { with_ids?: boolean; ids?: number[]; as_of?: string; purchase_ids?: number[] };
  error: { class: string; message: string } | null;
  sql?: string;
  first?: string[];
  count?: string[] | null;
  count_limit?: string[] | null;
};
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/audience-member-filter.golden.json", import.meta.url), "utf8")) as { cases: Case[] };

const optionsOf = (options: Case["options"]): FilterOptions => ({
  withIds: options.with_ids ?? false,
  ids: options.ids ?? null,
  asOf: options.as_of === undefined ? null : new Date(options.as_of),
  purchaseIds: options.purchase_ids ?? null,
});

describe("AudienceMember.filter", () => {
  for (const [index, c] of golden.cases.entries()) {
    it(`case ${index}: ${JSON.stringify(c.params)} ${JSON.stringify(c.options)}`, () => {
      if (c.error !== null) {
        expect(() => filterAudience(1, c.params, optionsOf(c.options))).toThrow(c.error.message);
        return;
      }
      const relation = filterAudience(1, c.params, optionsOf(c.options));
      expect(audienceSql(relation)).toBe(c.sql);
      expect([firstSql(relation)]).toEqual(c.first);
      if (c.count) expect([countSql(relation)]).toEqual(c.count);
      if (c.count_limit) expect([countSql(relation, 5)]).toEqual(c.count_limit);
    });
  }
});
