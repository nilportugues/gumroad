import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/signed-urls.golden.json" with { type: "json" };
import {
  cfCacheKey,
  cfWorkerCacheKeys,
  expiresAtSeconds,
  contentDispositionParam,
  s3PublicUrl,
  signedCloudflareUrl,
  signedCloudfrontUrl,
  signedDownloadUrlForS3KeyAndFilename,
  signedUrlValidityTimeForFileSize,
} from "./signed-urls";
import type { StorageConfig } from "./storage";

// Vectors were produced by app/helpers/signed_url_helper.rb with aws-sdk-s3 1.157.0, a fake RSA key
// and a frozen clock (generators/signed_urls.rb).
const now = new Date(golden.now * 1000);
const hmacKey = golden.cloudflare_hmac_key;
process.env.CLOUDFLARE_HMAC_KEY = hmacKey;

const production: StorageConfig = {
  env: "production",
  accessKeyId: "AKIAFAKEACCESSKEY",
  secretAccessKey: "fake/secret/access/key",
  s3Endpoint: "https://s3.amazonaws.com",
  region: "us-east-1",
  usingMinio: false,
  s3Bucket: "gumroad",
  publicStorageS3Bucket: "gumroad-public-storage",
  invoicesS3Bucket: "gumroad-invoices",
  s3BaseUrl: "https://s3.amazonaws.com/gumroad/",
  hlsDistributionUrl: "https://d1bdh6c3ceakz5.cloudfront.net/",
  fileDownloadDistributionUrl: "https://files.gumroad.com/",
  cloudfrontDownloadDistributionUrl: "https://d2dw6lv4z9w0e2.cloudfront.net/",
  cloudfrontKeyPairId: golden.key_pair_id,
  cloudfrontPrivateKey: golden.private_key_pem,
  cloudflareCacheLimit: 8_000_000_000,
  cdnS3ProxyHost: "https://static-2.gumroad.com",
  publicStorageCdnS3ProxyHost: "https://public-files.gumroad.com",
};

const minio: StorageConfig = {
  ...production,
  env: "development",
  s3Endpoint: "http://localhost:9000",
  usingMinio: true,
  s3Bucket: "gumroad-dev",
};

const cacheKeys = { ...(await cfWorkerCacheKeys(async () => golden.redis_cache_key_overrides)) };

describe("SignedUrlHelper parity with Ruby", () => {
  it.each(golden.cloudfront)("signs CloudFront URL $url (video: $is_video, expires_in: $expires_in)", (c) => {
    expect(
      signedCloudfrontUrl(c.url, { isVideo: c.is_video, expiresIn: c.expires_in ?? undefined, now, config: production }),
    ).toBe(c.result);
  });

  it.each(golden.cloudflare)("signs Cloudflare URL $url", (c) => {
    expect(signedCloudflareUrl(c.url, c.expires_in, { now, hmacKey })).toBe(c.result);
  });

  it.each(golden.validity)("gives a $file_size byte file $seconds seconds", (c) => {
    expect(signedUrlValidityTimeForFileSize(c.file_size)).toBe(c.seconds);
  });

  it.each(golden.content_disposition)("builds the disposition for $s3_filename", (c) => {
    expect(contentDispositionParam(c.s3_key, c.s3_filename)).toBe(c.result);
  });

  it.each(golden.cache_keys)("picks the worker cache key for $s3_filename", (c) => {
    expect(c.s3_filename ? cfCacheKey(c.s3_filename, cacheKeys) ?? null : null).toBe(c.result);
  });

  it.each(golden.download)("signs the download of $s3_key ($content_length bytes)", async (c) => {
    expect(s3PublicUrl(production.s3Bucket, c.s3_key, production)).toBe(c.public_url);
    const url = await signedDownloadUrlForS3KeyAndFilename(c.s3_key, c.s3_filename, {
      isVideo: c.is_video,
      expiresIn: c.expires_in ?? undefined,
      cacheGroup: c.cache_group ?? undefined,
      now,
      config: { ...production },
      headObject: async () => ({ contentLength: c.content_length }),
      cacheKeys,
    });
    expect(url).toBe(c.result);
  });

  it.each(golden.minio)("presigns the MinIO download of $s3_key", async (c) => {
    expect(s3PublicUrl(minio.s3Bucket, c.s3_key, minio)).toBe(c.public_url);
    const url = await signedDownloadUrlForS3KeyAndFilename(c.s3_key, c.s3_filename, {
      isVideo: c.is_video,
      now,
      config: minio,
      headObject: async () => ({ contentLength: c.content_length }),
    });
    expect(url).toBe(c.result);
  });

  it("advances calendar durations like Time#advance, clamping to the month end", () => {
    const jan31 = new Date(Date.UTC(2024, 0, 31, 12));
    expect(expiresAtSeconds(jan31, { months: 1 })).toBe(1709208000);
    expect(expiresAtSeconds(jan31, { years: 1, days: 2, hours: 3 })).toBe(1738508400);
    expect(expiresAtSeconds(new Date(Date.UTC(2024, 1, 29)), { years: 1 })).toBe(Date.UTC(2025, 1, 28) / 1000);
  });
});
