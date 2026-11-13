// Api::Internal::Admin::ProductsController#index and #show, and the serializers the writes in ./product-writes.ts share. A product
// whose cover is an uploaded file or an oembed (the URL needs ActiveStorage and the CDN) goes to Rails whole.
import { Prisma, type Link, type ProductFile, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { rubyFloatRoundDigits, rubyStringToBigInt } from "../../models/concerns/ruby-numeric.ts";
import { LinkFlags, defaultPriceCents, findLinkBang } from "../../models/link.ts";
import { s3Fields } from "../../models/product-file.ts";
import { selectRows } from "../../models/sql.ts";
import { NotPortedError } from "../../models/user.ts";
import { displayExtension, nameDisplayable } from "../../page-props/audience/product-file-json.ts";
import { longUrl } from "../../page-props/piracy-reports/pages.ts";
import { loadOembed, oembedUrl } from "../../presenters/asset-preview.ts";
import { RubyFloat } from "../../search/es-json.ts";
import { PurchaseFlags } from "../../search/flags.ts";

import { failure, isBlank, jsonRendered, timeJson } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";

export const SOURCE = "app/controllers/api/internal/admin/products_controller.rb";
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 100;
const RECENT_CHARGEBACK_WINDOW_DAYS = 90;
const RATE_DIGITS = 4;
const MS_PER_DAY = 86_400_000;
const NON_GLOBAL_AFFILIATE_TYPES = ["DirectAffiliate", "Collaborator"];
const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";
const SELLER_LOOKUP_BAD_REQUEST_MESSAGE = "email or external_id is required";
export const PRODUCT_NOT_FOUND = "Product not found";

// A parameter Rails would read as something other than the string Node matched on (an array, a hash, a number).
export function textParam(value: unknown): string {
  if (typeof value !== "string") throw new NotPortedError("a parameter that is not text", SOURCE);
  return value;
}

// ExternalId.find_by_external_id: ids that do not decrypt, or decrypt to something no row has, find nothing.
export function idFromExternalId(externalId: string): bigint | null {
  const id = decrypt(externalId);
  return id !== null && Number.isSafeInteger(id) && id > 0 ? BigInt(id) : null;
}

// params[...].to_i
function intParam(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  return rubyStringToBigInt(textParam(value));
}

type FileOwner = { external_id: string | null } | null;

export function serializeFile(file: ProductFile, owner: FileOwner) {
  const fields = s3Fields(file.url, owner?.external_id ?? null);
  return {
    id: encrypt(file.id),
    display_name: nameDisplayable(file, fields),
    file_name: file.filetype === "link" ? file.url : (fields?.filename ?? null),
    extension: displayExtension(file, fields),
    filegroup: file.filegroup,
    file_size: file.size === null ? null : Number(file.size),
    created_at: timeJson(file.created_at),
    deleted_at: timeJson(file.deleted_at),
  };
}

// Link#preview_url is the first live preview's url: an unsplash image is a plain column and an oembed one is read off its iframe.
async function previewUrl(productId: bigint): Promise<string | null> {
  const preview = await db.assetPreview.findFirst({
    where: { link_id: productId, deleted_at: null },
    orderBy: [{ position: { sort: "asc", nulls: "first" } }, { created_at: "asc" }],
  });
  if (preview === null) return null;
  if (preview.unsplash_url !== null && !isBlank(preview.unsplash_url)) return preview.unsplash_url;
  // `url` falls through to the attached file when the oembed document holds no usable iframe.
  const embedded = preview.oembed === null ? null : oembedUrl(loadOembed(preview.oembed)?.html ?? null);
  if (embedded !== null) return embedded;
  throw new NotPortedError("a product cover that is an uploaded file or an oembed without an iframe", SOURCE);
}

type AncestryPaths = Map<string, string[]>;

// TAXONOMY_ANCESTRY_SQL: the slugs from the root down to each taxonomy.
async function taxonomyAncestryPaths(taxonomyIds: bigint[]): Promise<AncestryPaths> {
  const paths: AncestryPaths = new Map();
  if (taxonomyIds.length === 0) return paths;
  const rows = await selectRows<{ descendant_id: bigint | number; slug: string }>(
    Prisma.sql`SELECT h.descendant_id, t.slug FROM taxonomy_hierarchies h INNER JOIN taxonomies t ON t.id = h.ancestor_id WHERE h.descendant_id IN (${Prisma.join(taxonomyIds)}) ORDER BY h.descendant_id, h.generations DESC`,
  );
  for (const row of rows) {
    const key = String(row.descendant_id);
    paths.set(key, [...(paths.get(key) ?? []), row.slug]);
  }
  return paths;
}

async function serializeTaxonomy(taxonomyId: bigint | null, paths: AncestryPaths) {
  if (taxonomyId === null) return null;
  const taxonomy = await db.taxonomy.findUnique({ where: { id: taxonomyId } });
  if (taxonomy === null) return null;
  return {
    id: String(taxonomy.id),
    slug: taxonomy.slug,
    ancestry_path: paths.get(String(taxonomy.id)) ?? [taxonomy.slug],
  };
}

async function serializeAffiliates(productId: bigint) {
  const assignments = await db.productAffiliate.findMany({
    where: { link_id: Number(productId) },
    include: { affiliate: true },
  });
  const kept = assignments
    .filter(
      (assignment) => assignment.affiliate !== null && NON_GLOBAL_AFFILIATE_TYPES.includes(assignment.affiliate.type),
    )
    .sort((a, b) => a.id - b.id);
  const userIds = [
    ...new Set(
      kept.flatMap((assignment) =>
        assignment.affiliate!.affiliate_user_id === null ? [] : [BigInt(assignment.affiliate!.affiliate_user_id)],
      ),
    ),
  ];
  const users =
    userIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, external_id: true, email: true },
        });
  return kept.map((assignment) => {
    const affiliate = assignment.affiliate!;
    const user =
      affiliate.affiliate_user_id === null
        ? undefined
        : users.find((candidate) => candidate.id === BigInt(affiliate.affiliate_user_id!));
    return {
      id: encrypt(affiliate.id),
      type: affiliate.type,
      affiliate_user: user === undefined ? null : { id: user.external_id, email: user.email },
      basis_points: assignment.affiliate_basis_points ?? affiliate.affiliate_basis_points,
      destination_url: assignment.destination_url,
      alive: affiliate.deleted_at === null,
      deleted_at: timeJson(affiliate.deleted_at),
    };
  });
}

