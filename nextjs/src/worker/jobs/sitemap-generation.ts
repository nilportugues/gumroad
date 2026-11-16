// Port of the part of app/services/sitemap_service.rb that Node runs: the generation lock, the XML and gzip SitemapGenerator writes for a
// sitemap of one file, the upload through the dedicated sitemap-uploader identity (AwsSdkAdapter#write), the delete of an emptied
// wishlist sitemap, RobotsService#expire_sitemap_configs_cache and the search engine ping. Local `public/` output (development, test)
// and a sitemap that would span several files (50,000 links or 10 MB) are Rails' to write: they hand back before any write.
// Golden: __fixtures__/sitemap-generation.golden.json (scripts/golden/sitemap-generation.rb); the gzip header carries the wall clock
// and Node's zlib differs from Ruby's, so the replay compares the inflated XML and the S3 call's key, content type and arguments.
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";

import { encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { getConfig } from "../../server/infra/config.ts";
import { railsEnv, type RailsEnv } from "../../server/infra/rails-env.ts";
import { getNamespacedRedis, getRedis } from "../../server/infra/redis.ts";
import { storageConfig, type StorageConfig } from "../../server/infra/storage.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { parameterize } from "../../server/models/friendly-id.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { subdomainWithProtocol } from "../../server/presenters/product.ts";

// RedisKey.sitemap_generation_lock
const GENERATION_LOCK_KEY = "sitemap_generation_lock";
// SitemapService::GENERATION_LOCK_TTL
const GENERATION_LOCK_TTL_SECONDS = 60 * 60;
// SitemapService::RELEASE_GENERATION_LOCK_SCRIPT
const RELEASE_GENERATION_LOCK_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
// SitemapService::MAX_SITEMAP_LINKS and SitemapGenerator::MAX_SITEMAP_FILESIZE
const MAX_SITEMAP_LINKS = 50_000;
const MAX_SITEMAP_FILESIZE = 10_000_000;
// SitemapService::SITEMAP_PATH_WISHLISTS plus the first file name SitemapGenerator's namer hands out
const WISHLIST_SITEMAP_KEY = "sitemap/wishlists/sitemap.xml.gz";
// Wishlist.seo_indexable's floor (Wishlist::MINIMUM_SEO_INDEXABLE_PRODUCTS)
const MINIMUM_SEO_INDEXABLE_PRODUCTS = 3;
const FIND_EACH_BATCH_SIZE = 1_000;
// SitemapGenerator::AwsSdkAdapter's defaults
const UPLOAD_ACL = "public-read";
const UPLOAD_CACHE_CONTROL = "private, max-age=0, no-cache";
const UPLOAD_CONTENT_TYPE = "application/x-gzip";
// LinkSet#search_engines, which the ping fills with the CGI-escaped sitemap URL
const PING_URL = "http://www.google.com/webmasters/tools/ping?sitemap=";
const PING_TIMEOUT_MS = 10_000;
// RobotsService::SITEMAPS_CACHE_KEY
const SITEMAPS_CACHE_KEY = "sitemap_configs";

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0" xmlns:pagemap="http://www.google.com/schemas/sitemap-pagemap/1.0" xmlns:xhtml="http://www.w3.org/1999/xhtml">';
const XML_FOOTER = "</urlset>";

export type SitemapRedis = {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numberOfKeys: number, key: string, token: string): Promise<unknown>;
};

export type SitemapUpload = {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ACL: "public-read";
  CacheControl: string;
  ContentType: string;
};
export type SitemapS3 = {
  put(input: SitemapUpload): Promise<void>;
  delete(input: { Bucket: string; Key: string }): Promise<void>;
};

export type SitemapDeps = {
  redis: () => SitemapRedis;
  // Rails.env
  env: () => RailsEnv;
  storage: () => Pick<StorageConfig, "publicStorageS3Bucket" | "publicStorageCdnS3ProxyHost">;
  s3: () => SitemapS3 | null;
  // SitemapGenerator::Sitemap.ping_search_engines, given the sitemap's URL
  ping: (sitemapUrl: string) => Promise<void>;
  // RobotsService#expire_sitemap_configs_cache
  expireSitemapConfigsCache: () => Promise<void>;
  // SecureRandom.uuid
  uuid: () => string;
};

