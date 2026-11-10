import { createHash, createHmac, createSign } from "node:crypto";
import path from "node:path";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { getConfig } from "./config.ts";
import approximations from "./i18n-approximations.json" with { type: "json" };
import { getRedis } from "./redis.ts";
import { storageConfig, type StorageConfig } from "./storage.ts";

// Port of app/helpers/signed_url_helper.rb. Times are seconds; `now` is injectable for parity tests.

export const SIGNED_S3_URL_VALID_FOR_MINIMUM = 10 * 60;
export const SIGNED_S3_URL_VALID_FOR_MAXIMUM = 3 * 60 * 60;
export const SIGNED_VIDEO_URL_VALID_FOR = 12 * 60 * 60;

// Changing this invalidates every file cached in Cloudflare under it.
const CF_WORKER_CACHE_KEY = "caIWHGT4Qhqo6KoxDMNXwQ";
const CF_WORKER_CACHE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".epub", ".brushset", ".scrivtemplate", ".zip", ".tpl"];
const CF_CACHE_OVERRIDES_REDIS_KEY = "cf_cache_invalidated_extensions_and_cache_keys"; // RedisKey.cf_cache_invalidated_extensions_and_cache_keys

/** A plain number of seconds, or an ActiveSupport::Duration by its parts (`10.years` is `{ years: 10 }`). */
export type ExpiresIn = number | Partial<Record<"years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds", number>>;

const SECONDS_PER = { years: 31_556_952, months: 2_629_746, weeks: 604_800, days: 86_400, hours: 3_600, minutes: 60, seconds: 1 };

// Duration#to_i, which uses Gregorian-average years and months.
export function durationSeconds(value: ExpiresIn): number {
  if (typeof value === "number") return value;
  return Object.entries(value).reduce((sum, [part, n]) => sum + SECONDS_PER[part as keyof typeof SECONDS_PER] * (n ?? 0), 0);
}

// (Time.current + expires_in).to_i. Rails advances years, months and days on the calendar (in UTC,
// the app's zone), clamping to the end of a shorter month, and adds the rest as seconds.
export function expiresAtSeconds(now: Date, expiresIn: ExpiresIn): number {
  if (typeof expiresIn === "number") return Math.floor(now.getTime() / 1000 + expiresIn);
  const { years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0 } = expiresIn;
  const date = new Date(now.getTime());
  const totalMonths = date.getUTCMonth() + months + years * 12;
  const targetYear = date.getUTCFullYear() + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  date.setUTCFullYear(targetYear, targetMonth, Math.min(date.getUTCDate(), lastDay));
  const ms = date.getTime() + ((weeks * 7 + days) * 86_400 + hours * 3_600 + minutes * 60 + seconds) * 1000;
  return Math.floor(ms / 1000);
}

// CGI.escape: everything but [a-zA-Z0-9_.\-~] is percent-encoded, spaces become "+".
export function cgiEscape(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[a-zA-Z0-9_.\-~]/u.test(char)) return char;
      if (char === " ") return "+";
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

// Seahorse::Util.uri_escape (aws-sdk-core): CGI.escape with "+" as %20 and "~" kept.
export function awsUriEscape(value: string): string {
  return cgiEscape(value).replaceAll("+", "%20");
}

function awsUriPathEscape(value: string): string {
  return value.replace(/[^/]+/gu, (part) => awsUriEscape(part));
}

