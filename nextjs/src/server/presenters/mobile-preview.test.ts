import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows, uploadedFiles } = vi.hoisted(() => ({ selectRows: vi.fn(), uploadedFiles: vi.fn() }));

vi.mock("../models/sql.ts", () => ({ column: () => "", selectRows, table: () => "" }));
vi.mock("./asset-preview-upload.ts", () => ({ uploadedFiles }));

import { mobilePreview } from "./mobile-preview.ts";

const oembed = (html: string, info: string) => `---\nhtml: ${JSON.stringify(html)}\ninfo:\n${info}`;
const youtube = oembed(
  "<iframe src='https://www.youtube.com/embed/abc'></iframe>",
  "  width: 800\n  height: 450\n  thumbnail_url: https://i.ytimg.com/a.jpg\n",
);
const row = (overrides = {}) => ({ id: 1n, guid: "g", oembed: null, unsplash_url: null, ...overrides });

describe("mobilePreview", () => {
  beforeEach(() => {
    selectRows.mockReset();
    uploadedFiles.mockReset().mockResolvedValue(new Map());
  });

  it("leaves the fields empty for a product without a cover", async () => {
    selectRows.mockResolvedValue([]);

    expect(await mobilePreview(5n, "https://example.com/t.png")).toEqual({
      preview: null,
      thumbnailOrCoverUrl: "https://example.com/t.png",
    });
  });

  it("reads an oEmbed player of a mobile provider with its thumbnail and a tall size", async () => {
    selectRows.mockResolvedValue([row({ oembed: youtube })]);

    const { preview, thumbnailOrCoverUrl } = await mobilePreview(5n, null);

    expect(preview).toEqual({
      previewUrl: "https://i.ytimg.com/a.jpg",
      previewOembedUrl: "https://www.youtube.com/embed/abc",
      previewHeight: 376,
      previewWidth: 670,
    });
    expect(thumbnailOrCoverUrl).toBeNull();
  });

  it("reports no player URL for a provider the apps cannot embed and no height under the floor", async () => {
    selectRows.mockResolvedValue([
      row({ oembed: oembed("<iframe src='https://example.com/p'></iframe>", "  width: 300\n  height: 100\n") }),
    ]);

    expect((await mobilePreview(5n, null)).preview).toMatchObject({
      previewUrl: "https://example.com/p",
      previewOembedUrl: "",
      previewHeight: 0,
      previewWidth: 300,
    });
  });

  it("takes the first photo of the covers as the thumbnail when the product has none", async () => {
    selectRows.mockResolvedValue([
      row({ oembed: youtube }),
      row({ id: 2n, unsplash_url: "https://images.example.com/b.jpg" }),
    ]);

    expect((await mobilePreview(5n, null)).thumbnailOrCoverUrl).toBe("https://images.example.com/b.jpg");
    expect((await mobilePreview(5n, "https://example.com/t.png")).thumbnailOrCoverUrl).toBe(
      "https://example.com/t.png",
    );
  });

  it("prints a photo cover as the preview URL with no size", async () => {
    selectRows.mockResolvedValue([row({ unsplash_url: "https://images.example.com/b.jpg" })]);

    expect((await mobilePreview(5n, null)).preview).toEqual({
      previewUrl: "https://images.example.com/b.jpg",
      previewOembedUrl: "",
      previewHeight: 0,
      previewWidth: 0,
    });
  });

  it("hands back a product with an uploaded cover and a cover that is a photo and a document", async () => {
    selectRows.mockResolvedValue([row({ unsplash_url: "https://images.example.com/b.jpg" })]);
    uploadedFiles.mockResolvedValue(new Map([[1n, []]]));
    await expect(mobilePreview(5n, null)).rejects.toThrow("not ported");

    uploadedFiles.mockResolvedValue(new Map());
    selectRows.mockResolvedValue([row({ unsplash_url: "https://images.example.com/b.jpg", oembed: youtube })]);
    await expect(mobilePreview(5n, null)).rejects.toThrow("not ported");
  });
});
