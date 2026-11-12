// The slice of Active Storage 8.1 (track_variants on, the public S3 service of config/storage.yml)
// that User#avatar_url walks: which variant a Variation names, where its file lives and what URL
// the service gives it. Generating a variant is ImageMagick's job and stays with Rails.
import { createHash } from "node:crypto";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

import { railsMessageVerifierGenerate } from "../auth/message-verifier.ts";
import { marshalDump, RubySymbol, type MarshalValue } from "../cache/marshal.ts";
import { cgiEscape } from "../search/api.ts";

import { getS3Client } from "./signed-urls.ts";
import { storageConfig } from "./storage.ts";

// config.active_storage.variable_content_types (the engine's list) and the app's web_image_content_types.
const VARIABLE_CONTENT_TYPES = [
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
];
const WEB_IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/gif"];

// Marcel's extension table for the web image types: the extensions that name each type, the first
// being what Marcel::Magic#extensions.first answers.
const MARCEL_EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg", "jpe", "jif", "jfif", "jfi"],
  "image/gif": ["gif"],
};

export const isVariable = (contentType: string | null) =>
  contentType !== null && VARIABLE_CONTENT_TYPES.includes(contentType);

// ActiveStorage::Filename#extension: File.extname without its dot. A leading dot names a hidden
// file, not an extension.
function filenameExtension(filename: string): string {
  const base = filename.replace(/^.*\//u, "");
  const dot = base.replace(/^\.+/u, "").lastIndexOf(".");
  return dot < 0 ? "" : base.replace(/^\.+/u, "").slice(dot + 1);
}

// Blob#default_variant_format: a web image keeps its own format (the filename's extension when it
// names the content type, else Marcel's first), anything else becomes a png.
function defaultVariantFormat(contentType: string, filename: string): string | RubySymbol {
  if (!WEB_IMAGE_CONTENT_TYPES.includes(contentType)) return new RubySymbol("png");
  const extension = filenameExtension(filename);
  const names = MARCEL_EXTENSIONS[contentType]!;
  return extension !== "" && names.includes(extension.toLowerCase()) ? extension : names[0]!;
}

// Variation#digest of `blob.variant(resize_to_limit: [limit, limit])`: SHA1 of the Marshal dump of
// the transformations, `format` first because default_to is a reverse_merge.
export function resizeToLimitDigest(
  contentType: string,
  filename: string,
  limit: number,
  height: number | null = limit,
): string {
  const transformations = new Map<MarshalValue, MarshalValue>([
    [new RubySymbol("format"), defaultVariantFormat(contentType, filename)],
    [new RubySymbol("resize_to_limit"), [limit, height]],
  ]);
  return createHash("sha1").update(marshalDump(transformations)).digest("base64");
}

// Seahorse::Util.uri_escape
const uriEscape = (segment: string) => cgiEscape(segment).replaceAll("+", "%20");

// The public S3 service's `url`: Aws::S3::Object#public_url. Path style against MinIO (development
// and test), the bucket as the host of the global S3 endpoint otherwise.
export function publicStorageUrl(key: string): string {
  const config = storageConfig();
  const path = key.replace(/[^/]+/gu, uriEscape);
  if (config.env === "development" || config.env === "test")
    return `${config.s3Endpoint}/${config.publicStorageS3Bucket}/${path}`;
  return `https://${config.publicStorageS3Bucket}.s3.amazonaws.com/${path}`;
}

// The services config/storage.yml names per environment; a blob stored under another is Rails'.
const SERVICE_NAMES = { production: "amazon", staging: "amazon", development: "development", test: "test" } as const;

export const configuredServiceName = () => SERVICE_NAMES[storageConfig().env];

export const isConfiguredService = (serviceName: string) => serviceName === configuredServiceName();

// S3Service#exist?: Aws::S3::Object#exists? answers false for a missing key and raises otherwise.
export async function publicStorageExists(key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: storageConfig().publicStorageS3Bucket, Key: key }));
    return true;
  } catch (error) {
    const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (name === "NotFound" || name === "NoSuchKey" || $metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

// ActiveStorage::Blob#signed_id: ActiveStorage.verifier (`message_verifier("ActiveStorage")`) with the purpose Blob pins to
// "blob_id" instead of the class-prefixed one other models get, and no expiry.
export const blobSignedId = (blobId: bigint | number): string =>
  railsMessageVerifierGenerate("ActiveStorage", Number(blobId), "blob_id");
