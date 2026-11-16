import type { ProductFile } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resizeToLimitDigest } from "../../infra/active-storage.ts";
import { NotPortedError } from "../not-ported.ts";

import { productFileThumbnailJson, videoFileThumbnailUrl } from "./thumbnails.ts";

const reads = vi.hoisted(() => ({
  attachmentsOf: vi.fn(),
  blobById: vi.fn(),
  variantRecordId: vi.fn(),
  variantBlobKey: vi.fn(),
}));
vi.mock("./reads.ts", () => reads);
const cache = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../cache/rails-cache.ts", () => ({ railsCache: () => cache }));
vi.mock("../../infra/active-storage.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/active-storage.ts")>()),
  isConfiguredService: () => true,
  publicStorageUrl: (key: string) => `https://storage.example.com/${key}`,
}));
vi.mock("../../infra/cdn-url.ts", () => ({
  cdnUrlFor: (url: string) => url.replace("https://storage.example.com/", "https://cdn.example.com/"),
}));

const SECRET_KEY_BASE = "thumbnails-test-secret";
const blob = (attributes: Record<string, unknown> = {}) => ({
  id: 9n,
  key: "orig-key",
  filename: "cover.png",
  content_type: "image/png",
  service_name: "test",
  ...attributes,
});
const video = { id: 1n, filetype: "mp4", filegroup: "video" } as ProductFile;
const image = { id: 2n, filetype: "png", filegroup: "image" } as ProductFile;
const pdf = { id: 3n, filetype: "pdf", filegroup: "document" } as ProductFile;

beforeEach(() => {
  process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
  vi.resetAllMocks();
  reads.attachmentsOf.mockResolvedValue([{ id: 5n, blob_id: 9n }]);
  reads.blobById.mockResolvedValue(blob());
  cache.fetch.mockImplementation(async (_name: string, _options: unknown, block: () => unknown) => block());
});

describe("productFileThumbnailJson", () => {
  it("serves an image's own file for a browser-renderable image, with the blob's signed id", async () => {
    const json = await productFileThumbnailJson(image);

    expect(json).toMatchObject({ url: "https://cdn.example.com/orig-key", status: { type: "saved" } });
    expect(json?.signed_id).toMatch(/^eyJfcmFpbHMiOnsiZGF0YSI6OSwicHVyIjoiYmxvYl9pZCJ9fQ==--[0-9a-f]{40}$/u);
  });

  it("serves the processed 1280x720 variant of a video's thumbnail", async () => {
    reads.variantRecordId.mockResolvedValue(70n);
    reads.variantBlobKey.mockResolvedValue("variant-key");

    const json = await productFileThumbnailJson(video);

    expect(json?.url).toBe("https://cdn.example.com/variant-key");
    expect(reads.variantRecordId).toHaveBeenCalledWith(9n, resizeToLimitDigest("image/png", "cover.png", 1280, 720));
    expect(cache.fetch.mock.calls[0]![0]).toBe("attachment_product_file_thumbnail_5_variant_url");
  });

  it("returns the cached variant URL without looking up the variant record", async () => {
    cache.fetch.mockResolvedValue("https://storage.example.com/cached-key");

    expect((await productFileThumbnailJson(video))?.url).toBe("https://cdn.example.com/cached-key");
    expect(reads.variantRecordId).not.toHaveBeenCalled();
  });

  it("hands back when no variant record exists yet", async () => {
    reads.variantRecordId.mockResolvedValue(null);

    await expect(productFileThumbnailJson(video)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("falls back to the original's URL for a thumbnail type with no variant", async () => {
    reads.blobById.mockResolvedValue(blob({ content_type: "image/webp", filename: "cover.webp" }));

    expect((await productFileThumbnailJson(video))?.url).toBe("https://cdn.example.com/orig-key");
    expect(reads.variantRecordId).not.toHaveBeenCalled();
  });

  it("has no thumbnail for a file that is neither streamable nor a browser-renderable image", async () => {
    expect(await productFileThumbnailJson(pdf)).toBeNull();
    expect(reads.attachmentsOf).not.toHaveBeenCalled();
  });

  it("has no thumbnail when none is attached", async () => {
    reads.attachmentsOf.mockResolvedValue([]);

    expect(await productFileThumbnailJson(video)).toBeNull();
  });
});

describe("videoFileThumbnailUrl", () => {
  it("prefers the processed preview variant", async () => {
    reads.variantRecordId.mockResolvedValue(70n);
    reads.variantBlobKey.mockResolvedValue("variant-key");

    expect(await videoFileThumbnailUrl(4n)).toBe("https://cdn.example.com/variant-key");
    expect(reads.attachmentsOf).toHaveBeenCalledWith("VideoFile", 4n, "thumbnail");
  });

  it("falls back to the original when the variant is not processed", async () => {
    reads.variantRecordId.mockResolvedValue(null);

    expect(await videoFileThumbnailUrl(4n)).toBe("https://cdn.example.com/orig-key");
  });

  it("is nil without an attachment", async () => {
    reads.attachmentsOf.mockResolvedValue([]);

    expect(await videoFileThumbnailUrl(4n)).toBeNull();
  });
});
