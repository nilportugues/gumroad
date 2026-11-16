import { storageConfig, type StorageConfig } from "./storage.ts";

// config/initializers/cdn_url_map.rb: origin prefix => CDN prefix, applied in this order.
export function cdnUrlMap(config: StorageConfig = storageConfig()): [string, string][] {
  const { s3Endpoint, cdnS3ProxyHost, publicStorageCdnS3ProxyHost } = config;
  if (config.env === "production") {
    return [
      [`${s3Endpoint}/gumroad/`, `${cdnS3ProxyHost}/res/gumroad/`],
      ["https://gumroad-public-storage.s3.amazonaws.com/", `${publicStorageCdnS3ProxyHost}/`],
    ];
  }
  return [
    [`${s3Endpoint}/gumroad/`, `${cdnS3ProxyHost}/res/gumroad/`],
    [`${s3Endpoint}/gumroad-staging/`, `${cdnS3ProxyHost}/res/gumroad-staging/`],
    [`${s3Endpoint}/gumroad_dev/`, `${cdnS3ProxyHost}/res/gumroad_dev/`],
    ["https://gumroad-dev-public-storage.s3.amazonaws.com/", `${publicStorageCdnS3ProxyHost}/`],
  ];
}

// CdnUrlHelper#cdn_url_for: String#gsub with a String pattern replaces every literal occurrence.
export function cdnUrlFor(content: string | null | undefined, config: StorageConfig = storageConfig()): string | null | undefined {
  if (content === null || content === undefined || content.trim() === "") return content;
  let result = content;
  for (const [origin, cdn] of cdnUrlMap(config)) result = result.split(origin).join(cdn);
  return result;
}
