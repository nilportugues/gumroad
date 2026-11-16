import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { featuredImageUrl, messageSnippet, messageTags, truncateAtSeparator } from "./installment-message.ts";

type Row = { message: string; snippet: string; featured: string | null; tags: string[] };
const rows = JSON.parse(readFileSync(new URL("__fixtures__/installment-message.golden.json", import.meta.url), "utf8")) as Row[];

describe("Installment message readings against Rails", () => {
  it.each(rows.map((row, index) => [index, row] as const))("case %i", (_index, row) => {
    expect({ snippet: messageSnippet(row.message), featured: featuredImageUrl(row.message), tags: messageTags(row.message) }).toEqual({
      snippet: row.snippet,
      featured: row.featured,
      tags: row.tags,
    });
  });

  it("treats a missing message as blank", () => {
    expect([messageSnippet(null), featuredImageUrl(null), messageTags(null)]).toEqual(["", null, []]);
  });
});

describe("truncateAtSeparator", () => {
  it("leaves a short string alone", () => {
    expect(truncateAtSeparator("short text", 200, " ")).toBe("short text");
  });

  it("cuts at the last separator that leaves room for the omission", () => {
    expect(truncateAtSeparator("aaaa bbbb cccc", 12, " ")).toBe("aaaa bbbb...");
    expect(truncateAtSeparator("aaaa bbbb cccc", 11, " ")).toBe("aaaa...");
  });

  it("cuts mid-word when there is no separator", () => {
    expect(truncateAtSeparator("abcdefghij", 8, " ")).toBe("abcde...");
  });
});
