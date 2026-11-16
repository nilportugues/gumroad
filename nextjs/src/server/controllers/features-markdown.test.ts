import { describe, expect, it } from "vitest";

import { featuresMarkdown } from "./public-handlers.ts";

describe("featuresMarkdown", () => {
  const markdown = featuresMarkdown(new Date("2026-03-07T23:59:59Z"));

  it("starts with the heading and strips the heredoc indent", () => {
    expect(markdown.startsWith("# Gumroad features\n\n> For the full visual experience")).toBe(true);
    expect(markdown).toContain("\n- **Digital products** — ");
  });

  it("interpolates the features url and the UTC date without padding the day", () => {
    expect(markdown).toContain("[gumroad.com/features](https://gumroad.com/features)");
    expect(markdown).toContain("*Last updated: March 7, 2026*\n");
    expect(markdown).not.toContain("#{");
  });

  it("ends with a single newline", () => {
    expect(markdown.endsWith("page.*\n")).toBe(true);
  });
});
