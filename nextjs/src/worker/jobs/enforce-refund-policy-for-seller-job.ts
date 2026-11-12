// Port of app/sidekiq/enforce_refund_policy_for_seller_job.rb up to the enforcement itself: finds the purchase's seller, applies the
// idempotence guard and the dispute-rate volume gates (User#dispute_rate_stats) and returns when they say there is nothing to do.
// A seller who does call for enforcement (the user update, the refund policy bump and the admin comment run in one transaction,
// through user callbacks Node does not run) is handed back before the transaction opens.
// Golden: __fixtures__/enforce-refund-policy-for-seller-job.golden.json (scripts/golden/enforce-refund-policy-for-seller-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { UserFlags } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const PURCHASES = "purchases";
// User::MIN_SETTLED_PURCHASES_FOR_REFUND_POLICY_ENFORCEMENT, MIN_DISPUTING_BUYERS_FOR_REFUND_POLICY_ENFORCEMENT and
// MAX_DISPUTE_COUNT_RATE_ALLOWED_FOR_CUSTOM_REFUND_POLICY
const MIN_SETTLED_PURCHASES = 25;
const MIN_DISPUTING_BUYERS = 3;
const MAX_DISPUTE_COUNT_RATE = 1.0;
// Purchase.flag_mapping["flags"][:chargeback_reversed]
const CHARGEBACK_REVERSED = 512;

// `sales.successful.excluding_paypal_processor`
const SETTLED = Prisma.sql`${column(PURCHASES, "purchase_state")} = 'successful' AND (COALESCE(purchases.charge_processor_id, '') != 'paypal')`;
const BUYER_KEY = Prisma.raw("COALESCE(purchases.email, CONCAT('missing-email-', purchases.id))");

async function count(query: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<Record<string, bigint | number>>(query);
  return Number(Object.values(row ?? { count: 0 })[0]);
}

export const enforceRefundPolicyForSellerJobWith = modelJob({ min: 1, max: 1 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = await findByIdBang<{ id: bigint; seller_id: bigint | null }>("Purchase", id);
  if (purchase.seller_id === null) return;
  const seller = await findById<{ flags: bigint | number }>("User", purchase.seller_id);
  if (seller === null) return;
  if (UserFlags.isSet(BigInt(seller.flags), "refund_policy_enforced")) return;

  const base = Prisma.sql`FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "seller_id")} = ${purchase.seller_id} AND ${SETTLED}`;
  const settledCount = await count(Prisma.sql`SELECT COUNT(*) ${base}`);
  const settledBuyers = await count(Prisma.sql`SELECT COUNT(DISTINCT ${BUYER_KEY}) ${base}`);
  const disputingBuyers = await count(
    Prisma.sql`SELECT COUNT(DISTINCT ${BUYER_KEY}) ${base} AND ${column(PURCHASES, "chargeback_date")} IS NOT NULL AND (purchases.flags & ${String(CHARGEBACK_REVERSED)} = 0)`,
  );
  if (settledCount < MIN_SETTLED_PURCHASES) return;
  if (disputingBuyers < MIN_DISPUTING_BUYERS) return;
  const rate = settledBuyers > 0 ? (disputingBuyers * 100.0) / settledBuyers : null;
  if (rate === null || rate <= MAX_DISPUTE_COUNT_RATE) return;
  throw new HandBackToRuby(
    "a seller past the dispute rate is enforced in one transaction of user, policy and comment writes",
  );
});

export const enforceRefundPolicyForSellerJob = enforceRefundPolicyForSellerJobWith();
