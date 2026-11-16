import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  interpolateProduct,
  interpolateProfile,
  type ProductFields,
  type ProductPrices,
} from "./pages-interpolator.ts";

type Case = {
  name: string;
  html: string;
  profile: { name_or_username: string; bio: string };
  prices: ProductPrices | null;
  hands_back: boolean;
  output: string;
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-interpolator.golden.json"), "utf8"),
) as { interpolate_profile: Case[] };

describe("interpolateProfile against Ruby (__fixtures__/generate-pages-interpolator-golden.rb)", () => {
  it.each(golden.interpolate_profile.filter((c) => !c.hands_back).map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      expect(interpolateProfile(c.html, { profile: c.profile, prices: c.prices ?? {} })).toBe(c.output);
    },
  );

  it.each(golden.interpolate_profile.filter((c) => c.hands_back).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(() => interpolateProfile(c.html, { profile: c.profile, prices: c.prices ?? {} })).toThrow("is not ported");
  });
});

type ProductCase = {
  name: string;
  html: string;
  product: ProductFields;
  hands_back: boolean;
  output: string;
};
const productGolden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/pages-interpolator-product.golden.json"), "utf8"),
) as { interpolate: ProductCase[] };

describe("interpolateProduct against Ruby (nextjs/scripts/golden/pages-interpolator.rb)", () => {
  it.each(productGolden.interpolate.filter((c) => !c.hands_back).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(interpolateProduct(c.html, c.product)).toBe(c.output);
  });

  it.each(productGolden.interpolate.filter((c) => c.hands_back).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(() => interpolateProduct(c.html, c.product)).toThrow("is not ported");
  });
});
