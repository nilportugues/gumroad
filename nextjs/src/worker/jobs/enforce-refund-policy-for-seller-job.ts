// Port of app/sidekiq/enforce_refund_policy_for_seller_job.rb (Purchase::Blockable#enforce_refund_policy_for_seller_based_on_dispute_rate!):
// finds the purchase's seller, applies the idempotence guard and the dispute-rate volume gates (User#dispute_rate_stats) and, for a
// seller past the rate, enforces: in one transaction the seller's flag, the seller-level policy bump (a "No refunds allowed" policy
// becomes 30 days, its fine print cleared) and the admin comment, then the creator mail once the transaction commits.
// Golden: __fixtures__/enforce-refund-policy-for-seller-job.golden.json (scripts/golden/enforce-refund-policy-for-seller-job.rb).
import type { RefundPolicy } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { Comments, COMMENT_TYPES } from "../../server/models/comment.ts";
import { RefundPolicies } from "../../server/models/refund-policy.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { findUser, isFlagSet, NoMethodError, setFlag, Users } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const PURCHASES = "purchases";
// User::MIN_SETTLED_PURCHASES_FOR_REFUND_POLICY_ENFORCEMENT, MIN_DISPUTING_BUYERS_FOR_REFUND_POLICY_ENFORCEMENT and
// MAX_DISPUTE_COUNT_RATE_ALLOWED_FOR_CUSTOM_REFUND_POLICY
const MIN_SETTLED_PURCHASES = 25;
const MIN_DISPUTING_BUYERS = 3;
const MAX_DISPUTE_COUNT_RATE = 1.0;
// User::ENFORCED_MIN_REFUND_PERIOD_IN_DAYS and REFUND_POLICY_ENFORCEMENT_COMMENT_AUTHOR
const ENFORCED_MIN_REFUND_PERIOD_IN_DAYS = 30;
const COMMENT_AUTHOR = "enforce_refund_policy_for_seller_based_on_dispute_rate";
const MAILER = "ContactingCreatorMailer";
const MAILER_METHOD = "refund_policy_enforced_notification";
// Purchase.flag_mapping["flags"][:chargeback_reversed]
const CHARGEBACK_REVERSED = 512;

// `sales.successful.excluding_paypal_processor`
const SETTLED = Prisma.sql`${column(PURCHASES, "purchase_state")} = 'successful' AND (COALESCE(purchases.charge_processor_id, '') != 'paypal')`;
const BUYER_KEY = Prisma.raw("COALESCE(purchases.email, CONCAT('missing-email-', purchases.id))");

async function count(query: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<Record<string, bigint | number>>(query);
  return Number(Object.values(row ?? { count: 0 })[0]);
}

// `format("%.1f", value)`: C's printf, which rounds an exact tie to the even digit where Number#toFixed rounds it up.
export function formatOneDecimal(value: number): string {
  const [whole, fraction] = value.toFixed(100).split(".") as [string, string];
  const kept = BigInt(whole + fraction[0]!);
  const next = fraction[1]!;
  const tie = next === "5" && /^0*$/u.test(fraction.slice(2));
  const up = next > "5" || (next === "5" && !tie) || (tie && kept % 2n === 1n);
  const rounded = String(up ? kept + 1n : kept).padStart(2, "0");
  return `${rounded.slice(0, -1)}.${rounded.slice(-1)}`;
}

// `seller.refund_policy`: the seller-level policy (`product_id` NULL).
async function sellerRefundPolicy(sellerId: bigint) {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`refund_policies`.*")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${sellerId} AND ${column("refund_policies", "product_id")} IS NULL LIMIT 1`,
  );
  if (!row) return null;
  const policy = RefundPolicies.load(castRow<RefundPolicy>("RefundPolicy", row));
  // Loading a has_one reads the foreign key, which PaperTrail's `object` then lists first.
  policy.touch("seller_id");
  return policy;
}

export const enforceRefundPolicyForSellerJobWith = modelJob(
  { min: 1, max: 1 },
  async ([purchaseId], deps, { runtime }) => {
    const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
    const purchase = await findByIdBang<{ id: bigint; seller_id: bigint | null }>("Purchase", id);
    if (purchase.seller_id === null) return;
    const seller = await findUser(purchase.seller_id);
    if (seller === null) return;
    if (isFlagSet(seller, "refund_policy_enforced")) return;

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

    const options = { now: deps.now };
    await transaction(async () => {
      setFlag(seller, "refund_policy_enforced", true);
      await Users.saveBang(seller, options);

      // A "No refunds allowed" (0-day) policy is the one that drives buyers to their bank; longer periods are fine.
      const policy = await sellerRefundPolicy(purchase.seller_id as bigint);
      if (policy !== null) {
        const days = policy.get("max_refund_period_in_days");
        if (days === null) throw new NoMethodError("undefined method 'zero?' for nil");
        if (days === 0) {
          await RefundPolicies.updateBang(
            policy,
            { max_refund_period_in_days: ENFORCED_MIN_REFUND_PERIOD_IN_DAYS, fine_print: null },
            options,
          );
        }
      }

      await Comments.createBang(
        {
          commentable_id: purchase.seller_id as bigint,
          commentable_type: "User",
          author_name: COMMENT_AUTHOR,
          comment_type: COMMENT_TYPES.ON_PROBATION,
          content:
            `Refund policy enforcement applied: dispute rate ${formatOneDecimal(rate)}% ` +
            `(${disputingBuyers} disputing buyers / ${settledBuyers} unique buyers) exceeded ` +
            `${MAX_DISPUTE_COUNT_RATE.toFixed(1)}% by count. Seller-level refund policy ` +
            `is now at least a ${ENFORCED_MIN_REFUND_PERIOD_IN_DAYS}-day money-back guarantee and ` +
            `"No refunds allowed" is unavailable until an admin clears the enforcement.`,
        },
        options,
      );
    });

    // After the transaction block, so the mail cannot go out if the writes roll back.
    await deliverLater(
      runtime,
      { mailer: MAILER, method: MAILER_METHOD, args: [Number(purchase.seller_id)] },
      mailRoute(MAILER, MAILER_METHOD),
    );
  },
);

export const enforceRefundPolicyForSellerJob = enforceRefundPolicyForSellerJobWith();
