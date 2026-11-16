import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { QrCode } from "./qr-svg.ts";

// Ruby's rqrcode 2.2.0 output for the inputs in __fixtures__/generate-qr-svg-golden.rb, drawn the way Settings::TotpController#create does.
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/qr-svg.golden.json", import.meta.url), "utf8"),
) as Record<string, string>;
const render = (text: string) => new QrCode(text).asSvg({ moduleSize: 4, offset: 16, fill: "ffffff" });

describe("QrCode", () => {
  it.each(Object.entries(golden))("draws %s as rqrcode does", (text, svg) => {
    expect(render(text)).toBe(svg);
  });

  it("covers provisioning URIs of several versions", () => {
    const versions = new Set(Object.keys(golden).map((text) => new QrCode(text).version));
    expect(versions.size).toBeGreaterThan(6);
  });
});
