import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn() }));
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows: mocks.selectRows,
}));
vi.mock("../../infra/active-storage.ts", () => ({
  isConfiguredService: (name: string) => name === "amazon",
  publicStorageUrl: (key: string) => `https://gumroad-public-storage.s3.amazonaws.com/${key}`,
}));
vi.mock("../../infra/cdn-url.ts", () => ({
  cdnUrlFor: (url: string) =>
    url.replace("https://gumroad-public-storage.s3.amazonaws.com/", "https://public-files.example.com/"),
}));

const { destroy, index } = await import("./media.ts");

const owner = { id: 7n } as never;
const file = (over: Record<string, unknown> = {}) => ({
  id: 1n,
  public_id: "abcdefghij123456",
  display_name: "Cover",
  file_type: "png",
  file_group: "image",
  created_at: new Date("2024-03-01T10:00:00.789Z"),
  ...over,
});
const blob = (over: Record<string, unknown> = {}) => ({
  record_id: 1n,
  key: "k1",
  byte_size: 2048n,
  service_name: "amazon",
  ...over,
});
const media = async () => JSON.parse(String((await index({ owner })).body)).media;

beforeEach(() => mocks.selectRows.mockReset());

describe("Api::V2::MediaController#index", () => {
  it("lists the seller's public files with the presenter's props", async () => {
    mocks.selectRows.mockResolvedValueOnce([file()]).mockResolvedValueOnce([blob()]);
    expect(await media()).toEqual([
      {
        id: "abcdefghij123456",
        name: "Cover",
        extension: "PNG",
        file_size: 2048,
        url: "https://public-files.example.com/k1",
        status: { type: "saved" },
        file_group: "image",
        created_at: "2024-03-01T10:00:00Z",
      },
    ]);
  });

  it("scopes the query to the seller's live files, newest id first", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    await index({ owner });
    const query = mocks.selectRows.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain("`public_files`.`deleted_at` IS NULL");
    expect(query.sql).toContain("`resource_type` = 'User'");
    expect(query.sql).toContain("ORDER BY `public_files`.`id` DESC");
    expect(query.values).toEqual([7n, 7n]);
  });

  it("answers an empty list without looking up blobs", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    expect(await media()).toEqual([]);
    expect(mocks.selectRows).toHaveBeenCalledTimes(1);
  });

  it("gives a file without an attachment no url or size", async () => {
    mocks.selectRows.mockResolvedValueOnce([file({ file_type: null })]).mockResolvedValueOnce([]);
    expect(await media()).toMatchObject([{ extension: null, file_size: null, url: null }]);
  });

  it("keeps the first attachment of a file", async () => {
    mocks.selectRows.mockResolvedValueOnce([file()]).mockResolvedValueOnce([blob(), blob({ key: "k2" })]);
    expect((await media())[0].url).toBe("https://public-files.example.com/k1");
  });

  it("hands back a blob stored on another service", async () => {
    mocks.selectRows.mockResolvedValueOnce([file()]).mockResolvedValueOnce([blob({ service_name: "local" })]);
    await expect(index({ owner })).rejects.toThrow(/service/u);
  });
});

describe("Api::V2::MediaController#destroy", () => {
  const input = { owner, routeParams: { id: "abcdefghij123456" } };

  it("says the media was not found when the seller has no live file with that public id", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    expect(JSON.parse(String((await destroy(input)).body))).toEqual({
      success: false,
      message: "The media was not found.",
    });
  });

  it("hands the delete of a hosted file back to Rails", async () => {
    mocks.selectRows.mockResolvedValueOnce([{ id: 1n }]);
    await expect(destroy(input)).rejects.toThrow("purges its blob");
  });
});
