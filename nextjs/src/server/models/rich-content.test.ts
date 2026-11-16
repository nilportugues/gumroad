import { describe, expect, it } from "vitest";

import { hasBodyContent, hasEditorContent } from "./rich-content.ts";

const text = (value: string) => [{ type: "paragraph", content: [{ type: "text", text: value }] }];

// Vectors from spec/models/rich_content_spec.rb `#has_editor_content?` and `#has_body_content?`.
describe("hasEditorContent", () => {
  it.each([
    ["an empty description", []],
    ["the editor's blank placeholder (a single bare paragraph)", [{ type: "paragraph" }]],
    ["empty paragraphs and headings", [{ type: "paragraph", content: [] }, { type: "heading" }]],
    ["null", null],
  ])("is false for %s", (_name, description) => {
    expect(hasEditorContent({ title: null, description })).toBe(false);
  });

  it.each([
    ["a node with text", text("Hello")],
    ["a content-bearing leaf like a file embed", [{ type: "fileEmbed", attrs: { id: "abc", uid: "def" } }]],
    ["content nested inside containers", [{ type: "orderedList", content: [{ type: "listItem", content: text("Item") }] }]],
  ])("is true for %s", (_name, description) => {
    expect(hasEditorContent({ title: null, description })).toBe(true);
  });

  it("is true for a title-only page with an empty body", () => {
    expect(hasEditorContent({ title: "Bonus resources", description: [{ type: "paragraph" }] })).toBe(true);
  });

  it("treats a whitespace-only title as blank, as String#blank? does, and a text node with blank text as a leaf", () => {
    expect(hasEditorContent({ title: " \u00a0\n", description: [{ type: "paragraph" }] })).toBe(false);
    expect(hasEditorContent({ title: null, description: text("  ") })).toBe(true);
  });

  it("reads a description that arrives as JSON text", () => {
    expect(hasEditorContent({ title: null, description: JSON.stringify(text("Hello")) })).toBe(true);
  });
});

describe("hasBodyContent", () => {
  it("ignores the title", () => {
    expect(hasBodyContent([{ type: "paragraph" }])).toBe(false);
  });

  it("is true for a body with text", () => {
    expect(hasBodyContent(text("Lesson one"))).toBe(true);
  });

  it("treats a node with a non-array content as a leaf", () => {
    expect(hasBodyContent([{ type: "paragraph", content: "x" }])).toBe(false);
    expect(hasBodyContent([{ type: "image", content: "x" }])).toBe(true);
  });
});
