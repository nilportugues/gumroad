import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { interpolateProfile, type ProductPrices } from "./pages-interpolator.ts";

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
