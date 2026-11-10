import { describe, expect, it } from "vitest";

import { bookWorkExamples, ebookStructuredData } from "./product-page.ts";

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
