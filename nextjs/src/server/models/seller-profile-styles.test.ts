import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { customStyles, withDefaults } from "./seller-profile-styles.ts";

type Case = { input: Record<string, string>; output: string };
const cases = JSON.parse(readFileSync(new URL("./__fixtures__/seller-profile-styles.golden.json", import.meta.url), "utf8")) as Case[];

describe("SellerProfile#custom_styles", () => {
  it.each(cases.map((c) => [JSON.stringify(c.input), c] as const))("matches the real model for %s", (_name, { input, output }) => {
    expect(customStyles(withDefaults(input))).toBe(output);
  });
});