// URI.parse(url).path for the absolute or relative URLs these helpers build.
function uriPath(url: string): string {
  const withoutAuthority = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/u, "");
  return withoutAuthority.split(/[?#]/u)[0] ?? "";
}

/**
 * signed_cloudfront_url. Ruby discards the result of `signature.tr("+=/", "-_~")`, so the URL
 * carries raw base64 (with "+", "/" and "=") unescaped; CloudFront has accepted it that way.
 */
export function signedCloudfrontUrl(
  url: string,
  options: { isVideo?: boolean; expiresIn?: ExpiresIn; now?: Date; config?: StorageConfig } = {},
): string {
  const config = options.config ?? storageConfig();
  if (!config.cloudfrontPrivateKey) throw new Error("CLOUDFRONT_PRIVATE_KEY is not set");

  let expiresIn = options.expiresIn;
  if (options.isVideo && expiresIn === undefined) expiresIn = SIGNED_VIDEO_URL_VALID_FOR;
  if (expiresIn === undefined) expiresIn = SIGNED_S3_URL_VALID_FOR_MINIMUM;
  const expiresAt = expiresAtSeconds(options.now ?? new Date(), expiresIn);
  const policy = `{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":${expiresAt}}}}]}`;
  const signature = createSign("RSA-SHA1").update(policy).sign(config.cloudfrontPrivateKey, "base64");
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}Expires=${expiresAt}&Signature=${signature}&Key-Pair-Id=${config.cloudfrontKeyPairId ?? ""}`;
}

export function signedCloudflareUrl(url: string, expiresIn: ExpiresIn, options: { now?: Date; hmacKey?: string } = {}): string {
  const expiresAt = String(expiresAtSeconds(options.now ?? new Date(), expiresIn));
  const tokenData = `${uriPath(url)}/${expiresAt}`;
  const hmacKey = options.hmacKey ?? getConfig("CLOUDFLARE_HMAC_KEY") ?? "";
  const signature = cgiEscape(createHmac("sha256", hmacKey).update(tokenData).digest("base64"));
  return `${url}&verify=${expiresAt}-${signature}`;
}

export function signedUrlValidityTimeForFileSize(fileSize: number | null | undefined): number {
  if (fileSize === null || fileSize === undefined) return SIGNED_S3_URL_VALID_FOR_MINIMUM;
  const validFor = Math.max(Math.floor(Math.floor(fileSize / 1_024) / 50), SIGNED_S3_URL_VALID_FOR_MINIMUM);
  return Math.min(validFor, SIGNED_S3_URL_VALID_FOR_MAXIMUM);
}

// I18n.transliterate with the default (English) rules: known Latin letters are approximated,
// every other non-ASCII character becomes "?".
function transliterate(value: string): string {
  const table = approximations as Record<string, string>;
  return value.replace(/[^\x00-\x7f]/gu, (char) => table[char] ?? "?");
}

function percentEscape(value: string, pattern: RegExp): string {
  return value.replace(pattern, (char) =>
    [...Buffer.from(char, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

// ActionDispatch::Http::ContentDisposition.format
export function formatContentDisposition(disposition: string, filename: string | null | undefined): string {
  if (filename === null || filename === undefined) return disposition;
  const ascii = `filename="${percentEscape(transliterate(filename), /[^ A-Za-z0-9!#$+.^_`|~-]/gu)}"`;
  const utf8 = `filename*=UTF-8''${percentEscape(filename, /[^A-Za-z0-9!#$&+.^_`|~-]/gu)}`;
  return `${disposition}; ${ascii}; ${utf8}`;
}

const isBlank = (value: string | null | undefined) => value === null || value === undefined || /^\s*$/u.test(value);

// Browsers name a CDN download after the key's last segment, so a filename is only sent when its
// extension differs from the key's; every other URL (and its cache entry) stays the same.
export function contentDispositionParam(s3Key: string, s3Filename: string | null | undefined): string {
  if (isBlank(s3Filename) || path.posix.extname(s3Filename!) === path.posix.extname(s3Key)) return "attachment";
  return cgiEscape(formatContentDisposition("attachment", s3Filename));
}

/** Default per-extension Cloudflare worker cache keys merged with the overrides kept in Redis. */
export async function cfWorkerCacheKeys(readOverrides?: () => Promise<Record<string, string>>): Promise<Record<string, string>> {
  const keys: Record<string, string> = Object.fromEntries(CF_WORKER_CACHE_EXTENSIONS.map((ext) => [ext, CF_WORKER_CACHE_KEY]));
  const overrides = readOverrides ? await readOverrides() : await getRedis("main").hgetall(CF_CACHE_OVERRIDES_REDIS_KEY);
  return { ...keys, ...overrides };
}

export function cfCacheKey(s3Filename: string, cacheKeys: Record<string, string>): string | undefined {
  return cacheKeys[path.posix.extname(s3Filename).toLowerCase()];
}

// Aws::S3::Bucket#url: virtual-hosted on AWS when the bucket name is DNS-safe, path style otherwise
// and always on a custom endpoint with force_path_style (MinIO).
function isDnsCompatibleBucket(bucket: string): boolean {
  return (
    bucket.length >= 3 &&
    bucket.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]+[a-z0-9]$/u.test(bucket) &&
    !/(\d+\.){3}\d+/u.test(bucket) &&
    !/[.-]{2}/u.test(bucket) &&
    !bucket.includes(".")
  );
}

export function s3PublicUrl(bucket: string, key: string, config: StorageConfig = storageConfig()): string {
  const escapedKey = awsUriPathEscape(key);
  if (config.usingMinio) return `${config.s3Endpoint}/${bucket}/${escapedKey}`;
  const host = config.region === "us-east-1" ? "s3.amazonaws.com" : `s3.${config.region}.amazonaws.com`;
  return isDnsCompatibleBucket(bucket) ? `https://${bucket}.${host}/${escapedKey}` : `https://${host}/${bucket}/${escapedKey}`;
}

/**
 * Aws::S3::Object#presigned_url(:get, expires_in:, response_content_disposition:) as SigV4 query
 * signing, built by hand so the URL (parameter order included) is byte-identical to Ruby's.
 */
export function presignS3GetUrl(
  bucket: string,
  key: string,
  options: { expiresIn: ExpiresIn; responseContentDisposition?: string; now?: Date; config?: StorageConfig },
): string {
  const config = options.config ?? storageConfig();
  const url = new URL(s3PublicUrl(bucket, key, config));
  const now = options.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${config.region}/s3/aws4_request`;

  const params: [string, string][] = [];
  if (options.responseContentDisposition !== undefined) {
    params.push(["response-content-disposition", options.responseContentDisposition]);
  }
  params.push(
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId ?? ""}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.trunc(durationSeconds(options.expiresIn)))],
    ["X-Amz-SignedHeaders", "host"],
  );
  const encoded = params.map(([k, v]) => [awsUriEscape(k), awsUriEscape(v)] as const);
  const canonicalQuery = [...encoded]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const pathname = uriPath(url.href);
  const canonicalRequest = ["GET", pathname, canonicalQuery, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");

  const hmac = (k: Buffer | string, data: string) => createHmac("sha256", k).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey ?? ""}`, date), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const query = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  return `${url.protocol}//${url.host}${pathname}?${query}&X-Amz-Signature=${signature}`;
}

export type S3ObjectInfo = { contentLength: number | undefined };
export type HeadS3Object = (bucket: string, key: string) => Promise<S3ObjectInfo>;

let s3Client: S3Client | undefined;

export function getS3Client(config: StorageConfig = storageConfig()): S3Client {
  s3Client ??= new S3Client({
    region: config.region,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
    ...(config.env === "development" || config.env === "test"
      ? { endpoint: config.s3Endpoint, forcePathStyle: true }
      : {}),
  });
  return s3Client;
}

const headWithSdk: HeadS3Object = async (bucket, key) => {
  const response = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { contentLength: response.ContentLength };
};

const isNotFound = (error: unknown) =>
  (error as { name?: string }).name === "NotFound" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

// S3KeyUnicodeNormalization.variants: the NFD and NFC forms of a key other than the key itself.
export function s3KeyVariants(s3Key: string): string[] {
  return (["NFD", "NFC"] as const).map((form) => s3Key.normalize(form)).filter((variant) => variant !== s3Key);
}

// S3KeyUnicodeNormalization.existing_variant: ASCII keys have no variants, so they make no S3 calls.
export async function existingS3KeyVariant(
  s3Key: string,
  exists: (key: string) => Promise<boolean>,
): Promise<string | null> {
  for (const variant of s3KeyVariants(s3Key)) if (await exists(variant)) return variant;
  return null;
}

export type SignedDownloadOptions = {
  isVideo?: boolean;
  expiresIn?: ExpiresIn;
  cacheGroup?: string;
  now?: Date;
  config?: StorageConfig;
  headObject?: HeadS3Object;
  /** Whether the object exists under a key; the Unicode-normalization retry probes variants with it. */
  keyExists?: (key: string) => Promise<boolean>;
  cacheKeys?: Record<string, string>;
};

/**
 * signed_download_url_for_s3_key_and_filename. Not ported: the Rails.cache (memcached) memo of the HEAD response.
 * A NotFound is retried under the other Unicode normalizations of the key (not on MinIO, where Ruby has no retry)
 * and rethrown when none exists.
 */
export async function signedDownloadUrlForS3KeyAndFilename(
  s3Key: string,
  s3Filename: string | null | undefined,
  options: SignedDownloadOptions = {},
): Promise<string> {
  const config = options.config ?? storageConfig();
  const head = options.headObject ?? headWithSdk;

  if (config.usingMinio) {
    const { contentLength } = await head(config.s3Bucket, s3Key);
    const expiresIn = options.expiresIn ?? (options.isVideo ? SIGNED_VIDEO_URL_VALID_FOR : signedUrlValidityTimeForFileSize(contentLength));
    return presignS3GetUrl(config.s3Bucket, s3Key, {
      expiresIn,
      responseContentDisposition: `attachment; filename="${s3Filename ?? ""}"`,
      now: options.now,
      config,
    });
  }

  // Only the served object moves to the variant key; the disposition and cache key keep the stored key and filename.
  let objectKey = s3Key;
  let contentLength: number | undefined;
  try {
    ({ contentLength } = await head(config.s3Bucket, s3Key));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const exists = options.keyExists ?? (async (key: string) => head(config.s3Bucket, key).then(() => true, (e: unknown) => (isNotFound(e) ? false : Promise.reject(e))));
    const variant = await existingS3KeyVariant(s3Key, exists);
    if (variant === null) throw error;
    objectKey = variant;
    ({ contentLength } = await head(config.s3Bucket, variant));
  }
  const publicUrlPath = uriPath(s3PublicUrl(config.s3Bucket, objectKey, config));
  // Ruby strips "/<bucket>" without a trailing slash; keep that exact behaviour.
  const s3Path = publicUrlPath.replace(new RegExp(`^/${config.s3Bucket.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"), "").replace(/^\//u, "");
  const cacheable = Math.trunc(contentLength ?? 0) < config.cloudflareCacheLimit;

  let downloadUrl = `${cacheable ? config.fileDownloadDistributionUrl : config.cloudfrontDownloadDistributionUrl}${s3Path}?`;
  if (!isBlank(options.cacheGroup)) downloadUrl += `cache_group=${cgiEscape(options.cacheGroup!)}&`;
  downloadUrl += `response-content-disposition=${contentDispositionParam(s3Key, s3Filename)}`;
  if (!isBlank(s3Filename)) {
    const cacheKey = cfCacheKey(s3Filename!, options.cacheKeys ?? (await cfWorkerCacheKeys()));
    if (!isBlank(cacheKey)) downloadUrl += `&cache_key=${cacheKey}`;
  }
  const expiresIn = options.expiresIn ?? (options.isVideo ? SIGNED_VIDEO_URL_VALID_FOR : signedUrlValidityTimeForFileSize(contentLength));

  return cacheable
    ? signedCloudflareUrl(downloadUrl, expiresIn, { now: options.now })
    : signedCloudfrontUrl(downloadUrl, { isVideo: options.isVideo, expiresIn, now: options.now, config });
}
