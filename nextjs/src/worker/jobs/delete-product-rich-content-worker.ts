// Port of app/sidekiq/delete_product_rich_content_worker.rb: Link.find, then each alive page of a deleted product (and of its variants,
// or of the one variant given) is soft-deleted through RichContent#mark_deleted!. Golden: __fixtures__/delete-product-rich-content-worker.golden.json
// (scripts/golden/delete-product-rich-content-worker.rb).
import { Prisma, type BaseVariant, type Link, type RichContent } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { setAssociation } from "../../server/models/concerns/rails-validations.ts";
import { RichContentDeletable, RichContents } from "../../server/models/rich-content-writes.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const RICH_CONTENTS = "rich_contents";
const BASE_VARIANTS = "base_variants";
const FIND_EACH_BATCH_SIZE = 1000;

// ActiveSupport's `blank?` for a job argument: nil, false and a string of whitespace.
const isBlankArgument = (value: unknown) =>
  value === null || value === false || (typeof value === "string" && /^[\p{Z}\s]*$/u.test(value));

type Entity = { type: "Link"; row: Link } | { type: "BaseVariant"; row: BaseVariant };

async function deleteRichContent(entity: Entity, now: () => Date) {
  const scope = Prisma.sql`${column(RICH_CONTENTS, "entity_id")} = ${entity.row.id} AND ${column(RICH_CONTENTS, "entity_type")} = ${entity.type} AND ${column(RICH_CONTENTS, "deleted_at")} IS NULL`;
  const exists = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(RICH_CONTENTS)} WHERE ${scope} LIMIT 1`);
  if (exists.length === 0 || entity.row.deleted_at === null) return;

  await findInBatches<Record<string, unknown>>(RICH_CONTENTS, scope, FIND_EACH_BATCH_SIZE, async (rows) => {
    for (const row of rows) {
      const page = RichContents.load(castRow<RichContent>("RichContent", row));
      // find_each sets the has_many's inverse, so the entity validation does not query, and reads the key doing so.
      setAssociation(page, "entity", page.get("entity_id"), entity.row);
      page.touch("entity_id");
      await RichContentDeletable.markDeletedBang(page, { now });
    }
  });
}

export const deleteProductRichContentWorkerWith = modelJob(
  { min: 1, max: 2 },
  async ([productArg, variantArg = null], deps) => {
    const productId = await beforeSideEffects(() => recordIdFrom(productArg, "Link.find"));
    const product = await findByIdBang<Link>("Link", productId);

    if (!isBlankArgument(variantArg)) {
      const variantId = await beforeSideEffects(() => recordIdFrom(variantArg, "BaseVariant.find"));
      const variant = await findByIdBang<BaseVariant>("BaseVariant", variantId);
      await deleteRichContent({ type: "BaseVariant", row: variant }, deps.now);
      return;
    }

    await deleteRichContent({ type: "Link", row: product }, deps.now);
    // `product.variants`: every Variant of every category of the product, alive or not.
    await findInBatches<Record<string, unknown>>(
      BASE_VARIANTS,
      Prisma.sql`${column(BASE_VARIANTS, "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${product.id}`,
      FIND_EACH_BATCH_SIZE,
      async (rows) => {
        for (const row of rows) {
          await deleteRichContent({ type: "BaseVariant", row: castRow<BaseVariant>("BaseVariant", row) }, deps.now);
        }
      },
      null,
      Prisma.sql`INNER JOIN ${table("variant_categories")} ON ${column(BASE_VARIANTS, "variant_category_id")} = ${column("variant_categories", "id")}`,
    );
  },
);

export const deleteProductRichContentWorker = deleteProductRichContentWorkerWith();