// The dedicated uploader identity: the default AWS credentials may not be authorized on the sitemap bucket.
function uploaderS3(): SitemapS3 | null {
  const accessKeyId = getConfig("S3_SITEMAP_UPLOADER_ACCESS_KEY");
  const secretAccessKey = getConfig("S3_SITEMAP_UPLOADER_SECRET_ACCESS_KEY");
  if (accessKeyId === undefined || secretAccessKey === undefined) return null;
  const client = new S3Client({ region: storageConfig().region, credentials: { accessKeyId, secretAccessKey } });
  return {
    put: async (input) => {
      await client.send(new PutObjectCommand(input));
    },
    delete: async (input) => {
      await client.send(new DeleteObjectCommand(input));
    },
  };
}

// CGI.escape
const cgiEscape = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()~]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");

// open-uri inside Timeout.timeout(10): a failed ping is logged, never raised.
async function pingSearchEngine(sitemapUrl: string): Promise<void> {
  try {
    await fetch(`${PING_URL}${cgiEscape(sitemapUrl)}`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  } catch {
    // Ping failed for Google
  }
}

export const defaultSitemapDeps: SitemapDeps = {
  redis: () => getRedis("main") as unknown as SitemapRedis,
  env: railsEnv,
  storage: () => storageConfig(),
  s3: uploaderS3,
  ping: pingSearchEngine,
  expireSitemapConfigsCache: async () => {
    await getNamespacedRedis("robots_redis_namespace").del(SITEMAPS_CACHE_KEY);
  },
  uuid: randomUUID,
};

// SitemapService#with_generation_lock: `fn` runs holding the lock. The lock is released in an `ensure` that never raises.
// Resolves to `null` when another run holds it.
export async function withGenerationLock<T>(deps: SitemapDeps, fn: () => Promise<T>): Promise<{ result: T } | null> {
  const redis = deps.redis();
  const token = deps.uuid();
  if ((await redis.set(GENERATION_LOCK_KEY, token, "EX", GENERATION_LOCK_TTL_SECONDS, "NX")) === null) return null;
  try {
    return { result: await fn() };
  } finally {
    try {
      await redis.eval(RELEASE_GENERATION_LOCK_SCRIPT, 1, GENERATION_LOCK_KEY, token);
    } catch {
      // SitemapService logs it: a Redis error must not replace the generation's own outcome.
    }
  }
}

// Builder::XmlMarkup escapes element text; a URL that would need it (a legacy username) is Rails' to write, as no golden covers it.
function plainXmlText(text: string): string {
  if (/[&<>"']|[^ -~]/u.test(text)) throw new HandBackToRuby("a sitemap URL that needs XML escaping");
  return text;
}

// SitemapUrl#w3c_date on an ActiveSupport::TimeWithZone in UTC (config.time_zone is unset)
const w3cDate = (date: Date) => `${date.toISOString().slice(0, 19)}+00:00`;

type SitemapLink = { loc: string; lastmod: Date };

const urlElement = (link: SitemapLink) =>
  `<url><loc>${plainXmlText(link.loc)}</loc><lastmod>${w3cDate(link.lastmod)}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`;

type WishlistRow = { id: bigint | number; user_id: bigint | number; name: string; updated_at: Date };
type SellerRow = { id: bigint | number; username: string | null; external_id: string | null };

// Wishlist.where(id: Wishlist.seo_indexable.select(:id)): the grouped relation cannot be batched by find_each, so its ids are a subquery.
const SEO_INDEXABLE_IDS = Prisma.sql`${column("wishlists", "id")} IN (SELECT ${column("wishlists", "id")} FROM ${table("wishlists")} INNER JOIN ${table("wishlist_products")} ON ${column("wishlist_products", "deleted_at")} IS NULL AND ${column("wishlist_products", "wishlist_id")} = ${column("wishlists", "id")} WHERE ${column("wishlists", "deleted_at")} IS NULL AND ${column("wishlists", "recommendable")} = TRUE GROUP BY ${column("wishlists", "id")} HAVING (COUNT(DISTINCT wishlist_products.product_id) >= ${String(MINIMUM_SEO_INDEXABLE_PRODUCTS)}))`;

// Wishlist#url_slug and `wishlist_path`, on the owner's subdomain (`wishlist.user.subdomain_with_protocol`)
async function wishlistLinks(): Promise<SitemapLink[]> {
  const links: SitemapLink[] = [];
  await findInBatches<WishlistRow>("wishlists", SEO_INDEXABLE_IDS, FIND_EACH_BATCH_SIZE, async (wishlists) => {
    const ownerIds = [...new Map(wishlists.map((wishlist) => [String(wishlist.user_id), wishlist.user_id])).values()];
    const owners = await selectRows<SellerRow>(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${ownerIds.length === 1 ? Prisma.sql`${column("users", "id")} = ${ownerIds[0]}` : Prisma.sql`${column("users", "id")} IN (${Prisma.join(ownerIds, ", ")})`}`,
    );
    const ownersById = new Map(owners.map((owner) => [String(owner.id), owner]));
    for (const wishlist of wishlists) {
      const owner = ownersById.get(String(wishlist.user_id));
      if (owner === undefined) throw new TypeError("undefined method 'subdomain_with_protocol' for nil");
      const host = subdomainWithProtocol(owner);
      // add with no host raises "Cannot generate a url without a host"
      if (host === null) throw new HandBackToRuby("a wishlist owner without a subdomain");
      const slug = `${await beforeSideEffects(() => parameterize(wishlist.name))}-${encryptNumeric(Number(wishlist.id))}`;
      links.push({ loc: `${host}/wishlists/${slug}`, lastmod: wishlist.updated_at });
    }
  });
  return links;
}

function sitemapFile(links: SitemapLink[]): string {
  const xml = links.map(urlElement).join("");
  if (links.length > MAX_SITEMAP_LINKS || Buffer.byteLength(XML_HEADER + xml + XML_FOOTER) >= MAX_SITEMAP_FILESIZE)
    throw new HandBackToRuby("a sitemap that spans several files");
  return XML_HEADER + xml + XML_FOOTER;
}

// SitemapService#generate_wishlists after the lock is taken. Resolves with the work Rails does once the lock is released: nothing.
async function writeWishlistSitemap(deps: SitemapDeps): Promise<void> {
  const env = deps.env();
  // upload_sitemap_to_s3?; anything else writes `public/` on the Rails host
  if (env !== "production" && env !== "staging")
    throw new HandBackToRuby("a sitemap written to the local public directory");
  const s3 = deps.s3();
  if (s3 === null) throw new HandBackToRuby("a sitemap uploader without credentials");
  const storage = deps.storage();

  const links = await wishlistLinks();
  const body = links.length === 0 ? null : gzipSync(Buffer.from(sitemapFile(links)));

  // sitemap_generator only writes a file when it has a link, so an empty run deletes the prior run's object.
  if (body === null) await s3.delete({ Bucket: storage.publicStorageS3Bucket, Key: WISHLIST_SITEMAP_KEY });
  else
    await s3.put({
      Bucket: storage.publicStorageS3Bucket,
      Key: WISHLIST_SITEMAP_KEY,
      Body: body,
      ACL: UPLOAD_ACL,
      CacheControl: UPLOAD_CACHE_CONTROL,
      ContentType: UPLOAD_CONTENT_TYPE,
    });

  await deps.expireSitemapConfigsCache();
  if (env === "production") await deps.ping(`${storage.publicStorageCdnS3ProxyHost}/${WISHLIST_SITEMAP_KEY}`);
}

// SitemapService#generate_wishlists. Resolves `false` when another run holds the lock (the worker comes back later).
export async function generateWishlistSitemap(overrides: Partial<SitemapDeps> = {}): Promise<boolean> {
  const deps = { ...defaultSitemapDeps, ...overrides };
  return (await withGenerationLock(deps, () => writeWishlistSitemap(deps))) !== null;
}
