// Port of app/sidekiq/create_licenses_for_existing_customers_worker.rb: every successful, non-gift-sender, non-recurring sale of the
// product gets a License unless it has one already or its variant's own content leaves the license-key block out
// (Purchase#variant_content_permits_license_key?). The reads run in Rails' order and through the query cache, which a write clears.
// Sales are read a thousand at a time, each batch after the licenses of the last; an id Rails casts (a Float, a word) hands back before any statement.
// Golden: __fixtures__/create-licenses-for-existing-customers-worker.golden.json (scripts/golden/create-licenses-for-existing-customers-worker.rb).
import { Prisma, type Link, type License } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { Licenses } from "../../server/models/license.ts";
import { LinkFlags } from "../../server/models/link.ts";
import { hasEditorContent, hasLicenseKey } from "../../server/models/rich-content.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SALES_BATCH_SIZE = 1000;
const SERIAL_GROUP_LENGTH = 8;

type Row = Record<string, unknown>;

// Purchase.successful_gift_or_nongift.not_is_gift_sender_purchase.not_recurring_charge, scoped to the product.
const salesOf = (productId: bigint) =>
  Prisma.sql`${column("purchases", "link_id")} = ${productId} AND ${column("purchases", "purchase_state")} IN ('successful', 'gift_receiver_purchase_successful') AND ((${column("purchases", "flags")} & 64 = 0)) AND (purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32')`;

// `link.alive_variants`: Variants of alive categories.
const ALIVE_VARIANTS_FROM = Prisma.sql`FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")}`;
const aliveVariantsWhere = (productId: unknown) =>
  Prisma.sql`WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL`;

// `alive_rich_contents` of a Link or a BaseVariant
const alivePages = (entityId: unknown, type: "Link" | "BaseVariant") =>
  selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`rich_contents`.*")} FROM ${table("rich_contents")} WHERE ${column("rich_contents", "entity_id")} = ${entityId} AND ${column("rich_contents", "entity_type")} = ${type} AND ${column("rich_contents", "deleted_at")} IS NULL`,
  );

const hasEditorPage = (page: Row) =>
  hasEditorContent({ title: page.title as string | null, description: page.description });

// Link#recoverable_hidden_variant_rich_content?, once the product shares its content across variants and is not physical.
async function recoverableHiddenVariantContent(product: Row): Promise<boolean> {
  if ((await alivePages(product.id, "Link")).some(hasEditorPage)) return false;
  const variants = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} ${ALIVE_VARIANTS_FROM} ${aliveVariantsWhere(product.id)}`,
  );
  for (const variant of variants) {
    if ((await alivePages(variant.id, "BaseVariant")).some(hasEditorPage)) return true;
  }
  return false;
}

// Link#has_product_level_rich_content?
async function hasProductLevelRichContent(product: Row): Promise<boolean> {
  if (LinkFlags.isSet(product.flags as bigint, "is_physical")) return true;
  const [alive] = await selectRows<Row>(
    Prisma.sql`SELECT 1 AS one ${ALIVE_VARIANTS_FROM} ${aliveVariantsWhere(product.id)} LIMIT 1`,
  );
  if (alive === undefined) return true;
  return (
    LinkFlags.isSet(product.flags as bigint, "has_same_rich_content_for_all_variants") &&
    !(await recoverableHiddenVariantContent(product))
  );
}

// Purchase#variant_content_permits_license_key?
async function variantContentPermitsLicenseKey(purchase: Row, product: Row): Promise<boolean> {
  if (await hasProductLevelRichContent(product)) return true;

  const variants = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id}`,
  );
  const pages: Row[] = [];
  for (const variant of variants) pages.push(...(await alivePages(variant.id, "BaseVariant")));
  return pages.length === 0 || pages.some((page) => hasLicenseKey(page.description));
}

// License#generate_serial: the uuid's 32 hex digits in groups of eight.
export function licenseSerial(uuid: string): string {
  const digits = uuid.toUpperCase().replaceAll("-", "");
  const groups: string[] = [];
  for (let i = 0; i + SERIAL_GROUP_LENGTH <= digits.length; i += SERIAL_GROUP_LENGTH)
    groups.push(digits.slice(i, i + SERIAL_GROUP_LENGTH));
  return groups.join("-");
}

export const createLicensesForExistingCustomersWorkerWith = modelJob({ min: 1 }, async ([productId], deps) => {
  if (productId === null) throw new RecordNotFound("Couldn't find Link without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findOneBy<Link>("Link", "id", id);
  if (product === null) throw new RecordNotFound(`Couldn't find Link with 'id'=${String(id)}`);

  await findInBatches<Row>("purchases", salesOf(id), SALES_BATCH_SIZE, async (purchases) => {
    for (const purchase of purchases) {
      if (!(await variantContentPermitsLicenseKey(purchase, product as unknown as Row))) continue;

      // License.where(link:, purchase:).first_or_create!
      const [existing] = await selectRows<Row>(
        Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "link_id")} = ${id} AND ${column("licenses", "purchase_id")} = ${purchase.id} ORDER BY ${column("licenses", "id")} ASC LIMIT 1`,
      );
      if (existing !== undefined) continue;
      await transaction(() =>
        Licenses.createBang(
          { link_id: id, purchase_id: purchase.id as bigint, serial: licenseSerial(deps.uuid()) } as unknown as Partial<License>,
          { now: deps.now },
        ),
      );
    }
  });
});

export const createLicensesForExistingCustomersWorker = createLicensesForExistingCustomersWorkerWith();
