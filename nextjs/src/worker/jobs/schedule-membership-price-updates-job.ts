// Port of app/sidekiq/schedule_membership_price_updates_job.rb up to the first subscription of the product. Variant.find, the tier's
// price-change flag, its category's product and the tiered-membership flag, then the subscriptions' first find_each batch: a tier
// that changes nothing, a product that is not a tiered membership and a product with no subscription finish here without a write.
// A subscription means plan changes and a price recalculation (Subscription#update_current_plan!, Purchase#set_price_and_rate), which
// hand back to Rails before any write, as does an id Rails casts.
// Golden: __fixtures__/schedule-membership-price-updates-job.golden.json (scripts/golden/schedule-membership-price-updates-job.rb).
import { Prisma, type BaseVariant, type Link, type VariantCategory } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { LinkFlags } from "../../server/models/link.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { castRow, column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
// BaseVariant `has_flags 2 => :apply_price_changes_to_existing_memberships`
const APPLY_PRICE_CHANGES_TO_EXISTING_MEMBERSHIPS = 2n;

// Variant.find(id): the STI scope adds the type to the primary key lookup.
async function findVariantBang(id: bigint): Promise<BaseVariant> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "id")} = ${id} LIMIT 1`,
  );
  if (!row) throw new RecordNotFound(`Couldn't find Variant with 'id'=${String(id)}`);
  return castRow<BaseVariant>("BaseVariant", row);
}

export const scheduleMembershipPriceUpdatesJobWith = modelJob({ min: 1 }, async ([tierId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(tierId, "Variant.find"));
  const tier = await findVariantBang(id);
  if ((BigInt(tier.flags) & APPLY_PRICE_CHANGES_TO_EXISTING_MEMBERSHIPS) === 0n) return;

  // `tier.link` is delegated to the variant category
  const category = await findOneBy<VariantCategory>("VariantCategory", "id", tier.variant_category_id);
  if (category === null) throw new TypeError("link delegated to variant_category, but variant_category is nil");
  const product = await findOneBy<Link>("Link", "id", category.link_id);
  if (product === null) throw new TypeError("undefined method 'is_tiered_membership?' for nil");
  if (!LinkFlags.isSet(product.flags, "is_tiered_membership")) return;

  await findInBatches(
    "subscriptions",
    Prisma.sql`${column("subscriptions", "link_id")} = ${product.id}`,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a membership with subscriptions to move to the new price");
    },
  );
});
export const scheduleMembershipPriceUpdatesJob = scheduleMembershipPriceUpdatesJobWith();
