// What Active Storage learns from a picture's bytes: Marcel's content type (magic bytes win over the declared type) and the width and
// height ActiveStorage::Analyzer::ImageAnalyzer::ImageMagick reads. Only PNG and JPEG are identified, the two types an avatar may have;
// anything else, and the shapes where ImageMagick's answer is not the plain header (EXIF orientation), is `UnidentifiedImage`.
export class UnidentifiedImage extends Error {}

export type ImageInfo = { contentType: "image/png" | "image/jpeg"; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_IHDR_OFFSET = 8;
const PNG_CHUNK_OVERHEAD = 12;
const START_OF_SCAN = 0xda;
const END_OF_IMAGE = 0xd9;
const APP1 = 0xe1;
const EXIF_HEADER = "Exif\0\0";
const ORIENTATION_TAG = 0x0112;
const ORIENTATION_TOP_LEFT = 1;
const TIFF_ENTRY_SIZE = 12;
// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
const NON_FRAME_MARKERS = new Set([0xc4, 0xc8, 0xcc]);

function pngInfo(bytes: Buffer): ImageInfo {
  if (bytes.toString("latin1", PNG_IHDR_OFFSET + 4, PNG_IHDR_OFFSET + 8) !== "IHDR")
    throw new UnidentifiedImage("a PNG without an IHDR chunk");
  const width = bytes.readUInt32BE(PNG_IHDR_OFFSET + 8);
  const height = bytes.readUInt32BE(PNG_IHDR_OFFSET + 12);
  // ImageMagick applies the orientation of an eXIf chunk as it does for a JPEG.
  for (let at = PNG_IHDR_OFFSET; at + 8 <= bytes.length; ) {
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "eXIf") throw new UnidentifiedImage("a PNG with an eXIf chunk");
    if (type === "IDAT") break;
    at += bytes.readUInt32BE(at) + PNG_CHUNK_OVERHEAD;
  }
  return { contentType: "image/png", width, height };
}

// The Orientation of an EXIF block (a TIFF structure), undefined when it has none. ImageMagick swaps the dimensions for every value
// whose name has Left or Right in it, which includes 2 and 4: anything but "top left" is not ported.
function exifOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let entry = 0; entry < count; entry += 1) {
    const at = ifd + 2 + entry * TIFF_ENTRY_SIZE;
    if (at + TIFF_ENTRY_SIZE > tiff.length) return undefined;
    if (u16(at) === ORIENTATION_TAG) return u16(at + 8);
  }
  return undefined;
}

function jpegInfo(bytes: Buffer): ImageInfo {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new UnidentifiedImage("a JPEG with a stray byte between segments");
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === START_OF_SCAN || marker === END_OF_IMAGE) break;
    const length = bytes.readUInt16BE(at + 2);
    if (marker === APP1 && bytes.toString("latin1", at + 4, at + 10) === EXIF_HEADER) {
      const orientation = exifOrientation(bytes.subarray(at + 10, at + 2 + length));
      if (orientation !== undefined && orientation !== ORIENTATION_TOP_LEFT)
        throw new UnidentifiedImage("a JPEG whose EXIF orientation is not top left");
    }
    if (marker >= 0xc0 && marker <= 0xcf && !NON_FRAME_MARKERS.has(marker))
      return { contentType: "image/jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new UnidentifiedImage("a JPEG without a frame header");
}

export function identifyImage(bytes: Buffer): ImageInfo {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) && bytes.length >= PNG_IHDR_OFFSET + 16)
    return pngInfo(bytes);
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return jpegInfo(bytes);
  throw new UnidentifiedImage("a picture that is neither a PNG nor a JPEG");
}
