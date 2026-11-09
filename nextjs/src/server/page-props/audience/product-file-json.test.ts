import { describe, expect, it, vi } from "vitest";

import { setSqlClient } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";

import { installmentFiles } from "./product-file-json.ts";

const signDownload = vi.hoisted(() => vi.fn());
const playerEnabled = vi.hoisted(() => vi.fn());
vi.mock("../../infra/flipper.ts", () => ({ isFeatureEnabled: playerEnabled, userActor: (id: string) => `User;${id}` }));
vi.mock("../../infra/signed-urls.ts", () => ({ signedDownloadUrlForS3KeyAndFilename: signDownload }));

vi.mock("../../infra/storage.ts", () => ({ storageConfig: () => ({ s3BaseUrl: "https://s3.example.com/bucket/" }) }));

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws13e-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const BASE = "https://s3.example.com/bucket/";
const SELLER_ID = 7n;
const NOW = new Date("2026-01-01T00:00:00Z");

type Tables = {
  product_files?: Record<string, unknown>[];
  active_storage_attachments?: { record_id: number }[];
  subtitle_files?: {
    id?: number;
    product_file_id: number;
    url?: string | null;
    language?: string | null;
    size?: number | null;
  }[];
  product_builds?: {
    product_file_id: number;
    number?: number;
    status?: string;
    created_at?: Date;
    site_unpacked_at?: Date | null;
    user_id?: number;
  }[];
  links?: { id: number; name: string; user_id: number }[];
  transcoded_videos?: { id: number; key: string | null }[];
};

function file(attributes: Record<string, unknown>) {
  return {
    id: 1,
    link_id: null,
    url: `${BASE}attachments/0123456789abcdef0123456789abcdef/original/Guide.pdf`,
    filetype: "pdf",
    filegroup: "document",
    size: 2048,
    bitrate: null,
    framerate: null,
    pagelength: 12,
    duration: null,
    width: null,
    height: null,
    flags: 0,
    json_data: null,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    position: 0,
    installment_id: 5,
    display_name: null,
    deleted_from_cdn_at: null,
    description: null,
    folder_id: null,
    stampable_pdf: null,
    isbn: null,
    ...attributes,
  };
}

