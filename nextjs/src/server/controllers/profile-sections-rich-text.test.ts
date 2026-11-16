import { describe, expect, it } from "vitest";

import { permitted, plainText } from "./profile-sections-mutations.ts";

// What the legacy per-section endpoint leaves to Rails: texts SaveContentUpsellsService could act on or that JSON would not store as sent.
describe("rich text of the profile sections endpoint", () => {
  it("serves a document as sent", () => {
    const text = { type: "doc", content: [{ type: "paragraph", attrs: { level: 2, none: null }, content: [] }] };
    expect(plainText(text)).toBe(text);
  });

  it.each([
    ["an upsell card node", { type: "doc", content: [{ type: "upsellCard", attrs: {} }] }],
    ["a nested upsell card", { content: [{ type: "blockquote", content: [{ type: "upsellCard" }] }] }],
    ["content that is not a list", { content: { type: "paragraph" } }],
    ["a number past the safe range", { content: [], attrs: { big: 2 ** 60 } }],
    ["a fractional number", { content: [], attrs: { ratio: 0.5 } }],
    ["a text that is a list", []],
    ["a text that is a string", "doc"],
  ])("leaves %s to Rails", (_name, text) => {
    expect(() => plainText(text)).toThrow();
  });

  it("keeps the batched editor's rich text with Rails", () => {
    expect(() => permitted({ text: {} }, true)).toThrow();
    expect(permitted({ text: {} }, true, true)).toEqual({ text: {} });
  });
});
