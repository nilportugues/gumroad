// Port of ProductBuild#select_as_demo! / #unselect_as_demo! and the checks the API runs before them (app/models/product_build.rb). The Prisma
// client predates `demo_selected_at`, so the column is read and written in SQL.
import type { ProductBuild } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { productBuildValid } from "./product-build.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const FILE = "app/models/product_build.rb";
const LIVE = "live";
// Link.purchase_type enum :purchase_type, %i[buy_only rent_only buy_and_rent]
const RENT_ONLY = 1;
// FlagShihTzu bit of Link `is_recurring_billing` (flag 2).
const IS_RECURRING_BILLING = 2n;
// FlagShihTzu bit of BasePrice `is_rental` (flag 1).
const IS_RENTAL = 1n;

export type DemoBuildRow = ProductBuild & { demo_selected_at: Date | null };

// The build as stored, with the column the Prisma client does not know.
export async function findDemoBuild(buildId: bigint): Promise<DemoBuildRow | undefined> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_builds`.*")} FROM ${table("product_builds")} WHERE ${column("product_builds", "id")} = ${buildId} LIMIT 1`,
  );
  if (row === undefined) return undefined;
  return {
    ...castRow<ProductBuild & Record<string, unknown>>("ProductBuild", row),
    demo_selected_at: (row.demo_selected_at as Date | null) ?? null,
  };
}

// The builds of the product that are the demo, for `demo: demo_selected?` in ProductBuild#as_json.
export async function demoSelectedBuildIds(productId: bigint): Promise<Set<bigint>> {
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column("product_builds", "id")} AS id FROM ${table("product_builds")} WHERE ${column("product_builds", "product_id")} = ${productId} AND ${column("product_builds", "demo_selected_at")} IS NOT NULL`,
  );
  return new Set(rows.map((row) => BigInt(row.id)));
}

// ProductBuild.free_product?: a product nobody pays for in any version. `price_cents` is the default buy price (Product::Prices), not the
// legacy `links.price_cents` column.
async function freeProduct(productId: bigint): Promise<boolean> {
  const [product] = await selectRows<{
    price_currency_type: string | null;
    purchase_type: number | null;
    flags: bigint | number | null;
  }>(
    Prisma.sql`SELECT ${column("links", "price_currency_type")}, ${column("links", "purchase_type")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1`,
  );
  if (product === undefined) return false;
  if (Number(product.purchase_type) === RENT_ONLY) return false;
  if ((BigInt(product.flags ?? 0) & IS_RECURRING_BILLING) !== 0n) return false;
  const [buyPrice] = await selectRows<{ price_cents: number | bigint | null }>(
    Prisma.sql`SELECT ${column("prices", "price_cents")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${productId} AND ${column("prices", "deleted_at")} IS NULL AND ${column("prices", "currency")} = ${product.price_currency_type} AND (${column("prices", "flags")} & ${IS_RENTAL}) = 0 ORDER BY ${column("prices", "id")} DESC LIMIT 1`,
  );
  if (buyPrice === undefined || Number(buyPrice.price_cents) !== 0) return false;

  const aliveVariants = Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL`;
  const [dearer] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} IN (${aliveVariants}) AND ${column("base_variants", "price_difference_cents")} > 0 LIMIT 1`,
  );
  if (dearer !== undefined) return false;
  const [priced] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("prices")} WHERE ${column("prices", "deleted_at")} IS NULL AND (${column("prices", "flags")} & ${IS_RENTAL}) = 0 AND ${column("prices", "variant_id")} IN (${aliveVariants}) AND ${column("prices", "price_cents")} > 0 LIMIT 1`,
  );
  return priced === undefined;
}

// ProductBuild#purchased_version?: what buyers of a paid product get.
export async function purchasedVersion(build: DemoBuildRow): Promise<boolean> {
  return build.status === LIVE && !(await freeProduct(build.product_id));
}

const present = (value: string | null | undefined) => value != null && value.trim() !== "";

// `site_unpack_error.present?`
export const hasUnpackError = (build: DemoBuildRow) => present(build.site_unpack_error);

// ProductBuild#select_as_demo!: serialised on the product row, the other demo is cleared and this build is marked. Returns the stored build.
// A build that no longer validates is handed back before its first write (update! would raise).
export async function selectAsDemoBang(build: DemoBuildRow, options: { now?: () => Date } = {}): Promise<DemoBuildRow> {
  const now = options.now ?? (() => new Date());
  if (!productBuildValid(build)) throw new NotPortedError("a build that no longer validates", FILE);
  await transaction(async () => {
    // product.with_lock: lock!, which reloads the row under FOR UPDATE.
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${build.product_id} LIMIT 1 FOR UPDATE`,
    );
    await execute(
      Prisma.sql`UPDATE ${table("product_builds")} SET ${column("product_builds", "demo_selected_at")} = NULL, ${column("product_builds", "updated_at")} = ${now()} WHERE ${column("product_builds", "product_id")} = ${build.product_id} AND ${column("product_builds", "demo_selected_at")} IS NOT NULL AND ${column("product_builds", "id")} != ${build.id}`,
    );
    const at = now();
    await execute(
      Prisma.sql`UPDATE ${table("product_builds")} SET ${column("product_builds", "demo_selected_at")} = ${at}, ${column("product_builds", "updated_at")} = ${at} WHERE ${column("product_builds", "id")} = ${build.id}`,
    );
  });
  if (build.site_unpacked_at == null) await performAsync("ProductBuildUnpackJob", [Number(build.id)]);
  return (await findDemoBuild(build.id))!;
}

// ProductBuild#unselect_as_demo!: with_lock reloads the build, and update! writes only when the demo was set.
export async function unselectAsDemoBang(buildId: bigint, options: { now?: () => Date } = {}): Promise<DemoBuildRow> {
  const now = options.now ?? (() => new Date());
  return transaction(async () => {
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`product_builds`.*")} FROM ${table("product_builds")} WHERE ${column("product_builds", "id")} = ${buildId} LIMIT 1 FOR UPDATE`,
    );
    const locked = (await findDemoBuild(buildId))!;
    if (!productBuildValid(locked)) throw new NotPortedError("a build that no longer validates", FILE);
    if (locked.demo_selected_at !== null)
      await execute(
        Prisma.sql`UPDATE ${table("product_builds")} SET ${column("product_builds", "demo_selected_at")} = NULL, ${column("product_builds", "updated_at")} = ${now()} WHERE ${column("product_builds", "id")} = ${buildId}`,
      );
    return (await findDemoBuild(buildId))!;
  });
}
