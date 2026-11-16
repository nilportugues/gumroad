import { describe, expect, it } from "vitest";

import {
  decodeDataUrlPayload,
  extractRichText,
  isInlineImageUrl,
  isRemoteUrl,
  normalizeHost,
  parseDataUrl,
  partitionPageImages,
  richContentText,
  sellerFirstPartyHosts,
  srcsetUrls,
  stripSellerFirstPartyUrls,
  truncateOnBoundary,
} from "./content-extractor.ts";

describe("truncateOnBoundary", () => {
  it("cuts at the last whitespace before the limit so no word is bisected", () => {
    expect(truncateOnBoundary("aaa bbb ccc", 6)).toBe("aaa");
  });

  it("returns the text untouched when it fits", () => {
    expect(truncateOnBoundary("aaa bbb", 7)).toBe("aaa bbb");
  });

  it("cuts without a boundary when the cut has no whitespace", () => {
    expect(truncateOnBoundary("abcdefgh", 3)).toBe("abc");
  });
});

describe("remote and inline URL predicates", () => {
  it("accepts an upper-case scheme, as browsers do", () => {
    expect(isRemoteUrl("HTTPS://cdn.example.com/a.png")).toBe(true);
    expect(isInlineImageUrl("DATA:IMAGE/png;base64,AAAA")).toBe(true);
    expect(isRemoteUrl("/relative.png")).toBe(false);
  });
});

describe("parseDataUrl", () => {
  it("reads the content type lower-cased and a trailing base64 flag", () => {
    expect(parseDataUrl("data:Image/PNG;base64,QUJD")).toEqual({
      contentType: "image/png",
      base64: true,
      payload: "QUJD",
    });
  });

  it("does not treat a base64 word before other parameters as the encoding", () => {
    expect(parseDataUrl("data:text/plain;base64;charset=x,abc")?.base64).toBe(false);
  });

  it("returns nothing when there is no comma", () => {
    expect(parseDataUrl("data:image/png")).toBeNull();
  });
});

describe("decodeDataUrlPayload", () => {
  it("percent-decodes leniently, keeping a bare percent sign literal", () => {
    const parsed = parseDataUrl("data:image/svg+xml,a%20b%zz");
    expect(decodeDataUrlPayload(parsed!).toString("utf8")).toBe("a b%zz");
  });
});

describe("srcsetUrls", () => {
  it("splits candidates without splitting the comma inside a data URL", () => {
    expect(srcsetUrls("a.png 1x, data:image/png;base64,AAA 2x, https://x.com/b.png 3x")).toEqual([
      "a.png",
      "data:image/png;base64,AAA",
      "https://x.com/b.png",
    ]);
  });
});

describe("rich content text", () => {
  it("collects every text node depth-first", () => {
    const description = [
      { type: "doc", content: [{ text: "Hello" }, { type: "paragraph", content: [{ type: "text", text: "World" }] }] },
    ];
    expect(extractRichText(description)).toEqual(["Hello", "World"]);
    expect(richContentText([description])).toBe("Hello World");
  });
});

describe("seller first-party URLs", () => {
  it("removes only the host of the seller's own URL and keeps its path and query", () => {
    expect(
      stripSellerFirstPartyUrls("visit https://alice.gumroad.com/p/x?q=1 or https://other.com/a", ["alice.gumroad.com"]),
    ).toBe("visit /p/x?q=1 or https://other.com/a");
  });

  it("leaves a third-party URL intact", () => {
    expect(stripSellerFirstPartyUrls("see https://other.com/a", ["alice.gumroad.com"])).toBe("see https://other.com/a");
  });

  it("matches the host without the port that a subdomain value carries in development", () => {
    expect(normalizeHost("alice.test.gumroad.com:31337")).toBe("alice.test.gumroad.com");
    expect(sellerFirstPartyHosts({ subdomain: "alice.test.gumroad.com:31337", activeCustomDomain: null })).toEqual([
      "alice.test.gumroad.com",
    ]);
  });
});

describe("partitionPageImages", () => {
  const urls = [
    "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    "https://x/a.png",
    "data:image/png;base64,QUJD",
    "data:image/jpeg,%41%42",
  ];

  it("moves a self-contained SVG to text review and re-encodes a percent-encoded raster", () => {
    expect(partitionPageImages(urls, () => true)).toEqual([
      ["https://x/a.png", "data:image/png;base64,QUJD", "data:image/jpeg;base64,QUI="],
      ["<svg></svg>"],
    ]);
  });

  it("keeps an SVG the check rejects on the image list, as the original URL", () => {
    const [images, svg] = partitionPageImages(urls, () => false);
    expect(images).toContain("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");
    expect(svg).toEqual([]);
  });
});
