import { afterEach, describe, expect, it } from "vitest";

import { namespacedKey } from "../infra/redis.ts";
import { setCurrencyDepsForTesting } from "../models/concerns/currency-helper.ts";
import { bookWorkExamples, ebookStructuredData, offerPrice, usdOfferPriceCents } from "./product-page.ts";

// Product::StructuredData#build_ebook_structured_data and #build_book_work_examples.
describe("bookWorkExamples", () => {
  it("names each file with its upcased filetype and keeps the isbn when there is one", () => {
    expect(
      bookWorkExamples("Guide", [
        { filetype: "pdf", isbn: "978-3-16-1484100" },
        { filetype: "epub", isbn: null },
        { filetype: "mobi", isbn: "   " },
      ]),
    ).toEqual([
      { "@type": "Book", bookFormat: "EBook", name: "Guide (PDF)", isbn: "978-3-16-1484100" },
      { "@type": "Book", bookFormat: "EBook", name: "Guide (EPUB)" },
      { "@type": "Book", bookFormat: "EBook", name: "Guide (MOBI)" },
    ]);
  });

  it("is empty without files", () => {
    expect(bookWorkExamples("Guide", [])).toEqual([]);
  });
});

describe("ebookStructuredData", () => {
  const offers = { "@type": "Offer", priceCurrency: "USD", availability: "https://schema.org/InStock", url: "https://seller.example.com/l/abc", price: 5 };
  const base = { name: "Guide", authorName: "Parity Seller", description: "A guide", url: "https://seller.example.com/l/abc", sku: "abc", workExamples: [], offers };

  it("is a Book with the author, in Rails' key order, and no brand", () => {
    const data = ebookStructuredData(base);

    expect(Object.keys(data)).toEqual(["@context", "@type", "name", "author", "description", "url", "sku", "offers"]);
    expect(data["@type"]).toBe("Book");
    expect(data.author).toEqual({ "@type": "Person", name: "Parity Seller" });
    expect(data).not.toHaveProperty("brand");
  });

  it("places workExample before the offers when files support an isbn", () => {
    const workExamples = bookWorkExamples("Guide", [{ filetype: "pdf", isbn: null }]);

    expect(Object.keys(ebookStructuredData({ ...base, workExamples }))).toEqual(["@context", "@type", "name", "author", "description", "url", "sku", "workExample", "offers"]);
  });

  it("keeps a null author name inside the author object", () => {
    expect(ebookStructuredData({ ...base, authorName: null }).author).toEqual({ "@type": "Person", name: null });
  });
});

// Product::StructuredData#build_offer_data
describe("offerPrice", () => {
  it("keeps a USD price in dollars", () => {
    expect(offerPrice("usd", 500, 500)).toEqual({ priceCurrency: "USD", price: 5 });
  });

  it("falls back to the product's own currency and amount without a USD conversion", () => {
    expect(offerPrice("eur", 1250, null)).toEqual({ priceCurrency: "EUR", price: 12.5 });
  });

  it("does not divide a single-unit currency by 100", () => {
    expect(offerPrice("jpy", 500, null)).toEqual({ priceCurrency: "JPY", price: 500 });
  });

  it("reports a converted price as USD", () => {
    expect(offerPrice("eur", 1000, 1080)).toEqual({ priceCurrency: "USD", price: 10.8 });
  });

  it("drops the price along with a blank currency", () => {
    expect(offerPrice(null, 500, null)).toEqual({ priceCurrency: undefined, price: undefined });
    expect(offerPrice("  ", 500, null)).toEqual({ priceCurrency: undefined, price: undefined });
  });

  it("keeps the currency without a price", () => {
    expect(offerPrice("eur", null, null)).toEqual({ priceCurrency: "EUR", price: undefined });
  });
});

describe("usdOfferPriceCents", () => {
  const rates = (stored: Record<string, string>, failing = false) =>
    setCurrencyDepsForTesting({
      redis: () =>
        ({
          get: async (key: string) => {
            if (failing) throw new Error("Connection refused");
            return stored[key] ?? null;
          },
          set: async () => "OK",
        }) as never,
    });
  afterEach(() => setCurrencyDepsForTesting(undefined));

  it("is the price itself for USD and nil without a price", async () => {
    expect(await usdOfferPriceCents("usd", 500)).toBe(500);
    expect(await usdOfferPriceCents("eur", null)).toBeNull();
  });

  it("converts with the cached rate", async () => {
    rates({ [namespacedKey("currencies", "EUR")]: "0.5" });

    expect(await usdOfferPriceCents("eur", 1000)).toBe(2000);
  });

  it("is nil for a missing, non-positive or unreadable rate", async () => {
    rates({ [namespacedKey("currencies", "GBP")]: "0" });
    expect(await usdOfferPriceCents("eur", 1000)).toBeNull();
    expect(await usdOfferPriceCents("gbp", 1000)).toBeNull();
    expect(await usdOfferPriceCents(null, 1000)).toBeNull();

    rates({}, true);
    expect(await usdOfferPriceCents("eur", 1000)).toBeNull();
  });
});
