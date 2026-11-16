// Port of app/sidekiq/update_bundle_purchases_content_job.rb up to the first sale to update. `Link.is_bundle.find`, the newest change to
// the bundle's alive bundle products and the first find_in_batches batch of qualifying sales run in Node and finish a bundle with no
// sale bought before its content last changed. A sale to update is Purchase::UpdateBundlePurchaseContentService (product purchases,
// mail), which hands back to Rails before any write, as does an id Rails casts.
// Golden: __fixtures__/update-bundle-purchases-content-job.golden.json (scripts/golden/update-bundle-purchases-content-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { column, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_IN_BATCHES_SIZE = 1_000;
// Link `has_flags 26 => :is_bundle` and Purchase `has_flags 26 => :is_bundle_purchase`
const IS_BUNDLE = 1 << 25;

const bundleFlag = Prisma.sql`((${column("links", "flags")} & ${Prisma.raw(String(IS_BUNDLE))} = ${Prisma.raw(String(IS_BUNDLE))}))`;

// bundle.sales.is_bundle_purchase.successful_gift_or_nongift.not_chargedback.not_fully_refunded.where(created_at: ..content_updated_at)
function qualifyingSales(bundleId: bigint, contentUpdatedAt: Date | null): Prisma.Sql {
  return Prisma.sql`${column("purchases", "link_id")} = ${bundleId} AND ((${column("purchases", "flags")} & ${Prisma.raw(String(IS_BUNDLE))} = ${Prisma.raw(String(IS_BUNDLE))})) AND ${column("purchases", "purchase_state")} IN ('successful', 'gift_receiver_purchase_successful') AND (purchases.chargeback_date IS NULL) AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND ${contentUpdatedAt === null ? Prisma.raw("1=1") : Prisma.sql`${column("purchases", "created_at")} <= ${contentUpdatedAt}`}`;
}

export const updateBundlePurchasesContentJobWith = modelJob({ min: 1 }, async ([bundleId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(bundleId, "Link.is_bundle.find"));
  const [bundle] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${bundleFlag} AND ${column("links", "id")} = ${id} LIMIT 1`,
  );
  if (!bundle) {
    throw new RecordNotFound(
      `Couldn't find Link with 'id'=${String(id)} [WHERE ((\`links\`.\`flags\` & ${String(IS_BUNDLE)} = ${String(IS_BUNDLE)}))]`,
    );
  }

  const [newest] = await selectRows<Record<string, Date | null>>(
    Prisma.sql`SELECT MAX(${column("bundle_products", "updated_at")}) FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${id} AND ${column("bundle_products", "deleted_at")} IS NULL`,
  );
  const contentUpdatedAt = newest === undefined ? null : (Object.values(newest)[0] ?? null);

  await findInBatches("purchases", qualifyingSales(id, contentUpdatedAt), FIND_IN_BATCHES_SIZE, () => {
    throw new HandBackToRuby("a bundle sale whose product purchases are missing");
  });
});
export const updateBundlePurchasesContentJob = updateBundlePurchasesContentJobWith();
