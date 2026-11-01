import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { FilterParams } from "../models/audience-member.ts";
import { filterCount, filterQuery } from "./audience-member-search.ts";
import { setEsSender, type EsRequest } from "./transport.ts";

// Replays audience-member-filter-query.golden.json, the query the real AudienceMember.filter_query built for each param set.
type Case = { params: FilterParams; query: unknown; error: { class: string; message: string } | null };
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/audience-member-filter-query.golden.json", import.meta.url), "utf8")) as { cases: Case[] };

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("AudienceMember.filter_query", () => {
  it("has recorded cases", () => {
    expect(golden.cases.length).toBeGreaterThan(60);
    expect(golden.cases.some((c) => c.error !== null)).toBe(true);
  });

  it.each(golden.cases.map((c) => [JSON.stringify(c.params), c] as const))("%s", (_name, recorded) => {
    if (recorded.error) {
      expect(() => filterQuery(1, recorded.params)).toThrow(recorded.error.message);
      return;
    }
    expect(JSON.parse(JSON.stringify(filterQuery(1, recorded.params)))).toEqual(recorded.query);
  });
});

describe("AudienceMember.filter_count", () => {
  it("counts a seller's audience in Elasticsearch, terminating after the limit", async () => {
    const sent: EsRequest[] = [];
    restore = setEsSender(async (request) => {
      sent.push(request);
      return { status: 200, body: { count: 7 } };
    });
    expect(await filterCount(1, {}, 101)).toBe(7);
    expect(sent).toEqual([{ method: "POST", path: expect.stringMatching(/\/audience_members[^/]*\/_count$/u), query: { terminate_after: "101" }, body: '{"query":{"bool":{"filter":[{"term":{"seller_id":1}}]}}}' }]);
  });

  it("counts nobody for a post without a seller", async () => {
    expect(await filterCount(null, {}, 101)).toBe(0);
  });

  it("returns null when the answer has no count", async () => {
    restore = setEsSender(async () => ({ status: 200, body: {} }));
    expect(await filterCount(1, {}, null)).toBeNull();
  });
});