// product.product_files.sort_by { [position.nil? ? 0 : 1, position.to_i, id] }: every file, deleted ones included.
async function serializeFiles(productId: bigint, owner: FileOwner) {
  const files = await db.productFile.findMany({ where: { link_id: productId } });
  const key = (file: ProductFile) => [file.position === null ? 0 : 1, file.position ?? 0] as const;
  files.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return files.map((file) => serializeFile(file, owner));
}

async function serializeProduct(product: Link, seller: User | null, paths: AncestryPaths) {
  // Link#long_url asks the seller for its subdomain, which raises without one.
  if (seller === null) throw new NotPortedError("a product without a seller", SOURCE);
  return {
    id: encrypt(product.id),
    name: product.name,
    description: product.description,
    price_cents: await defaultPriceCents(await findLinkBang(product.id)),
    currency_code: product.price_currency_type,
    permalink: product.unique_permalink,
    long_url: longUrl(product, seller),
    preview_url: await previewUrl(product.id),
    created_at: timeJson(product.created_at),
    deleted_at: timeJson(product.deleted_at),
    banned_at: timeJson(product.banned_at),
    purchase_disabled_at: timeJson(product.purchase_disabled_at),
    first_published_at: timeJson(product.first_published_at),
    alive: product.purchase_disabled_at === null && product.banned_at === null && product.deleted_at === null,
    is_adult: LinkFlags.isSet(product.flags, "is_adult"),
    bad_card_counter: product.bad_card_counter,
    taxonomy: await serializeTaxonomy(product.taxonomy_id, paths),
    seller: { id: seller.external_id, email: seller.email },
    affiliates: await serializeAffiliates(product.id),
    files: await serializeFiles(product.id, seller),
  };
}

async function recentChargebackRate(productId: bigint) {
  const since = new Date(Date.now() - RECENT_CHARGEBACK_WINDOW_DAYS * MS_PER_DAY);
  const base = Prisma.sql`${PurchaseFlags.condition("is_bundle_product_purchase", false)} AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND COALESCE(purchases.charge_processor_id, '') != ${PAYPAL_CHARGE_PROCESSOR_ID} AND purchases.link_id = ${productId} AND purchases.created_at >= ${since} AND purchases.purchase_state = 'successful'`;
  const [successful] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM purchases WHERE ${base}`,
  );
  const successfulCount = Number(successful?.count ?? 0);
  if (successfulCount === 0)
    return { window_days: RECENT_CHARGEBACK_WINDOW_DAYS, successful_count: 0, chargedback_count: 0, rate: null };
  const [chargedback] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM purchases WHERE ${base} AND purchases.chargeback_date IS NOT NULL AND ${PurchaseFlags.condition("chargeback_reversed", false)}`,
  );
  const chargedbackCount = Number(chargedback?.count ?? 0);
  return {
    window_days: RECENT_CHARGEBACK_WINDOW_DAYS,
    successful_count: successfulCount,
    chargedback_count: chargedbackCount,
    rate: new RubyFloat(rubyFloatRoundDigits(chargedbackCount / successfulCount, RATE_DIGITS)),
  };
}

