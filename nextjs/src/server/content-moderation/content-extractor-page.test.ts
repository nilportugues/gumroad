// Golden vectors copied from spec/services/content_moderation/content_extractor_spec.rb
// (#extract_from_page, #extract_from_post, #extract_from_product). Inputs and expected values are
// the Ruby spec's; the sanitizer is a stand-in that drops <marquee>, the one tag the vectors need
// gone (Ai::PageSanitizer is not ported).
import { describe, expect, it } from "vitest";

import {
  MAX_PAGE_LINK_TEXT_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  extractFromPage,
  extractFromPost,
  extractFromProduct,
  type PageInput,
} from "./content-extractor.ts";
import { orderedImageUrls } from "./image-selection.ts";

const SECRET = "test-secret-key-base";
const SELLER = { subdomain: "seller-studio.example.com", activeCustomDomain: null };

const options = {
  sanitizeCustomHtml: (html: string) => html.replace(/<marquee>.*?<\/marquee>/gs, ""),
  sanitizeRichContent: (html: string) => html,
  secretKeyBase: SECRET,
};

function extract(overrides: Partial<PageInput>) {
  return extractFromPage(
    {
      customHtml: null,
      content: null,
      title: "About my studio",
      seoTitle: null,
      seoDescription: null,
      seller: SELLER,
      ...overrides,
    },
    options,
  );
}

const b64 = (value: string) => Buffer.from(value).toString("base64");
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${b64(svg)}`;
const safeSvgImg = `<img src="${svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg"><text>safeharbor</text></svg>`)}">`;
const sorted = (urls: string[]) => [...urls].sort();

