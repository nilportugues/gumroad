import { describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

vi.mock("../../../lib/db.ts", () => ({ db: {} }));

const { registeredApiV2Routes } = await import("./base.ts");
await import("./files.ts");

const route = (pattern: string) => registeredApiV2Routes().find((r) => r.method === "POST" && r.pattern === pattern)!;
const owner = { external_id: "abc123" };
const call = async (pattern: string, params: Record<string, unknown>) =>
  route(pattern).run({ params, owner } as never);
const refusal = async (pattern: string, params: Record<string, unknown>) => {
  const rendered = (await call(pattern, params)) as { status: number; body: string };
  return [rendered.status, JSON.parse(rendered.body).error];
};
const PREFIX = "attachments/abc123/";

describe("POST /v2/files/presign", () => {
  it("refuses a blank filename", async () => {
    expect(await refusal("/v2/files/presign", { filename: "  ", file_size: "10" })).toEqual([
      400,
      "filename is required",
    ]);
    expect(await refusal("/v2/files/presign", {})).toEqual([400, "filename is required"]);
  });

  it("refuses a file_size that Ruby reads as zero or less", async () => {
    for (const file_size of [undefined, "abc", "0", "-5", false, "0x10"])
      expect(await refusal("/v2/files/presign", { filename: "a.zip", file_size })).toEqual([
        400,
        "file_size is required",
      ]);
  });

  it("reads file_size the way String#to_i does", async () => {
    await expect(call("/v2/files/presign", { filename: "a.zip", file_size: " 1_000abc" })).rejects.toThrow(
      "multipart upload",
    );
    expect(await refusal("/v2/files/presign", { filename: "a.zip", file_size: String(21 * 1024 ** 3) })).toEqual([
      400,
      "file_size exceeds the 20 GB maximum",
    ]);
  });

  it("hands a valid request back to Rails", async () => {
    await expect(call("/v2/files/presign", { filename: "a.zip", file_size: 5 })).rejects.toThrow("multipart upload");
  });

  it("hands back a parameter whose to_s is Ruby's inspect", async () => {
    await expect(call("/v2/files/presign", { filename: ["a"], file_size: 5 })).rejects.toThrow("not text");
  });
});

describe("POST /v2/files/complete", () => {
  const parts = [{ part_number: 1, etag: "e" }];

  it("refuses a missing upload_id, key and parts in that order", async () => {
    expect(await refusal("/v2/files/complete", {})).toEqual([400, "upload_id is required"]);
    expect(await refusal("/v2/files/complete", { upload_id: "u" })).toEqual([400, "key is required"]);
    expect(await refusal("/v2/files/complete", { upload_id: "u", key: "k" })).toEqual([400, "parts is required"]);
    expect(await refusal("/v2/files/complete", { upload_id: "u", key: "k", parts: [] })).toEqual([
      400,
      "parts is required",
    ]);
  });

  it("refuses a key outside the seller's prefix", async () => {
    expect(await refusal("/v2/files/complete", { upload_id: "u", key: "other/x", parts })).toEqual([
      400,
      "invalid key",
    ]);
  });

  it("refuses a part without scalar part_number and etag", async () => {
    const message = "each part must have scalar part_number and etag values";
    for (const bad of [[{ part_number: 1 }], ["x"], [{ part_number: [1], etag: "e" }], "x", true])
      expect(await refusal("/v2/files/complete", { upload_id: "u", key: `${PREFIX}k`, parts: bad })).toEqual([
        400,
        message,
      ]);
  });

  it("hands a well-formed request back to Rails, a lone hash included", async () => {
    await expect(call("/v2/files/complete", { upload_id: "u", key: `${PREFIX}k`, parts })).rejects.toThrow(
      "completing",
    );
    await expect(call("/v2/files/complete", { upload_id: "u", key: `${PREFIX}k`, parts: parts[0] })).rejects.toThrow(
      "completing",
    );
  });
});

describe("POST /v2/files/abort", () => {
  it("refuses what is missing or outside the prefix, then hands back", async () => {
    expect(await refusal("/v2/files/abort", {})).toEqual([400, "upload_id is required"]);
    expect(await refusal("/v2/files/abort", { upload_id: "u" })).toEqual([400, "key is required"]);
    expect(await refusal("/v2/files/abort", { upload_id: "u", key: "x" })).toEqual([400, "invalid key"]);
    await expect(call("/v2/files/abort", { upload_id: "u", key: `${PREFIX}k` })).rejects.toThrow("aborting");
  });
});

describe("POST /v2/direct_uploads", () => {
  const blob = { filename: "a.png", byte_size: "100", checksum: "c", content_type: "image/png" };
  const create = (params: Record<string, unknown>) => refusal("/v2/direct_uploads", params);

  it("picks the scope from the purpose", () => {
    const { scopes, requireScope } = route("/v2/direct_uploads");
    expect((scopes as (p: unknown) => string[])({ purpose: "media" })).toEqual(["edit_profile"]);
    expect((scopes as (p: unknown) => string[])({ purpose: ["media"] })).toEqual(["edit_products"]);
    expect((requireScope as (p: unknown) => unknown)({ purpose: "media" })).toEqual(["edit_profile"]);
    expect((requireScope as (p: unknown) => unknown)({})).toBeUndefined();
  });

  it("refuses a blob that is not an object", async () => {
    expect(await create({ blob: "x" })).toEqual([400, "blob must be an object"]);
    expect(await create({})).toEqual([400, "blob must be an object"]);
  });

  it("names the first required argument that is missing", async () => {
    expect(await create({ blob: { byte_size: "1", checksum: "c" } })).toEqual([400, "filename is required"]);
    expect(await create({ blob: { filename: "a", checksum: "c" } })).toEqual([400, "byte_size is required"]);
    expect(await create({ blob: { filename: "a", byte_size: ["1"], checksum: "c" } })).toEqual([
      400,
      "byte_size is required",
    ]);
    expect(await create({ blob: { filename: "a", byte_size: "1" } })).toEqual([400, "checksum is required"]);
  });

  it("refuses a byte_size that is zero, too large or, for media, over 10 MB", async () => {
    expect(await create({ blob: { ...blob, byte_size: "0" } })).toEqual([400, "byte_size is required"]);
    expect(await create({ blob: { ...blob, byte_size: String(21 * 1024 ** 3) } })).toEqual([
      400,
      "byte_size exceeds the 20 GB maximum",
    ]);
    expect(await create({ purpose: "media", blob: { ...blob, byte_size: String(10 * 1024 ** 2 + 1) } })).toEqual([
      400,
      "byte_size exceeds the 10 MB maximum for media uploads",
    ]);
  });

  it("refuses a content type outside the allowlist of the purpose", async () => {
    const product = "content_type must be JPEG, PNG, GIF, or video.";
    const media = "content_type must be an image type.";
    expect(await create({ blob: { ...blob, content_type: "application/pdf" } })).toEqual([400, product]);
    expect(await create({ blob: { ...blob, content_type: undefined } })).toEqual([400, product]);
    expect(await create({ purpose: "media", blob: { ...blob, content_type: "video/mp4" } })).toEqual([400, media]);
    expect(await create({ purpose: "media", blob: { ...blob, content_type: "IMAGE/SVG+XML" } })).toEqual([400, media]);
  });

  it("hands a valid reservation back to Rails", async () => {
    await expect(call("/v2/direct_uploads", { blob })).rejects.toThrow("reserving a blob");
    await expect(call("/v2/direct_uploads", { purpose: "media", blob })).rejects.toThrow("reserving a blob");
    await expect(call("/v2/direct_uploads", { blob: { ...blob, content_type: "video/mp4" } })).rejects.toThrow(
      "reserving a blob",
    );
  });

  it("hands back an empty blob and a boolean byte_size", async () => {
    await expect(call("/v2/direct_uploads", { blob: {} })).rejects.toThrow("empty blob");
    await expect(call("/v2/direct_uploads", { blob: { ...blob, byte_size: true } })).rejects.toThrow("byte_size");
  });
});
