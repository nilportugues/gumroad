// The part of rubyzip 2.3 that `Zip::File.open_buffer(string)` plus `entry.get_input_stream` read: the
// central directory, then one stored or deflated entry. Anything else a zip can hold (ZIP64, encryption,
// other compression methods, a damaged archive) raises ZipNotSupported, which jobs turn into a hand-back
// to Ruby. rubyzip does not check CRCs when reading, and neither does this.
import { inflateRawSync } from "node:zlib";

export class ZipNotSupported extends Error {}

export type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number; flags: number };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
// The end record is at most 22 bytes plus a 65,535 byte comment from the end.
const END_RECORD_SEARCH = 22 + 0xffff;

// An empty buffer is an empty archive to rubyzip.
export function zipEntries(zip: Uint8Array): ZipEntry[] {
  if (zip.length === 0) return [];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - END_RECORD_SEARCH); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipNotSupported("Zip end of central directory signature not found");

  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipNotSupported("ZIP64 archive");

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL_DIRECTORY_ENTRY) throw new ZipNotSupported("damaged central directory");
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const compressedSize = view.getUint32(at + 20, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw new ZipNotSupported("ZIP64 entry");
    entries.push({
      name: Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString("utf8"),
      method: view.getUint16(at + 10, true),
      flags: view.getUint16(at + 8, true),
      compressedSize,
      localHeaderOffset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// `entry.get_input_stream.read`
export function readZipEntry(zip: Uint8Array, entry: ZipEntry): Buffer {
  if ((entry.flags & 1) !== 0) throw new ZipNotSupported("encrypted entry");
  if (entry.method !== STORED && entry.method !== DEFLATED) throw new ZipNotSupported(`compression method ${entry.method}`);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > zip.length || view.getUint32(at, true) !== LOCAL_FILE_HEADER) throw new ZipNotSupported("damaged local header");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipNotSupported("truncated entry");
  if (entry.method === STORED) return Buffer.from(data);
  try {
    return inflateRawSync(data);
  } catch {
    throw new ZipNotSupported("damaged deflate stream");
  }
}
