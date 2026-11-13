// What Link does with the custom permalinks a save gave up (app/models/link.rb `stage_renamed_custom_permalink`,
// `redirect_renamed_custom_permalinks` and the helpers under it): the outgoing slug keeps resolving through a
// ProductPermalinkRedirect of the seller and, when no live product answers on it, a global LegacyPermalink.
import { Prisma } from "@prisma/client";

import { column, execute, isRecordNotUnique, selectRows, table } from "./sql.ts";

// The format both models validate.
const PERMALINK_FORMAT = /^[a-zA-Z0-9_-]+$/u;
const REDIRECTS = "product_permalink_redirects";
const LEGACY = "legacy_permalinks";

type Product = { id: unknown; sellerId: unknown; deleted: boolean };

// A concurrent rename won the insert (RecordNotUnique): the first writer keeps the row.
const swallowDuplicate = async (write: () => Promise<void>) => {
  try {
    await write();
  } catch (error) {
    if (!isRecordNotUnique(error)) throw error;
  }
};

// Link.visible.by_general_permalink(permalink).exists?
async function liveProductAnswersOn(permalink: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND (${column("links", "unique_permalink")} = ${permalink} OR ${column("links", "custom_permalink")} = ${permalink}) LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordProductPermalinkRedirect(outgoing: string, product: Product, now: Date): Promise<void> {
  const [existing] = await selectRows<{ id: unknown; product_id: unknown }>(
    Prisma.sql`SELECT ${column(REDIRECTS, "id")}, ${column(REDIRECTS, "product_id")} FROM ${table(REDIRECTS)} WHERE ${column(REDIRECTS, "seller_id")} = ${product.sellerId} AND ${column(REDIRECTS, "permalink")} = ${outgoing} LIMIT 1`,
  );
  if (existing) {
    if (BigInt(existing.product_id as bigint) === BigInt(product.id as bigint) || product.deleted) return;
    await execute(
      Prisma.sql`UPDATE ${table(REDIRECTS)} SET ${column(REDIRECTS, "product_id")} = ${product.id}, ${column(REDIRECTS, "updated_at")} = ${now} WHERE ${column(REDIRECTS, "id")} = ${existing.id}`,
    );
    return;
  }
  const mapped = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(LEGACY)} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column(LEGACY, "product_id")} WHERE ${column(LEGACY, "permalink")} = ${outgoing} AND ${column("links", "user_id")} = ${product.sellerId} LIMIT 1`,
  );
  if (mapped.length > 0 || !PERMALINK_FORMAT.test(outgoing)) return;
  await swallowDuplicate(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(REDIRECTS)} (${column(REDIRECTS, "product_id")}, ${column(REDIRECTS, "seller_id")}, ${column(REDIRECTS, "permalink")}, ${column(REDIRECTS, "created_at")}, ${column(REDIRECTS, "updated_at")}) VALUES (${product.id}, ${product.sellerId}, ${outgoing}, ${now}, ${now})`,
    );
  });
}

async function recordLegacyPermalink(outgoing: string, product: Product, now: Date): Promise<void> {
  if (await liveProductAnswersOn(outgoing)) return;
  const taken = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(LEGACY)} WHERE ${column(LEGACY, "permalink")} = ${outgoing} LIMIT 1`,
  );
  if (taken.length > 0 || !PERMALINK_FORMAT.test(outgoing)) return;
  await swallowDuplicate(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(LEGACY)} (${column(LEGACY, "permalink")}, ${column(LEGACY, "product_id")}, ${column(LEGACY, "created_at")}, ${column(LEGACY, "updated_at")}) VALUES (${outgoing}, ${product.id}, ${now}, ${now})`,
    );
    // A claim committed since the first check: the mapping would shadow a live product, so it is withdrawn.
    if (await liveProductAnswersOn(outgoing))
      await execute(
        Prisma.sql`DELETE FROM ${table(LEGACY)} WHERE ${column(LEGACY, "permalink")} = ${outgoing} AND ${column(LEGACY, "product_id")} = ${product.id}`,
      );
  });
}

// `outgoing_slugs.uniq.each { redirect_renamed_custom_permalink(_1) }`
export async function redirectRenamedPermalinks(slugs: string[], product: Product, now: Date): Promise<void> {
  for (const outgoing of new Set(slugs)) {
    await recordProductPermalinkRedirect(outgoing, product, now);
    await recordLegacyPermalink(outgoing, product, now);
  }
}
