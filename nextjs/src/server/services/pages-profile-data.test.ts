import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import { buildProductPrices, referencedInPrices } from "./pages-product-prices.ts";
import { profileDataJson, type ProfileDataFacts } from "./pages-profile-data.ts";

type Case = {
  name: string;
  tabs: string[] | null;
  products: number;
  deleted_products: number;
  draft_products: number;
  archived_products: number;
  posts: number;
  unpublished_posts: number;
  reputation_summary_enabled: boolean;
  hands_back: boolean;
  json: string | null;
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-profile-data.golden.json"), "utf8"),
) as { cases: Case[] };

// What loadProfileDataFacts reads for the seller the case set up: every product the seller has not deleted, every published post.
const factsOf = (c: Case): ProfileDataFacts => ({
  undeletedProducts: c.products + c.draft_products + c.archived_products,
  publishedPosts: c.posts,
  reputationSummaryEnabled: c.reputation_summary_enabled,
  sellerProfileJsonData: c.tabs === null ? null : { tabs: c.tabs.map((name) => ({ name, sections: [] })) },
});

describe("Pages::ProfileData against Ruby (nextjs/scripts/golden/pages-profile-data.rb)", () => {
  it.each(golden.cases.filter((c) => !c.hands_back).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(profileDataJson(factsOf(c))).toBe(c.json);
  });

  it.each(golden.cases.filter((c) => c.hands_back).map((c) => [c.name, c] as const))("hands back %s", (_name, c) => {
    expect(() => profileDataJson(factsOf(c))).toThrow(NotPortedError);
  });

  it("covers every case the generator records", () => {
    expect(golden.cases.length).toBe(14);
  });
});

describe("what profileDataJson reads from the profile", () => {
  const facts = (sellerProfileJsonData: unknown): ProfileDataFacts => ({
    undeletedProducts: 0,
    publishedPosts: 0,
    reputationSummaryEnabled: false,
    sellerProfileJsonData,
  });

  it("treats tabs that are null like no tabs", () => {
    expect(profileDataJson(facts({ tabs: null }))).toBe(profileDataJson(facts(null)));
  });

  it("refuses a tab list that is not a list", () => {
    expect(() => profileDataJson(facts({ tabs: "x" }))).toThrow(NotPortedError);
  });

  it("refuses a tab whose name is a number", () => {
    expect(() => profileDataJson(facts({ tabs: [{ name: 5 }] }))).toThrow(NotPortedError);
  });

  it("skips a tab with no name", () => {
    expect(profileDataJson(facts({ tabs: [{ sections: [] }, { name: "Kept" }] }))).toContain(
      '"pages":[{"name":"Kept"}]',
    );
  });
});

describe("Pages::ProductPrices", () => {
  const cases = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-interpolator-product.golden.json"), "utf8"),
  ) as { referenced_in: { html: string; referenced: boolean }[] };

  it.each(cases.referenced_in.map((c) => [JSON.stringify(c.html), c] as const))("referenced_in? %s", (_name, c) => {
    expect(referencedInPrices(c.html)).toBe(c.referenced);
  });

  it("treats nil as no reference", () => {
    expect(referencedInPrices(null)).toBe(false);
  });

  it("hands the per-request build back", () => {
    expect(() => buildProductPrices()).toThrow(NotPortedError);
  });
});
