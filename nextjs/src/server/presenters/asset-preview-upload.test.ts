import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetched: new Map<string, string>(),
  enqueue: vi.fn(),
  variantRecordId: vi.fn(),
  variantBlobKey: vi.fn(),
}));

vi.mock("../cache/rails-cache.ts", () => ({
  railsCache: () => ({
    fetch: async (key: string, _options: unknown, block: () => Promise<string> | string) => {
      if (!mocks.fetched.has(key)) mocks.fetched.set(key, await block());
      return mocks.fetched.get(key);
    },
  }),
}));
vi.mock("../infra/active-storage.ts", () => ({
  isConfiguredService: (name: string) => name === "test",
  isVariable: (type: string) => type !== "image/svg+xml",
  publicStorageUrl: (key: string) => `https://bucket.example.com/${key}`,
  resizeToLimitDigest: (_type: string, _name: string, width: number, height: number | null) =>
    `digest-${width}-${height}`,
}));
vi.mock("../infra/cdn-url.ts", () => ({
  cdnUrlFor: (url: string) => url.replace("bucket.example.com", "cdn.example.com"),
}));
vi.mock("../jobs/enqueue.ts", () => ({ enqueue: mocks.enqueue }));
vi.mock("../models/sql.ts", () => ({ column: () => "", selectRows: vi.fn(), table: () => "" }));
vi.mock("../page-props/signed-in/reads.ts", () => ({
  variantRecordId: mocks.variantRecordId,
  variantBlobKey: mocks.variantBlobKey,
}));

import { uploadedCoverAsJson, type UploadedFile } from "./asset-preview-upload.ts";

const file = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
  attachment_id: 4n,
  blob_id: 9n,
  key: "origkey",
  filename: "cover.jpg",
  content_type: "image/jpeg",
  service_name: "test",
  metadata: '{"identified":true,"width":2000,"height":1000,"analyzed":true}',
  ...overrides,
});
const row = { guid: "g", oembed: null, unsplash_url: null };

describe("uploadedCoverAsJson", () => {
  beforeEach(() => {
    mocks.fetched.clear();
    mocks.enqueue.mockReset();
    mocks.variantRecordId.mockReset().mockResolvedValue(null);
    mocks.variantBlobKey.mockReset();
  });

  it("serves the original and enqueues the retina job while no variant exists", async () => {
    const json = await uploadedCoverAsJson(7n, row, [file()]);

    expect(json).toMatchObject({
      url: "https://cdn.example.com/origkey",
      original_url: "https://cdn.example.com/origkey",
      type: "image",
      filetype: "jpg",
      width: 670,
      height: 335,
      native_width: 2000,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith("ProcessAssetPreviewRetinaWorker", [7]);
    expect(mocks.variantRecordId).toHaveBeenCalledWith(9n, "digest-1005-null");
  });

  it("serves the processed retina variant's file beside the original", async () => {
    mocks.variantRecordId.mockResolvedValue(3n);
    mocks.variantBlobKey.mockResolvedValue("variantkey");

    const json = await uploadedCoverAsJson(7n, row, [file()]);

    expect(json).toMatchObject({
      url: "https://cdn.example.com/variantkey",
      original_url: "https://cdn.example.com/origkey",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips the variant for a GIF", async () => {
    const json = await uploadedCoverAsJson(7n, row, [file({ filename: "a.gif", content_type: "image/gif" })]);

    expect(json).toMatchObject({ url: "https://cdn.example.com/origkey", filetype: "gif" });
    expect(mocks.variantRecordId).not.toHaveBeenCalled();
  });

  it.each([
    ["a video", { content_type: "video/mp4" }],
    ["an unanalyzed image", { metadata: null }],
    ["a blob on another service", { service_name: "local" }],
  ])("hands back %s", async (_name, overrides) => {
    await expect(uploadedCoverAsJson(7n, row, [file(overrides)])).rejects.toThrow("is not ported");
  });
});
