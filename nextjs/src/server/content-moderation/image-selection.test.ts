import { describe, expect, it } from "vitest";

import { boundedImageUrls, orderedImageUrls } from "./image-selection.ts";

const SECRET = "test-secret-key-base";
const urls = Array.from({ length: 40 }, (_, n) => `https://cdn.example.com/${n}.png`);

describe("orderedImageUrls", () => {
  it("sorts by the HMAC-SHA256 digest of each URL under the secret", () => {
    // The digests were computed with `openssl dgst -sha256 -hmac` over the same key and URL:
    // 0.png -> 1cd887…fb9d and late.png -> c818e7…f8f8, so 0.png sorts first.
    const pair = orderedImageUrls(["https://cdn.example.com/late.png", "https://cdn.example.com/0.png"], SECRET);
    expect(pair).toEqual(["https://cdn.example.com/0.png", "https://cdn.example.com/late.png"]);
  });

  it("returns every URL", () => {
    expect([...orderedImageUrls(urls, SECRET)].sort()).toEqual([...urls].sort());
  });

  it("returns the same order on every call, so a retry moderates the same images", () => {
    const orders = [0, 1, 2].map(() => orderedImageUrls(urls, SECRET).join("\n"));
    expect(new Set(orders).size).toBe(1);
  });

  it("does not return document order, so images cannot be parked past a cap", () => {
    expect(orderedImageUrls(urls, SECRET)).not.toEqual(urls);
  });

  it("orders a URL independently of the other URLs present", () => {
    const before = orderedImageUrls(urls, SECRET);
    const after = orderedImageUrls([...urls, "https://cdn.example.com/late.png"], SECRET);
    expect(after.filter((url) => url !== "https://cdn.example.com/late.png")).toEqual(before);
  });

  it("changes the order when the secret changes, so a seller cannot predict which images are kept", () => {
    expect(orderedImageUrls(urls, SECRET)).not.toEqual(orderedImageUrls(urls, "another-secret"));
  });
});

describe("boundedImageUrls", () => {
  it("takes the first limit of the deterministic order", () => {
    expect(boundedImageUrls(urls, 5, SECRET)).toEqual(orderedImageUrls(urls, SECRET).slice(0, 5));
  });

  it("returns everything, untouched, when the set already fits", () => {
    const short = urls.slice(0, 3);
    expect(boundedImageUrls(short, 5, SECRET)).toEqual(short);
  });

  it("picks the same subset on every call", () => {
    const picks = [0, 1, 2].map(() => boundedImageUrls(urls, 5, SECRET).join("\n"));
    expect(new Set(picks).size).toBe(1);
  });
});
