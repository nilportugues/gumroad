import { describe, expect, it } from "vitest";

import { ratioBetween, visibleIndicator } from "./contrast-color.ts";

describe("visibleIndicator", () => {
  it("keeps a colour that can be seen against the background", () => {
    expect(visibleIndicator("#ff90e8", "#ffffff")).toBe("#ff90e8");
  });

  it("shifts a colour that has vanished into the background until it clears 3:1", () => {
    const shifted = visibleIndicator("#fafafa", "#ffffff");
    expect(shifted).not.toBe("#fafafa");
    expect(ratioBetween(shifted, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("answers black for a value that is not a hex colour", () => {
    expect(visibleIndicator("nope", "#ffffff")).toBe("#000000");
  });
});
