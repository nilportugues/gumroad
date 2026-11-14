import { describe, expect, it } from "vitest";

import { identifyImage, UnidentifiedImage } from "./image-identify.ts";

// Made with ImageMagick (`convert -size 7x5 xc:red`, `convert -size 9x4 xc:blue`), the sizes the Rails recordings read back.
const PNG_7X5 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFAQMAAACzVGSbAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABlBMVEX/AAD///9BHTQRAAAAAWJLR0QB/wIt3gAAAAd0SU1FB+oLDAUCF/EjOUMAAAALSURBVAjXY2CAAQAACgAB5/ja+gAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xMlQwNTowMjoyMyswMDowMKb5F4IAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTJUMDU6MDI6MjMrMDA6MDDXpK8+AAAAAElFTkSuQmCC",
  "base64",
);
const JPEG_9X4 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAkDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Anu1TQ4D/2Q==",
  "base64",
);

// An APP1 Exif segment with one IFD0 entry, the Orientation tag, in big-endian TIFF.
function jpegWithOrientation(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([JPEG_9X4.subarray(0, 2), segment, body, JPEG_9X4.subarray(2)]);
}

describe("identifyImage", () => {
  it("reads the type and size of a PNG from its header", () => {
    expect(identifyImage(PNG_7X5)).toEqual({ contentType: "image/png", width: 7, height: 5 });
  });

  it("reads the type and size of a JPEG from its frame header", () => {
    expect(identifyImage(JPEG_9X4)).toEqual({ contentType: "image/jpeg", width: 9, height: 4 });
  });

  it("accepts a JPEG whose EXIF orientation is top left", () => {
    expect(identifyImage(jpegWithOrientation(1))).toEqual({ contentType: "image/jpeg", width: 9, height: 4 });
  });

  it.each([2, 6, 8])("refuses a JPEG whose EXIF orientation is %i, which ImageMagick applies", (orientation) => {
    expect(() => identifyImage(jpegWithOrientation(orientation))).toThrow(UnidentifiedImage);
  });

  it("refuses a GIF and bytes that are no image", () => {
    expect(() => identifyImage(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"))).toThrow(UnidentifiedImage);
    expect(() => identifyImage(Buffer.from("not an image"))).toThrow(UnidentifiedImage);
  });
});
