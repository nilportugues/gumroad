import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/public-suffix.golden.json" with { type: "json" };
import { isValidDomain, parseDomain } from "./public-suffix.ts";

describe("PublicSuffix parity with the gem", () => {
  it.each(golden.map((c) => [c.host, c] as const))("%j", (host, c) => {
    expect(isValidDomain(host)).toBe(c.valid);
    let parsed: unknown;
    try {
      parsed = parseDomain(host);
    } catch (error) {
      parsed = { error: (error as Error).name };
    }
    expect(parsed).toEqual(c.parse);
  });
});
