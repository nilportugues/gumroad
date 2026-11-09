// The readers of app/models/product_file.rb that file delivery needs: its flags, the S3Retrievable fields of its url and the
// predicates UrlRedirect asks of it. Writes to product files stay with the seller-side ports.
import path from "node:path";

import type { ProductFile } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { storageConfig } from "../infra/storage.ts";

export const ProductFileFlags = defineFlags(
  "product_files",
  {
    1: "is_transcoded_for_hls",
    2: "is_linked_to_existing_file",
    3: "analyze_completed",
    4: "stream_only",
    5: "pdf_stamp_enabled",
    6: "hide_kindle_and_read_buttons",
  },
  { queryMode: "bit_operator" },
);

// ProductFile::MAX_EPUB_READER_ARCHIVE_SIZE
const MAX_EPUB_READER_ARCHIVE_SIZE = 32 * 1024 * 1024;
// Link::MAX_ALLOWED_FILE_SIZE_FOR_SEND_TO_KINDLE
const MAX_ALLOWED_FILE_SIZE_FOR_SEND_TO_KINDLE = 200 * 1024 * 1024;
const GUID_LENGTH = 32;

export const isStreamable = (file: ProductFile) => file.filegroup === "video";
export const isListenable = (file: ProductFile) => file.filegroup === "audio";
export const isExternalLink = (file: ProductFile) => file.filetype === "link";
export const isPdf = (file: ProductFile) => file.filetype === "pdf";
export const isEpub = (file: ProductFile) => file.filetype === "epub";
export const mustBePdfStamped = (file: ProductFile) => isPdf(file) && ProductFileFlags.isSet(file.flags, "pdf_stamp_enabled");

export const browserReadable = (file: ProductFile) => isPdf(file) || (isEpub(file) && (file.size === null || file.size <= BigInt(MAX_EPUB_READER_ARCHIVE_SIZE)));
export const canDisableDownloads = (file: ProductFile) => isStreamable(file) || browserReadable(file);
// ProductFile#stream_only?
export const isStreamOnly = (file: ProductFile) => canDisableDownloads(file) && ProductFileFlags.isSet(file.flags, "stream_only");
export const canSendToKindle = (file: ProductFile) => (isPdf(file) || isEpub(file)) && file.size !== null && file.size < BigInt(MAX_ALLOWED_FILE_SIZE_FOR_SEND_TO_KINDLE);

// File.extname: the extension of the last path component, "" for none or a dotfile.
export function rubyExtname(value: string): string {
  const base = value.slice(value.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot);
}

export type S3Fields = { key: string; filename: string; extension: string };

// has_s3_fields :url: s3_key, s3_filename and s3_extension. Nil when the url is not under S3_BASE_URL.
// `ownerExternalId` is the external id of the file's owner (ProductFile#user), which namespaces a collaborator's uploads.
export function s3Fields(url: string | null, ownerExternalId: string | null): S3Fields | null {
  const baseUrl = storageConfig().s3BaseUrl;
  if (url === null || url.trim() === "" || !url.startsWith(baseUrl)) return null;
  const parts = rubySplit(url, "/");
  const relative = url.slice(baseUrl.length);
  const namespaced = new RegExp(`^[^/]+/[^/]+/[A-Za-z0-9]{${GUID_LENGTH}}/original/`, "u").test(relative) || (ownerExternalId !== null && ownerExternalId !== "" && rubySplit(relative, "/")[1] === ownerExternalId);
  const startingIndex = namespaced ? 8 : 7;
  const maxSplitCount = namespaced ? 9 : 8;
  const filename = parts.length > maxSplitCount ? parts.slice(startingIndex).join("/") : parts.at(-1)!;
  return { key: parts.slice(4).join("/"), filename, extension: rubyExtname(url) };
}

// String#split with a string separator: trailing empty strings are dropped.
function rubySplit(value: string, separator: string): string[] {
  const parts = value.split(separator);
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

// ProductFile#filename_with_extension
export function filenameWithExtension(file: ProductFile, fields: S3Fields | null): string | null {
  if (fields === null) return null;
  if (fields.extension !== "" || file.filetype === null || file.filetype === "") return fields.filename;
  return `${fields.filename}.${file.filetype}`;
}

// File.extname of a name, as the "attachment; filename" disposition compares it.
export const extensionOf = (name: string) => path.posix.extname(name);