function answering(tables: Tables) {
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      const sql = query.sql;
      if (sql.includes("FROM `product_files` WHERE `product_files`.`installment_id`"))
        return tables.product_files ?? [];
      if (sql.includes("FROM `active_storage_attachments`"))
        return (tables.active_storage_attachments ?? []).map((row) => ({ id: row.record_id }));
      if (sql.includes("FROM `subtitle_files`"))
        return (tables.subtitle_files ?? []).map((row, index) => ({
          id: row.id ?? index + 1,
          product_file_id: row.product_file_id,
          url: row.url ?? null,
          language: row.language ?? null,
          size: row.size ?? null,
        }));
      if (sql.includes("FROM `product_builds`"))
        return (tables.product_builds ?? []).map((row) => ({
          number: 1,
          status: "live",
          created_at: NOW,
          site_unpacked_at: NOW,
          user_id: 9,
          ...row,
        }));
      if (sql.includes("FROM `links`")) return tables.links ?? [];
      if (sql.includes("FROM `transcoded_videos`")) return tables.transcoded_videos ?? [];
      throw new Error(`unexpected statement: ${sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

describe("installmentFiles", () => {
  it("returns no files and false summaries for a post without files", async () => {
    answering({});

    expect(await installmentFiles(5, SELLER_ID)).toEqual({ files: [], streamOnly: false, streamable: false });
  });

  it("serializes a PDF like ProductFile#as_json", async () => {
    answering({ product_files: [file({ description: "Read me" })] });

    const { files, streamOnly, streamable } = await installmentFiles(5, SELLER_ID);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      file_name: "Guide",
      display_name: "Guide",
      description: "Read me",
      extension: "PDF",
      file_size: 2048,
      pagelength: 12,
      duration: null,
      is_pdf: true,
      pdf_stamp_enabled: false,
      hide_kindle_and_read_buttons: false,
      is_streamable: false,
      can_disable_downloads: true,
      web_build: null,
      stream_only: false,
      width: null,
      height: null,
      is_transcoding_in_progress: false,
      attached_product_name: null,
      subtitle_files: [],
      url: `${BASE}attachments/0123456789abcdef0123456789abcdef/original/Guide.pdf`,
      isbn: null,
      thumbnail: null,
      status: { type: "saved" },
    });
    expect(Object.keys(files[0]!)).toEqual([
      "file_name",
      "display_name",
      "description",
      "extension",
      "file_size",
      "pagelength",
      "duration",
      "is_pdf",
      "pdf_stamp_enabled",
      "hide_kindle_and_read_buttons",
      "is_streamable",
      "can_disable_downloads",
      "web_build",
      "stream_only",
      "width",
      "height",
      "is_transcoding_in_progress",
      "id",
      "attached_product_name",
      "subtitle_files",
      "url",
      "isbn",
      "thumbnail",
      "status",
    ]);
    expect(files[0]!.id).toEqual(expect.any(String));
    expect(streamOnly).toBe(false);
    expect(streamable).toBe(false);
  });

  it("prefers the display name and reads the flags", async () => {
    // pdf_stamp_enabled (bit 16) and hide_kindle_and_read_buttons (bit 32)
    answering({ product_files: [file({ display_name: "Renamed", flags: 16 + 32 })] });

    const [json] = (await installmentFiles(5, SELLER_ID)).files;

    expect(json).toMatchObject({
      file_name: "Renamed",
      display_name: "Renamed",
      pdf_stamp_enabled: true,
      hide_kindle_and_read_buttons: true,
    });
  });

  it("names an external link by its url and labels it URL", async () => {
    answering({
      product_files: [
        file({ url: "https://example.com/page", filetype: "link", filegroup: "url", pagelength: null, size: null }),
      ],
    });

    const [json] = (await installmentFiles(5, SELLER_ID)).files;

    expect(json).toMatchObject({
      file_name: "https://example.com/page",
      extension: "URL",
      file_size: null,
      is_pdf: false,
      can_disable_downloads: false,
    });
  });

  it("falls back to the upcased filetype for an upload whose key has no extension", async () => {
    answering({
      product_files: [
        file({
          url: `${BASE}attachments/0123456789abcdef0123456789abcdef/original/Notes`,
          filetype: "txt",
          filegroup: "document",
          pagelength: null,
        }),
      ],
    });

    const [json] = (await installmentFiles(5, SELLER_ID)).files;

    expect(json).toMatchObject({ file_name: "Notes", extension: "TXT", is_pdf: false });
  });

  it("reports an epub without a page length", async () => {
    answering({
      product_files: [
        file({
          url: `${BASE}attachments/0123456789abcdef0123456789abcdef/original/Book.epub`,
          filetype: "epub",
          pagelength: 300,
        }),
      ],
    });

    const [json] = (await installmentFiles(5, SELLER_ID)).files;

    expect(json).toMatchObject({ extension: "EPUB", pagelength: null, can_disable_downloads: true });
  });

  it("reports a stream only video with its dimensions, in progress while a transcode is processing", async () => {
    const key = "attachments/0123456789abcdef0123456789abcdef/original/Clip.mp4";
    // stream_only is flag 4 (bit 8)
    answering({
      product_files: [
        file({
          id: 2,
          url: `${BASE}${key}`,
          filetype: "mp4",
          filegroup: "video",
          duration: 90,
          width: 1280,
          height: 720,
          flags: 8,
          pagelength: null,
        }),
      ],
      transcoded_videos: [{ id: 2, key }],
    });

    const { files, streamOnly, streamable } = await installmentFiles(5, SELLER_ID);

    expect(files[0]).toMatchObject({
      is_streamable: true,
      stream_only: true,
      width: 1280,
      height: 720,
      duration: 90,
      is_transcoding_in_progress: true,
    });
    expect(streamOnly).toBe(true);
    expect(streamable).toBe(true);
  });

  it("ignores a processing transcode of another key", async () => {
    answering({
      product_files: [
        file({
          id: 2,
          filetype: "mp4",
          filegroup: "video",
          url: `${BASE}attachments/0123456789abcdef0123456789abcdef/original/Clip.mp4`,
        }),
      ],
      transcoded_videos: [{ id: 2, key: "attachments/other/original/Old.mp4" }],
    });

    expect((await installmentFiles(5, SELLER_ID)).files[0]).toMatchObject({ is_transcoding_in_progress: false });
  });

  it("names the product a file also belongs to", async () => {
    answering({ product_files: [file({ link_id: 9 })], links: [{ id: 9, name: "Course", user_id: 7 }] });

    expect((await installmentFiles(5, SELLER_ID)).files[0]).toMatchObject({ attached_product_name: "Course" });
  });

  it("keeps the files in position order of the query", async () => {
    answering({
      product_files: [file({ id: 1, display_name: "First" }), file({ id: 2, display_name: "Second", position: 1 })],
    });

    expect((await installmentFiles(5, SELLER_ID)).files.map((json) => json.display_name)).toEqual(["First", "Second"]);
  });

  it.each([
    [
      "a thumbnail on a video",
      {
        product_files: [file({ filetype: "mp4", filegroup: "video" })],
        active_storage_attachments: [{ record_id: 1 }],
      },
    ],
  ])("hands back a file with %s", async (_name, tables) => {
    answering(tables);

    await expect(installmentFiles(5, SELLER_ID)).rejects.toBeInstanceOf(NotPortedError);
  });

  describe("web build", () => {
    const build = { product_file_id: 1, number: 3, created_at: new Date("2026-02-03T04:05:06.789Z") };

    it("summarizes the build that owns the file, with the time at second precision", async () => {
      playerEnabled.mockResolvedValue(true);
      answering({ product_files: [file({ filetype: "zip" })], product_builds: [build] });

      const [json] = (await installmentFiles(5, SELLER_ID)).files;

      expect(json?.web_build).toEqual({
        number: 3,
        status: "live",
        deployed_at: "2026-02-03T04:05:06Z",
        playable: true,
        version_history: true,
      });
      expect(playerEnabled).toHaveBeenCalledWith("product_build_player", "User;9");
    });

    it("is not playable until the site is unpacked, but still offers the version history", async () => {
      playerEnabled.mockResolvedValue(true);
      answering({ product_files: [file({})], product_builds: [{ ...build, site_unpacked_at: null }] });

      expect((await installmentFiles(5, SELLER_ID)).files[0]?.web_build).toMatchObject({
        playable: false,
        version_history: true,
      });
    });

    it("is neither playable nor versioned when the seller lacks the player flag", async () => {
      playerEnabled.mockResolvedValue(false);
      answering({ product_files: [file({})], product_builds: [build] });

      expect((await installmentFiles(5, SELLER_ID)).files[0]?.web_build).toMatchObject({
        playable: false,
        version_history: false,
      });
    });

    it("does not read the flag for a build that is not live", async () => {
      playerEnabled.mockClear();
      answering({ product_files: [file({})], product_builds: [{ ...build, status: "superseded" }] });

      expect((await installmentFiles(5, SELLER_ID)).files[0]?.web_build).toMatchObject({
        status: "superseded",
        playable: false,
        version_history: false,
      });
      expect(playerEnabled).not.toHaveBeenCalled();
    });
  });

  describe("subtitle files", () => {
    const SUBTITLE_URL = `${BASE}attachments/fedcba9876543210fedcba9876543210/original/captions.vtt`;
    const subtitle = { product_file_id: 1, url: SUBTITLE_URL, language: "English", size: 1536 };

    it("lists each alive subtitle with a signed video URL, in the order the query returns them", async () => {
      signDownload.mockResolvedValue("https://files.example.com/signed");
      answering({
        product_files: [file({ filetype: "mp4", filegroup: "video" })],
        subtitle_files: [subtitle, { ...subtitle, language: "French", size: null }],
      });

      const [json] = (await installmentFiles(5, SELLER_ID)).files;

      expect(json?.subtitle_files).toEqual([
        {
          url: SUBTITLE_URL,
          file_name: "captions",
          extension: "VTT",
          language: "English",
          file_size: 1536,
          size: "1.5 KB",
          signed_url: "https://files.example.com/signed",
          status: { type: "saved" },
        },
        {
          url: SUBTITLE_URL,
          file_name: "captions",
          extension: "VTT",
          language: "French",
          file_size: null,
          size: null,
          signed_url: "https://files.example.com/signed",
          status: { type: "saved" },
        },
      ]);
      expect(signDownload).toHaveBeenCalledWith(
        "attachments/fedcba9876543210fedcba9876543210/original/captions.vtt",
        "captions.vtt",
        { isVideo: true },
      );
    });

    it("hands back when the subtitle's S3 object is missing", async () => {
      signDownload.mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFound" }));
      answering({ product_files: [file({})], subtitle_files: [subtitle] });

      await expect(installmentFiles(5, SELLER_ID)).rejects.toBeInstanceOf(NotPortedError);
    });

    it("lets other signing errors through", async () => {
      signDownload.mockRejectedValue(new Error("boom"));
      answering({ product_files: [file({})], subtitle_files: [subtitle] });

      await expect(installmentFiles(5, SELLER_ID)).rejects.toThrow("boom");
    });
  });

  it("serializes a PDF that has a thumbnail attachment, which as_json does not read", async () => {
    answering({ product_files: [file({})], active_storage_attachments: [{ record_id: 1 }] });

    expect((await installmentFiles(5, SELLER_ID)).files[0]).toMatchObject({ thumbnail: null });
  });
});
