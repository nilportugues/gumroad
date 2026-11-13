import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import { buildProductPrices, referencedInPrices } from "./pages-product-prices.ts";
import { profileDataJson, type ProfileDataFacts } from "./pages-profile-data.ts";

type Case = {
  name: string;
  tabs: string[] | null;
  descriptions: (string | null)[];
  listed: { name: string; url: string; price: string; native_type: string; description: string | null }[] | null;
  products_total: number | null;
  deleted_products: number;
  draft_products: number;
  archived_products: number;
  posts: number;
  unpublished_posts: number;
  reputation_summary_enabled: boolean;
  hands_back: boolean;
  json: string | null;
};
const HANDED_BACK_PRODUCT = { url: "http://goldenseller.test/l/x", price: "$1", native_type: "digital" };
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-profile-data.golden.json"), "utf8"),
) as { cases: Case[] };

// What loadProfileDataFacts reads for the seller the case set up: the products Ruby lists, every published post.
const factsOf = (c: Case): ProfileDataFacts => ({
  storeHost: null,
  routabilityRefresh: null,
  products:
    c.listed ?? c.descriptions.map((description, i) => ({ ...HANDED_BACK_PRODUCT, name: `Product ${i}`, description })),
  productsTotal: c.products_total ?? c.descriptions.length,
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
    expect(golden.cases.length).toBe(37);
  });
});

describe("what profileDataJson reads from the profile", () => {
  const facts = (sellerProfileJsonData: unknown): ProfileDataFacts => ({
    storeHost: null,
    routabilityRefresh: null,
    products: [],
    productsTotal: 0,
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

describe("the products the payload lists", () => {
  const facts = (description: string | null): ProfileDataFacts => ({
    storeHost: null,
    routabilityRefresh: null,
    products: [{ name: "P", url: "http://s.example.com/l/p", price: "$5", native_type: "digital", description }],
    productsTotal: 1,
    publishedPosts: 0,
    reputationSummaryEnabled: false,
    sellerProfileJsonData: null,
  });

  it("lists the stored fields with no thumbnail or cover", () => {
    expect(JSON.parse(profileDataJson(facts("d"))).products).toEqual([
      {
        name: "P",
        url: "http://s.example.com/l/p",
        price: "$5",
        native_type: "digital",
        thumbnail_url: null,
        cover_url: null,
        description: "d",
      },
    ]);
  });

  it("escapes markup in a product name like the rest of the payload", () => {
    const json = profileDataJson({ ...facts("d"), products: [{ ...facts("d").products[0]!, name: "</script>&" }] });
    expect(json).toContain("\\u003c/script\\u003e\\u0026");
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