export async function serializeSalesHold(hold: Prisma.ProductSalesHoldGetPayload<object> | null) {
  if (hold === null) return null;
  const ids = [hold.held_by_id, ...(hold.released_by_id === null ? [] : [hold.released_by_id])];
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, external_id: true } });
  const externalIdOf = (id: bigint | null) =>
    id === null ? null : (users.find((user) => user.id === id)?.external_id ?? null);
  return {
    id: hold.external_id,
    active: hold.released_at === null,
    unpublished_listing: hold.unpublished_listing,
    held_at: timeJson(hold.created_at),
    held_by_id: externalIdOf(hold.held_by_id),
    released_at: timeJson(hold.released_at),
    released_by_id: externalIdOf(hold.released_by_id),
  };
}

export const activeSalesHold = (productId: bigint) =>
  db.productSalesHold.findFirst({ where: { product_id: productId, released_at: null }, orderBy: { id: "asc" } });

// PagyPresenter#metadata. An overflowing page is `overflow: :empty_page`: no items, `limit` zeroed and `prev` the last page.
export function pagyMetadata(count: number, page: number, limit: number) {
  const last = Math.max(Math.ceil(count / limit), 1);
  if (page > last) return { count, items: 0, page, pages: last, prev: last, next: null, last };
  return {
    count,
    items: limit,
    page,
    pages: last,
    prev: page === 1 ? null : page - 1,
    next: page === last ? null : page + 1,
    last,
  };
}

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/products",
  run: async (admin) => {
    if (isBlank(admin.params.email) && isBlank(admin.params.external_id))
      return failure(SELLER_LOOKUP_BAD_REQUEST_MESSAGE, 400);
    const seller = !isBlank(admin.params.external_id)
      ? await db.user.findFirst({ where: { external_id: textParam(admin.params.external_id) } })
      : await db.user.findFirst({ where: { email: textParam(admin.params.email) }, orderBy: { id: "asc" } });
    if (seller === null) return failure("User not found", 404);

    const requestedPerPage = intParam(admin.params.per_page);
    const limit =
      requestedPerPage > 0n
        ? Number(requestedPerPage < BigInt(MAX_PER_PAGE) ? requestedPerPage : MAX_PER_PAGE)
        : DEFAULT_PER_PAGE;
    const requestedPage = intParam(admin.params.page);
    const page = Number(requestedPage < 1n ? 1n : requestedPage);
    const count = await db.link.count({ where: { user_id: seller.id } });
    const pagination = pagyMetadata(count, page, limit);

    const offset = (page - 1) * limit;
    const ids =
      pagination.items === 0
        ? []
        : (
            await selectRows<{ id: bigint }>(
              Prisma.sql`SELECT links.id FROM links WHERE links.user_id = ${seller.id} ORDER BY ISNULL(COALESCE(purchase_disabled_at, banned_at, links.deleted_at)) DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
            )
          ).map((row) => BigInt(row.id));
    const rows = await db.link.findMany({ where: { id: { in: ids } } });
    const products = ids.map((id) => rows.find((row) => row.id === id)!);
    const paths = await taxonomyAncestryPaths([
      ...new Set(products.flatMap((product) => (product.taxonomy_id === null ? [] : [product.taxonomy_id]))),
    ]);
    const serialized = [];
    for (const product of products) serialized.push(await serializeProduct(product, seller, paths));
    return jsonRendered({ success: true, products: serialized, pagination });
  },
});

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/products/:id",
  run: async (admin) => {
    const id = idFromExternalId(textParam(admin.params.id));
    const product = id === null ? null : await db.link.findUnique({ where: { id } });
    if (product === null) return failure(PRODUCT_NOT_FOUND, 404);

    const seller = product.user_id === null ? null : await db.user.findUnique({ where: { id: product.user_id } });
    const paths = await taxonomyAncestryPaths(product.taxonomy_id === null ? [] : [product.taxonomy_id]);
    const payload = await serializeProduct(product, seller, paths);
    const withContext = {
      ...payload,
      recent_chargeback_rate: await recentChargebackRate(product.id),
      active_sales_hold: await serializeSalesHold(await activeSalesHold(product.id)),
    };
    return jsonRendered({ success: true, product: withContext });
  },
});