describe("extractFromPage", () => {
  it("includes the SEO title and description in the moderated text", () => {
    const result = extract({ content: "<p>Body</p>", seoTitle: "Search title", seoDescription: "Search description" });
    expect(result.text).toContain("Search title");
    expect(result.text).toContain("Search description");
  });

  it("moderates a video's poster image without sending the video file to the image endpoint", () => {
    const result = extract({
      customHtml: `<p>Watch the process</p>
<video src="https://public-files.gumroad.com/tce9t60y8ecmiqx1b81v1gnzj28r"
       poster="https://cdn.example.com/frame.jpg"></video>`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/frame.jpg"]);
  });

  it("collects a video's poster whether or not the element carries a src", () => {
    const result = extract({
      customHtml: `<video poster="https://cdn.example.com/no-src.jpg"></video>
<video src="https://public-files.gumroad.com/withsrc.mov"
       poster="https://cdn.example.com/with-src.jpg"></video>`,
    });
    expect(sorted(result.imageUrls)).toEqual([
      "https://cdn.example.com/no-src.jpg",
      "https://cdn.example.com/with-src.jpg",
    ]);
  });

  it("keeps an img src and a sibling video's poster, and takes neither element's other attribute", () => {
    const result = extract({
      customHtml: `<img src="https://cdn.example.com/photo.png" poster="https://cdn.example.com/ignored.jpg">
<video src="https://public-files.gumroad.com/clip.mov"
       poster="https://cdn.example.com/frame.jpg"></video>`,
    });
    expect(sorted(result.imageUrls)).toEqual([
      "https://cdn.example.com/frame.jpg",
      "https://cdn.example.com/photo.png",
    ]);
  });

  it("extracts the title, visible text, link targets, and remote image URLs", () => {
    const result = extract({
      customHtml: `<html><head><style>.a { color: red }</style></head>
<body>
  <h1>Hand-lettered posters</h1>
  <p>Printed to order.</p>
  <img src="https://cdn.example.com/poster.png">
  <a href="https://example.com/shop">My other shop</a>
</body></html>`,
    });
    expect(result.text).toContain("Title: About my studio");
    expect(result.text).toContain("Hand-lettered posters");
    expect(result.text).toContain("Printed to order.");
    expect(result.text).toContain("https://example.com/shop");
    expect(result.imageUrls).toEqual(["https://cdn.example.com/poster.png"]);
  });

  it("ignores script, style, and template bodies so framework code is not moderated as content", () => {
    const result = extract({
      customHtml: `<style>.buy { background: red }</style>
<script>const scriptOnlyToken = "gibberish payload";</script>
<noscript>Enable JavaScript</noscript>
<template><p>Cloned later</p></template>
<p>Real copy</p>`,
    });
    expect(result.text).toContain("Real copy");
    expect(result.text).not.toContain("scriptOnlyToken");
    expect(result.text).not.toContain("Enable JavaScript");
    expect(result.text).not.toContain("Cloned later");
  });

  it("reads rich text pages the same way as custom HTML pages", () => {
    const result = extract({ title: "Rich", content: "<p>Written in the editor</p>" });
    expect(result.text).toContain("Title: Rich");
    expect(result.text).toContain("Written in the editor");
  });

  it("strips the seller's own storefront host from link targets, keeping third-party links intact", () => {
    const result = extract({
      customHtml: `<a href="https://seller-studio.example.com/l/thing">Mine</a><a href="https://elsewhere.example/x">Theirs</a>`,
    });
    expect(result.text).not.toContain("seller-studio");
    expect(result.text).toContain("https://elsewhere.example/x");
  });

  it("counts only the images that survive sanitization, while still reading text the sanitizer drops", () => {
    const result = extract({
      customHtml: `<img src="https://cdn.example.com/kept.png">
<marquee>buy illegal things<img src="https://cdn.example.com/dropped.png"></marquee>`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/kept.png"]);
    expect(result.text).toContain("buy illegal things");
  });

  it("extracts every image the page can display, not just img src", () => {
    const result = extract({
      customHtml: `<img src="https://cdn.example.com/remote.png">
<img srcset="https://cdn.example.com/one.png 1x, https://cdn.example.com/two.png 2x">
<picture><source srcset="https://cdn.example.com/source.png"></picture>
<video poster="https://cdn.example.com/poster.jpg"></video>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted([
        "https://cdn.example.com/remote.png",
        "https://cdn.example.com/one.png",
        "https://cdn.example.com/two.png",
        "https://cdn.example.com/source.png",
        "https://cdn.example.com/poster.jpg",
      ]),
    );
  });

  it("extracts images whose scheme is not lowercase, which browsers render all the same", () => {
    const result = extract({
      customHtml: `<img src="HTTPS://cdn.example.com/upper.png">
<img srcset="Http://cdn.example.com/mixed.png 1x">
<video poster="HTTPS://cdn.example.com/poster.jpg"></video>
<a href="HTTPS://elsewhere.example/shop">Shop</a>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted([
        "HTTPS://cdn.example.com/upper.png",
        "Http://cdn.example.com/mixed.png",
        "HTTPS://cdn.example.com/poster.jpg",
      ]),
    );
    expect(result.text).toContain("HTTPS://elsewhere.example/shop");
  });

  it("extracts inline data: images, which render without ever being uploaded", () => {
    const result = extract({
      customHtml: `<img src="data:image/png;base64,AAAA">
<img srcset="data:image/png;base64,BBBB 1x, https://cdn.example.com/remote.png 2x">`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "https://cdn.example.com/remote.png"]),
    );
  });

  it("re-encodes a percent-encoded raster data URL into the base64 form the classifier can review", () => {
    const result = extract({
      customHtml: `<style>.tile { background-image: url("data:image/png,%89PNG%0D%0A") }</style>`,
    });
    expect(result.imageUrls).toEqual([
      `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64")}`,
    ]);
  });

  it("reviews a self-contained SVG data URL as markup text instead of blocking the page on it", () => {
    const grain =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E" +
      "%3Cfilter id='grainy'%3E%3CfeTurbulence baseFrequency='0.9'/%3E%3C/filter%3E" +
      "%3Crect width='100' height='100' filter='url(%23grainy)'/%3E%3C/svg%3E";
    const result = extract({ customHtml: `<style>.grain::before { background-image: url("${grain}") }</style>` });
    expect(result.imageUrls).toEqual([]);
    expect(result.text).toContain("feTurbulence");
  });

  it("reviews a base64 SVG data URL's text the same way, including words rendered by <text>", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>buy illegal things</text></svg>`;
    const result = extract({ customHtml: `<img src="data:image/svg+xml;base64,${b64(svg)}">` });
    expect(result.imageUrls).toEqual([]);
    expect(result.text).toContain("buy illegal things");
  });

  describe("SVG data URLs that stay on the image list", () => {
    // Each pairs the unsafe SVG with a safe one on the same page, so a parser that stopped
    // discriminating fails instead of passing vacuously.
    const keptAsImage = (svg: string) => {
      const url = svgDataUrl(svg);
      const result = extract({ customHtml: `<img src="${url}">${safeSvgImg}` });
      expect(result.imageUrls).toEqual([url]);
      expect(result.text).toContain("safeharbor");
      return result;
    };
    const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

    it("keeps an SVG that embeds another image", () => {
      const result = keptAsImage(wrap(`<image href="data:image/png;base64,AAAA"/>`));
      expect(result.text).not.toContain("AAAA");
    });

    it("keeps an SVG whose foreignObject could render arbitrary HTML", () => {
      keptAsImage(wrap(`<foreignObject><div>anything</div></foreignObject>`));
    });

    it("keeps an SVG that references anything outside itself", () => {
      keptAsImage(wrap(`<use href="https://elsewhere.example/sprite.svg#icon"/>`));
    });

    it("keeps an SVG whose CSS hides a nested payload behind an escape", () => {
      keptAsImage(wrap(`<rect style="mask-image:url(\\64 ata:image/png;base64,AAAA)"/>`));
    });

    it("keeps an SVG whose CSS loads a nested payload as an image-set string", () => {
      keptAsImage(wrap(`<rect style="mask-image:image-set('data:image/png;base64,AAAA' 1x)"/>`));
    });

    it("keeps an SVG whose image-set string hides the payload behind a CSS escape", () => {
      keptAsImage(wrap(`<rect style="mask-image:image-set('\\64 ata:image/png;base64,AAAA' 1x)"/>`));
    });

    it("keeps an SVG whose image-set string references a remote image", () => {
      keptAsImage(wrap(`<rect style="mask-image:image-set('https://elsewhere.example/x.png' 1x)"/>`));
    });

    it("keeps an SVG that hides a nested payload behind an XML entity", () => {
      keptAsImage(wrap(`<set attributeName="href" to="&#100;ata:image/png;base64,AAAA"/>`));
    });

    it("keeps a data URL whose payload is not the SVG it claims to be", () => {
      keptAsImage("<html><p>not svg</p></html>");
    });

    it("keeps an SVG whose decoded source exceeds the SVG text budget", () => {
      keptAsImage(wrap(`<text>${"padding ".repeat(700)}</text>`));
    });

    it("keeps an SVG whose style element loads another image", () => {
      keptAsImage(wrap(`<style>.a { fill: url(https://elsewhere.example/p.svg#x) }</style><rect class="a"/>`));
    });

    it("keeps an SVG that imports a stylesheet", () => {
      keptAsImage(wrap(`<style>@import "https://elsewhere.example/a.css";</style>`));
    });
  });

  it("keeps an SVG past the aggregate text budget on the image list instead of truncating it out of review", () => {
    const first = `<svg xmlns="http://www.w3.org/2000/svg"><text>firstmarker ${"padding ".repeat(400)}</text></svg>`;
    const second = `<svg xmlns="http://www.w3.org/2000/svg"><text>overflowmarker ${"padding ".repeat(400)}</text></svg>`;
    const result = extract({ customHtml: `<img src="${svgDataUrl(first)}">\n<img src="${svgDataUrl(second)}">` });
    expect(result.imageUrls).toEqual([svgDataUrl(second)]);
    expect(result.text).toContain("firstmarker");
    expect(result.text).not.toContain("overflowmarker");
  });

  it("re-encodes a raster data URL whose scheme is uppercase, which browsers render all the same", () => {
    const result = extract({ customHtml: `<img src="DATA:image/png,PNG%20payload">` });
    expect(result.imageUrls).toEqual([`data:image/png;base64,${b64("PNG payload")}`]);
  });

  it("honors ;base64 only as the final parameter, as the data-URL grammar positions it", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>positional flag</text></svg>`;
    const url = `data:image/svg+xml;base64;charset=utf-8,${encodeURIComponent(svg)}`;
    const result = extract({ customHtml: `<img src="${url}">` });
    expect(result.imageUrls).toEqual([]);
    expect(result.text).toContain("positional flag");
  });

  it("extracts images painted by CSS, which render without any img tag", () => {
    const result = extract({
      customHtml: `<div style="background-image: url('https://cdn.example.com/inline.png')">Studio</div>
<style>
  .hero { background: url(data:image/png;base64,AAAA) no-repeat }
  @media screen { .promo { border-image: url("https://cdn.example.com/media.png") } }
</style>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted(["https://cdn.example.com/inline.png", "data:image/png;base64,AAAA", "https://cdn.example.com/media.png"]),
    );
  });

  it("reads CSS as a browser tokenizes it, so escapes and custom properties cannot hide an image", () => {
    const result = extract({
      customHtml: `<style>
  .a { background-image: /* comment */ url(\\68ttps://cdn.example.com/escaped.png) }
  .b { --bg: url("https://cdn.example.com/var.png") }
  .c { background-image: var(--bg) }
  .d { background-image: image-set(url("https://cdn.example.com/set.png") 1x) }
</style>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted([
        "https://cdn.example.com/escaped.png",
        "https://cdn.example.com/var.png",
        "https://cdn.example.com/set.png",
      ]),
    );
  });

  it("recovers images painted through CSS nesting, which the parser cannot structure but browsers render", () => {
    const result = extract({
      customHtml: `<style>
  .card {
    --seller-image: url("https://cdn.example.com/nested-var.png");
    & .hero { background-image: var(--seller-image) }
    & .side { .deep { background-image: url("https://cdn.example.com/deep.png") } }
  }
  @media screen {
    .promo { & .banner { background: url("https://cdn.example.com/media-nested.png") } }
  }
</style>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted([
        "https://cdn.example.com/nested-var.png",
        "https://cdn.example.com/deep.png",
        "https://cdn.example.com/media-nested.png",
      ]),
    );
  });

  it("leaves unused custom-property URLs out, so a URL nothing renders cannot block a page", () => {
    const result = extract({
      customHtml: `<style>
  :root { --unused: url("https://dead.example.com/never-rendered.png") }
  .a { --indirect: url("https://cdn.example.com/chained.png") }
  .b { --painted: var(--indirect) }
</style>
<div style="background-image: var(--painted, var(--fallback))"></div>
<style>
  .c { --fallback: url("https://cdn.example.com/fallback.png") }
  .d { color: var(--unused-by-a-non-image-property) }
  .e { --unused-by-a-non-image-property: url("https://dead.example.com/text-only.png") }
</style>`,
    });
    expect(sorted(result.imageUrls)).toEqual(
      sorted(["https://cdn.example.com/chained.png", "https://cdn.example.com/fallback.png"]),
    );
  });

  it("leaves font URLs out of the image set, so a custom font cannot block a page", () => {
    const result = extract({
      customHtml: `<style>
  @font-face { font-family: brand; src: url("https://fonts.gstatic.com/f.woff2") }
  h1 { font-family: brand; background: url("https://cdn.example.com/hero.png") }
</style>`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/hero.png"]);
  });

  it("excludes relative image sources, which have no absolute form to send", () => {
    const result = extract({
      customHtml: `<img src="/local/asset.png"><img src="https://cdn.example.com/remote.png">`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/remote.png"]);
  });

  it("truncates the text so one page cannot make an unbounded moderation call", () => {
    const result = extract({ customHtml: `<p>${"word ".repeat(8_000)}</p>` });
    expect(result.text.length).toBeLessThanOrEqual(MAX_PAGE_TEXT_LENGTH + MAX_PAGE_LINK_TEXT_LENGTH);
    expect(result.text.endsWith("word")).toBe(true);
  });

  it("returns every remote image, so the caller can reject a page it cannot fully review", () => {
    const images = Array.from({ length: 30 }, (_, n) => `<img src="https://cdn.example.com/${n + 1}.png">`).join("");
    expect(extract({ customHtml: images }).imageUrls).toHaveLength(30);
  });

  it("keeps link targets when the prose alone would exhaust the whole text budget", () => {
    const result = extract({
      customHtml: `<p>${"word ".repeat(8_000)}</p><a href="https://linkfarm.example/deals">deals</a>`,
    });
    expect(result.text).toContain("https://linkfarm.example/deals");
  });

  it("orders the images the same way on every extraction and not in document order", () => {
    const urls = Array.from({ length: 60 }, (_, n) => `https://cdn.example.com/${n + 1}.png`);
    const html = urls.map((url) => `<img src="${url}">`).join("");

    const selections = Array.from({ length: 5 }, () => extract({ customHtml: html }).imageUrls);
    expect(new Set(selections.map((selection) => selection.join("|"))).size).toBe(1);
    expect(selections[0]).toHaveLength(60);
    expect(selections[0]).toEqual(orderedImageUrls(urls, SECRET));
    expect(selections[0]).not.toEqual(urls);
  });

  it("reads a product landing page takeover, whose owner is the product's seller", () => {
    expect(extract({ customHtml: "<p>Buy my thing</p>" }).text).toContain("Buy my thing");
  });

  it("decodes character references in attributes the way libxml2 does", () => {
    const result = extract({
      customHtml: `<a href="https://elsewhere.example/?a=1&amp;b=2">x</a><img src="https://cdn.example.com/a.png?x=1&#38;y=2">`,
    });
    expect(result.text).toContain("https://elsewhere.example/?a=1&b=2");
    expect(result.imageUrls).toEqual(["https://cdn.example.com/a.png?x=1&y=2"]);
  });
});

describe("extractFromPost", () => {
  const post = {
    name: "Moderated Post",
    message: `<div><p>Hello <strong>world</strong></p><img src="https://cdn.example.com/post.png"></div>`,
    seller: SELLER,
  };

  it("extracts text and images", () => {
    expect(extractFromPost(post)).toEqual({
      text: "Name: Moderated Post Message: Hello world",
      imageUrls: ["https://cdn.example.com/post.png"],
    });
  });

  it("ignores images without a src attribute", () => {
    const result = extractFromPost({
      ...post,
      message: `<div><p>Hello</p><img><img src="https://cdn.example.com/post.png"></div>`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/post.png"]);
  });

  it("ignores images with an empty src attribute", () => {
    const result = extractFromPost({
      ...post,
      message: `<div><p>Hello</p><img src=""><img src="https://cdn.example.com/post.png"></div>`,
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/post.png"]);
  });

  describe("when the message links to the seller's own first-party storefront", () => {
    const own = "https://seller-studio.example.com";

    it("strips the seller's own subdomain URL from the moderated text", () => {
      const result = extractFromPost({ ...post, name: "Weekly update", message: `<p>New drop here: ${own}</p>` });
      expect(result.text).not.toContain("seller-studio");
      expect(result.text).toContain("New drop here:");
    });

    it("leaves third-party URLs intact so off-site abuse is still moderated", () => {
      const result = extractFromPost({
        ...post,
        message: `<p>Mine: ${own} and theirs: https://evil.example.com/scam</p>`,
      });
      expect(result.text).not.toContain("seller-studio");
      expect(result.text).toContain("https://evil.example.com/scam");
    });

    it("does not strip an unverified custom domain (only active ones are first-party)", () => {
      // The caller passes activeCustomDomain only for an active domain, so an unverified one is null here.
      const result = extractFromPost({ ...post, message: `<p>Check https://unverified-offsite.example.com/x</p>` });
      expect(result.text).toContain("https://unverified-offsite.example.com/x");
    });

    it("strips an active custom domain", () => {
      const result = extractFromPost({
        ...post,
        seller: { subdomain: null, activeCustomDomain: "shop.example.net" },
        message: `<p>Check https://shop.example.net/x</p>`,
      });
      expect(result.text).not.toContain("shop.example.net");
    });

    it("preserves path/query text on the seller's own URL so it is still moderated", () => {
      const result = extractFromPost({ ...post, message: `<p>See ${own}/forbidden-term?q=alsoflagged</p>` });
      expect(result.text).not.toContain("seller-studio");
      expect(result.text).toContain("forbidden-term");
      expect(result.text).toContain("alsoflagged");
    });
  });
});

describe("extractFromProduct", () => {
  const product = {
    name: "Moderated Product",
    description: `<p>Main description</p><img src="https://cdn.example.com/description.png">`,
    seller: SELLER,
    richContentDescriptions: [
      [
        { type: "paragraph", content: [{ type: "text", text: "Rich content body" }] },
        { type: "image", attrs: { src: "https://cdn.example.com/rich-content.png" } },
      ],
    ],
    coverImageUrls: ["https://cdn.example.com/cover.jpg"],
    thumbnailImageUrl: "https://cdn.example.com/thumbnail.png",
    richContentFileImageUrls: ["https://signed.example.com/file.png"],
  };

  it("extracts product text and image URLs", () => {
    const result = extractFromProduct(product);
    expect(result.text).toContain("Name: Moderated Product");
    expect(result.text).toContain("Main description");
    expect(result.text).toContain("Rich content body");
    expect(result.imageUrls).toEqual([
      "https://cdn.example.com/cover.jpg",
      "https://cdn.example.com/thumbnail.png",
      "https://cdn.example.com/description.png",
      "https://signed.example.com/file.png",
      "https://cdn.example.com/rich-content.png",
    ]);
  });

  it("handles nil and empty URLs from cover image previews without raising", () => {
    const result = extractFromProduct({
      ...product,
      coverImageUrls: [null, "https://cdn.example.com/valid.png", ""],
      thumbnailImageUrl: null,
      richContentFileImageUrls: [],
      richContentDescriptions: [],
      description: "<p>Description</p>",
    });
    expect(result.imageUrls).toEqual(["https://cdn.example.com/valid.png"]);
  });
});
