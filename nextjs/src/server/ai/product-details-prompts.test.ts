import { describe, expect, it } from "vitest";

import {
  coverImagePrompt,
  parseProductDetailsContent,
  parseRichContentPagesContent,
  productDetailsMessages,
  richContentPagesMessages,
  rubyHeredocLines,
  truncateRuby,
} from "./product-details-prompts.ts";

describe("rubyHeredocLines", () => {
  it("strips each line and keeps a leading empty line but drops trailing empty lines", () => {
    expect(rubyHeredocLines("\n   a  \n\n   b\n   ")).toBe("\na\n\nb\n");
  });

  it("drops only trailing lines that are exactly empty before the strip", () => {
    expect(rubyHeredocLines("a\n\n")).toBe("a");
  });
});

describe("truncateRuby", () => {
  it("returns the text unchanged when it fits", () => {
    expect(truncateRuby("short", 500, "...")).toBe("short");
  });

  it("cuts to the length including the omission", () => {
    const result = truncateRuby("a".repeat(600), 500, "...");

    expect(result).toHaveLength(500);
    expect(result.endsWith("...")).toBe(true);
  });

  it("counts characters rather than UTF-16 units", () => {
    const result = truncateRuby("😀".repeat(10), 5, "...");

    expect(result).toBe("😀😀...");
  });
});

describe("productDetailsMessages", () => {
  const messages = productDetailsMessages({
    currencyType: "usd",
    currencyChoices: ["usd", "eur", "jpy"],
    prompt: "Ebook for $10",
  });
  const [system, user] = messages;

  it("builds a system message followed by the user prompt", () => {
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(user).toEqual({ role: "user", content: "Ebook for $10" });
  });

  it("starts and ends the system message the way the Ruby heredoc does", () => {
    expect(system?.content.startsWith("\nYou are an expert digital product creator.")).toBe(true);
    expect(system?.content.endsWith("}\n")).toBe(true);
  });

  it("interpolates the currency choices, the seller currency, the page limits and the native types", () => {
    expect(system?.content).toContain("- Allowed currency codes: usd, eur, jpy\n");
    expect(system?.content).toContain("use the seller's default currency: usd\n");
    expect(system?.content).toContain(
      "If specified more than 6 pages/chapters, generate only 6 pages/chapters. If no number is specified, generate 4 pages/chapters",
    );
    expect(system?.content).toContain('"native_type": "Must be one of: digital, course, ebook, membership"');
    expect(system?.content).not.toContain("#{");
  });

  it("truncates a long prompt to 500 characters", () => {
    const [, longUser] = productDetailsMessages({
      currencyType: "usd",
      currencyChoices: ["usd"],
      prompt: "x".repeat(900),
    });

    expect(longUser?.content).toHaveLength(500);
  });
});

describe("coverImagePrompt", () => {
  it("names the product in quotes-free single quotes and states the 1024x1024 canvas", () => {
    const prompt = coverImagePrompt("Ruby Basics");

    expect(prompt).toContain("the product name, 'Ruby Basics', centered");
    expect(prompt.endsWith("within a square 1024x1024 canvas.")).toBe(true);
  });
});

describe("richContentPagesMessages", () => {
  it("asks for the default page count when none is given", () => {
    const [system] = richContentPagesMessages({ name: "N", description: "D", native_type: "ebook" });

    expect(system?.content).toContain("Generate exactly 4 pages in valid Tiptap JSON format");
  });

  it("builds the user message with the native type, name, page count and description", () => {
    const [, user] = richContentPagesMessages({
      name: "Ruby Basics",
      description: "<p>Learn it</p>",
      native_type: "course",
      number_of_content_pages: 2,
    });

    expect(user?.content).toBe(
      '\n              Create detailed content pages for course product:\n              Product name: "Ruby Basics".\n              Number of content pages: 2.\n              Product description: "<p>Learn it</p>".\n              ',
    );
  });

  it("keeps the codeBlock example's escaped newlines as separate lines in the system message", () => {
    const [system] = richContentPagesMessages({
      name: "N",
      description: "D",
      native_type: "ebook",
      number_of_content_pages: 1,
    });

    expect(system?.content).toContain('"text": "class Dog\ndef bark\nputs \'Woof!\'\nend\nend"');
  });
});

describe("parseProductDetailsContent", () => {
  it("parses the JSON the model returned", () => {
    expect(parseProductDetailsContent('{"name":"Ruby"}')).toEqual({ name: "Ruby" });
  });

  it.each([null, undefined, "", "   "])("raises when the content is blank (%j)", (content) => {
    expect(() => parseProductDetailsContent(content)).toThrow(
      "Failed to generate product details - no content returned",
    );
  });
});

describe("parseRichContentPagesContent", () => {
  it('repairs a key written as "type: " before parsing', () => {
    expect(parseRichContentPagesContent('{"pages":[{"content":[{"type: ":"paragraph"}]}]}')).toEqual({
      pages: [{ content: [{ type: "paragraph" }] }],
    });
  });

  it("repairs the key whatever whitespace follows the colon", () => {
    expect(parseRichContentPagesContent('{"type:\t \n": "heading"}')).toEqual({ type: "heading" });
  });

  it("raises when the content is blank", () => {
    expect(() => parseRichContentPagesContent("  ")).toThrow(
      "Failed to generate rich content pages - no content returned",
    );
  });
});
