import { getConfig } from "./config.ts";
import { railsEnv, type RailsEnv } from "./rails-env.ts";

// Constants from config/initializers/aws.rb, cloudflare.rb and cdn_url_map.rb, computed from the
// same config so both apps sign for, and link to, the same buckets and distributions.

export type StorageConfig = {
  env: RailsEnv;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  s3Endpoint: string;
  region: string;
  usingMinio: boolean;
  s3Bucket: string;
  publicStorageS3Bucket: string;
  invoicesS3Bucket: string;
  s3BaseUrl: string;
  hlsDistributionUrl: string;
  fileDownloadDistributionUrl: string;
  cloudfrontDownloadDistributionUrl: string;
  cloudfrontKeyPairId: string | undefined;
  cloudfrontPrivateKey: string | undefined;
  cloudflareCacheLimit: number;
  cdnS3ProxyHost: string;
  publicStorageCdnS3ProxyHost: string;
};

const S3_BUCKETS: Record<RailsEnv, string> = {
  development: "gumroad-dev",
  staging: "gumroad_dev",
  test: "gumroad-specs",
  production: "gumroad",
};

const PUBLIC_STORAGE_S3_BUCKETS: Record<RailsEnv, string> = {
  development: "gumroad-dev-public-storage",
  staging: "gumroad-dev-public-storage",
  test: "gumroad-specs",
  production: "gumroad-public-storage",
};

const DEFAULT_CLOUDFLARE_CACHE_LIMIT = 8_000_000_000; // 8GB

// Ruby's String#to_i on GlobalConfig.get("CLOUDFLARE_CACHE_LIMIT", 8_000_000_000).
function toI(value: string): number {
  const match = /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
  return match ? Number.parseInt(match[0].replaceAll("_", ""), 10) : 0;
}

export function storageConfig(env: RailsEnv = railsEnv()): StorageConfig {
  const s3Endpoint = getConfig("AWS_S3_ENDPOINT", "https://s3.amazonaws.com");
  const usingMinio = s3Endpoint !== "" && !s3Endpoint.includes("amazonaws.com");
  const s3Bucket = S3_BUCKETS[env];

  let hlsDistributionUrl: string;
  let fileDownloadDistributionUrl: string;
  let cloudfrontDownloadDistributionUrl: string;
  if (env === "production") {
    hlsDistributionUrl = getConfig("HLS_DISTRIBUTION_URL_PROD", "https://d1bdh6c3ceakz5.cloudfront.net/");
    fileDownloadDistributionUrl = getConfig("FILE_DOWNLOAD_DISTRIBUTION_URL_PROD", "https://files.gumroad.com/");
    cloudfrontDownloadDistributionUrl = getConfig("CLOUDFRONT_DOWNLOAD_DISTRIBUTION_URL_PROD", "https://d2dw6lv4z9w0e2.cloudfront.net/");
  } else {
    hlsDistributionUrl = getConfig("HLS_DISTRIBUTION_URL_DEV", "https://d1jmbc8d0c0hid.cloudfront.net/");
    if (usingMinio) {
      fileDownloadDistributionUrl = `${s3Endpoint}/${s3Bucket}/`;
      cloudfrontDownloadDistributionUrl = `${s3Endpoint}/${s3Bucket}/`;
    } else {
      fileDownloadDistributionUrl = getConfig("FILE_DOWNLOAD_DISTRIBUTION_URL_DEV", "https://staging-files.gumroad.com/");
      cloudfrontDownloadDistributionUrl = getConfig("CLOUDFRONT_DOWNLOAD_DISTRIBUTION_URL_DEV", "https://d3t5lixau6dhwk.cloudfront.net/");
    }
  }

  const cdnHosts: Record<RailsEnv, [string, string]> = {
    development: ["https://staging-static-2.gumroad.com", s3Endpoint],
    test: ["https://test-static-2.gumroad.com", "https://test-public-files.gumroad.com"],
    staging: ["https://staging-static-2.gumroad.com", "https://staging-public-files.gumroad.com"],
    production: ["https://static-2.gumroad.com", "https://public-files.gumroad.com"],
  };

  return {
    env,
    accessKeyId: getConfig("AWS_ACCESS_KEY_ID"),
    secretAccessKey: getConfig("AWS_SECRET_ACCESS_KEY"),
    s3Endpoint,
    region: getConfig("AWS_DEFAULT_REGION", "us-east-1"),
    usingMinio,
    s3Bucket,
    publicStorageS3Bucket: PUBLIC_STORAGE_S3_BUCKETS[env],
    invoicesS3Bucket: getConfig("INVOICES_S3_BUCKET", "gumroad-invoices"),
    s3BaseUrl: getConfig("S3_BASE_URL_TEMPLATE", `${s3Endpoint}/${s3Bucket}/`),
    hlsDistributionUrl,
    fileDownloadDistributionUrl,
    cloudfrontDownloadDistributionUrl,
    cloudfrontKeyPairId: getConfig("CLOUDFRONT_KEYPAIR_ID"),
    cloudfrontPrivateKey: getConfig("CLOUDFRONT_PRIVATE_KEY"),
    cloudflareCacheLimit: toI(getConfig("CLOUDFLARE_CACHE_LIMIT", String(DEFAULT_CLOUDFLARE_CACHE_LIMIT))),
    cdnS3ProxyHost: cdnHosts[env][0],
    publicStorageCdnS3ProxyHost: cdnHosts[env][1],
  };
}
