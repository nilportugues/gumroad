import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({ selectRows: vi.fn() }));
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows: sql.selectRows,
}));
const reads = vi.hoisted(() => ({
  attachmentsOf: vi.fn(),
  blobById: vi.fn(),
  variantRecordId: vi.fn(),
  variantBlobKey: vi.fn(),
}));
vi.mock("../signed-in/reads.ts", () => reads);
vi.mock("../../infra/active-storage.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/active-storage.ts")>()),
  isConfiguredService: (name: string) => name === "test",
  publicStorageUrl: (key: string) => `https://files.example.com/${key}`,
}));
vi.mock("../../infra/cdn-url.ts", () => ({ cdnUrlFor: (url: string) => url }));

import { NotPortedError } from "../not-ported.ts";

import { thumbnailUrl } from "./products.ts";

const blob = (overrides = {}) => ({
  id: 5n,
  key: "abc123",
  filename: "lemons.png",
  content_type: "image/png",
  service_name: "test",
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  sql.selectRows.mockResolvedValue([{ id: 9n, unsplash_url: null }]);
  reads.attachmentsOf.mockResolvedValue([{ id: 1n, blob_id: 5n }]);
});

describe("thumbnailUrl for an uploaded file", () => {
  it("answers nothing for a thumbnail without a file", async () => {
    reads.attachmentsOf.mockResolvedValue([]);
    expect(await thumbnailUrl(1n)).toBeNull();
  });

  it("answers the file's own URL for a gif, which Rails does not transform", async () => {
    reads.blobById.mockResolvedValue(blob({ key: "gifkey", filename: "a.gif", content_type: "image/gif" }));
    expect(await thumbnailUrl(1n)).toContain("/gifkey");
    expect(reads.variantRecordId).not.toHaveBeenCalled();
  });

  it("answers the file's own URL for a file Active Storage cannot make a variant of", async () => {
    reads.blobById.mockResolvedValue(blob({ key: "pdfkey", content_type: "application/pdf" }));
    expect(await thumbnailUrl(1n)).toContain("/pdfkey");
  });

  it("answers the URL of the processed 600px variant", async () => {
    reads.blobById.mockResolvedValue(blob());
    reads.variantRecordId.mockResolvedValue(7n);
    reads.variantBlobKey.mockResolvedValue("variantkey");
    expect(await thumbnailUrl(1n)).toContain("/variantkey");
  });

  it("hands back a variant Rails has not processed yet", async () => {
    reads.blobById.mockResolvedValue(blob());
    reads.variantRecordId.mockResolvedValue(null);
    await expect(thumbnailUrl(1n)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("hands back a blob on a storage service this app is not configured for", async () => {
    reads.blobById.mockResolvedValue(blob({ service_name: "elsewhere" }));
    await expect(thumbnailUrl(1n)).rejects.toBeInstanceOf(NotPortedError);
  });
});
