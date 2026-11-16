import { describe, expect, it } from "vitest";

import { marcelContentType } from "./active-storage-attach.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe("marcelContentType", () => {
  it("takes the type the magic bytes name over the declared one", () => {
    expect(marcelContentType(PNG, "image/jpeg")).toBe("image/png");
    expect(marcelContentType(JPEG, "image/png")).toBe("image/jpeg");
  });

  it("names the other formats a picture host may send, which an avatar does not accept", () => {
    expect(marcelContentType(Buffer.from("GIF89a....", "latin1"), "image/png")).toBe("image/gif");
    expect(marcelContentType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), "image/png")).toBe("image/webp");
    expect(marcelContentType(Buffer.from("%PDF-1.7", "latin1"), "image/jpeg")).toBe("application/pdf");
  });

  it("falls back to the declared type, lower-cased and without its parameters, when no signature matches", () => {
    expect(marcelContentType(Buffer.from("not an image"), "Image/PNG; charset=binary")).toBe("image/png");
    expect(marcelContentType(Buffer.from("not an image"), "")).toBe("application/octet-stream");
  });
});
