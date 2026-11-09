// The reads behind mobile-serializers.ts: the rows a page of purchases serializes from, loaded in a bounded number of queries.
import { Prisma, type Link, type User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { hasAttachment } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { purchaseAsJsonCreatorApp } from "./mobile-serializers.ts";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// link.thumbnail&.alive&.url.presence: has_one :thumbnail is the first row whatever its state; only an alive one has a url.
export async function thumbnailUrlsByProduct(productIds: bigint[]): Promise<Map<bigint, string | null>> {
  const urls = new Map<bigint, string | null>();
  if (productIds.length === 0) return urls;
  const rows = await selectRows<{
    id: bigint;
    product_id: bigint;
    unsplash_url: string | null;
    deleted_at: Date | null;
  }>(
    Prisma.sql`SELECT ${column("thumbnails", "id")}, ${column("thumbnails", "product_id")}, ${column("thumbnails", "unsplash_url")}, ${column("thumbnails", "deleted_at")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} IN (${Prisma.join(productIds)}) ORDER BY ${column("thumbnails", "id")} ASC`,
  );
  for (const row of rows) {
    const productId = BigInt(row.product_id);
    if (urls.has(productId)) continue;
    if (row.deleted_at != null) urls.set(productId, null);
    else if (present(row.unsplash_url)) urls.set(productId, row.unsplash_url);
    else if (await hasAttachment("Thumbnail", BigInt(row.id), "file"))
      throw new NotPortedError("Thumbnail#url for an uploaded file");
    else urls.set(productId, null);
  }
  return urls;
}

// link.variant_categories_alive.exists?
async function productsWithVariants(productIds: bigint[]): Promise<Set<bigint>> {
  if (productIds.length === 0) return new Set();
  const rows = await selectRows<{ link_id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} IN (${Prisma.join(productIds)}) AND ${column("variant_categories", "deleted_at")} IS NULL`,
  );
  return new Set(rows.map((row) => BigInt(row.link_id)));
}

// SalesController#index: `Purchase.where(id: ids).in_order_of(:id, ids).as_json(creator_app_api: true)`. An id with no row is dropped.
export async function creatorAppPurchasesJson(
  ids: bigint[],
  now: Date = new Date(),
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const purchases = await db.purchase.findMany({ where: { id: { in: ids } } });
  const byId = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);

  const productIds = [...new Set(ordered.map((purchase) => purchase.link_id).filter((id): id is bigint => id != null))];
  const userIds = [
    ...new Set(
      ordered
        .flatMap((purchase) => [purchase.seller_id, purchase.purchaser_id])
        .filter((id): id is bigint => id != null),
    ),
  ];
  const [links, users, thumbnails, withVariants] = await Promise.all([
    db.link.findMany({ where: { id: { in: productIds } } }),
    db.user.findMany({ where: { id: { in: userIds } } }),
    thumbnailUrlsByProduct(productIds),
    productsWithVariants(productIds),
  ]);
  const linkById = new Map<bigint, Link>(links.map((link) => [link.id, link]));
  const userById = new Map<bigint, User>(users.map((user) => [user.id, user]));

  return ordered.map((purchase) => {
    const link = purchase.link_id == null ? undefined : linkById.get(purchase.link_id);
    const seller = purchase.seller_id == null ? undefined : userById.get(purchase.seller_id);
    if (!link || !seller) throw new NotPortedError("a purchase whose product or seller row is missing");
    return purchaseAsJsonCreatorApp({
      purchase,
      link,
      seller,
      purchaser: purchase.purchaser_id == null ? null : (userById.get(purchase.purchaser_id) ?? null),
      productHasVariants: withVariants.has(link.id),
      productThumbnailUrl: thumbnails.get(link.id) ?? null,
      now,
    });
  });
}
