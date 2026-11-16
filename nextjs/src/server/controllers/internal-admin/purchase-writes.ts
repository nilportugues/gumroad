// Api::Internal::Admin::PurchasesController's writes. Everything that moves money (#refund, #refund_for_fraud, #refund_taxes),
// sends mail (#resend_receipt, #resend_all_receipts), calls Stripe or PayPal, or runs Subscription#cancel!, Purchase#block_buyer! and
// Purchase::ReassignByEmailService stays with Rails (#reassign answers its three refusals before the service touches a row). What Node answers are the guards in front of
// them: the 400 and 404 refusals, the 422 states of a purchase that cannot be refunded, and the cancel_subscription states that need
// no cancelling. A request that clears them goes to Rails before anything is written.
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { isBlank as rubyBlank } from "../../models/compliance-countries.ts";
import { selectRows } from "../../models/sql.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { NotPortedError } from "../../models/user.ts";

import { failure, isBlank, jsonRendered, paramToS, recordAdminWrite, timeJson, type AdminRequest } from "./base.ts";
import {
  amountRefundableCents,
  fetchPurchase,
  purchaseTarget,
  SOURCE,
  strippedParam,
  truthy,
  type PurchaseRow,
} from "./purchases.ts";
import { defineAdminRoute } from "./registry.ts";

const WRAPPER = { key: "purchase", model: "Purchase" };
// String#casecmp folds ASCII letters only.
const asciiFold = (value: string) => value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
const NOT_FOUND_MESSAGE = "Purchase not found or email doesn't match";
const AMOUNT_MESSAGE = "amount_cents must be a positive integer";
const MS_PER_DAY = 86_400_000;
// Purchase#within_refund_policy_timeframe?: the states a refund window can still be open in.
const REFUNDABLE_STATES = ["successful", "gift_receiver_purchase_successful", "not_charged"];
// ActiveModel::Type::Boolean::FALSE_VALUES
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

type Refusal = ReturnType<typeof failure>;
type WithPurchase = { purchase: PurchaseRow } | { refusal: Refusal };

// ActiveModel::Type::Boolean.new.cast
export function castBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === false || value === 0) return false;
  if (typeof value === "string" && FALSE_VALUES.has(value)) return false;
  return true;
}

// fetch_purchase_with_email_match
async function findPurchaseForEmail(admin: AdminRequest): Promise<WithPurchase> {
  const buyerEmail = strippedParam(admin.params.email).toLowerCase();
  if (isBlank(buyerEmail)) return { refusal: failure("email is required", 400) };
  return matchBuyer(admin, buyerEmail);
}

async function matchBuyer(admin: AdminRequest, buyerEmail: string): Promise<WithPurchase> {
  const purchase = await fetchPurchase(admin.params.id);
  if (purchase === null || (purchase.email ?? "").toLowerCase() !== buyerEmail)
    return { refusal: failure(NOT_FOUND_MESSAGE, 404) };
  return { purchase };
}

const audited = (admin: AdminRequest, action: string, purchase: PurchaseRow, block: () => Promise<Refusal>) =>
  recordAdminWrite(admin, { action, target: purchaseTarget(purchase), wrapper: WRAPPER }, block);

const alreadyRefunded = (purchase: PurchaseRow): Refusal | null =>
  truthy(purchase.stripe_refunded) ? failure("Purchase has already been fully refunded", 422) : null;

async function noChargeToRefund(purchase: PurchaseRow): Promise<Refusal | null> {
  return isBlank(purchase.stripe_transaction_id) || (await amountRefundableCents(purchase)) <= 0
    ? failure("Purchase has no charge to refund", 422)
    : null;
}

// Purchase#within_refund_policy_timeframe? and the fine print check, as refusals; null when the refund may go ahead.
async function refundPolicyRefusal(purchase: PurchaseRow): Promise<Refusal | null> {
  const policy = await db.purchaseRefundPolicy.findFirst({
    where: { purchase_id: purchase.id },
    orderBy: { id: "asc" },
  });
  const maxDays = policy?.max_refund_period_in_days ?? null;
  const open =
    purchase.purchase_state !== null &&
    REFUNDABLE_STATES.includes(purchase.purchase_state) &&
    !truthy(purchase.stripe_refunded) &&
    purchase.chargeback_date === null &&
    policy !== null &&
    maxDays !== null &&
    maxDays > 0 &&
    purchase.created_at !== null &&
    purchase.created_at.getTime() > Date.now() - maxDays * MS_PER_DAY;
  if (!open)
    return failure(
      policy === null ? "Purchase has no recorded refund policy" : "Purchase is outside of the refund policy timeframe",
      422,
    );
  if (policy.fine_print !== null && !rubyBlank(policy.fine_print))
    return failure("This product has specific refund conditions that require seller review", 422);
  return null;
}

// `raw.is_a?(Integer) || raw.to_s.match?(/\A\d+\z/)`, then `to_i <= 0`.
export function amountRefusal(raw: unknown): Refusal | null {
  if (isBlank(raw)) return null;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw <= 0 ? failure(AMOUNT_MESSAGE, 422) : null;
  const text = paramToS(raw, SOURCE);
  return !/^\d+$/u.test(text) || BigInt(text) <= 0n ? failure(AMOUNT_MESSAGE, 422) : null;
}

defineAdminRoute(
  {
    method: "POST",
    pattern: "/internal/admin/purchases/resend_all_receipts",
    run: async (admin) => {
      const email = strippedParam(admin.params.email);
      if (isBlank(email)) return failure("email is required", 400);
      const [row] = await selectRows<{ count: bigint }>(
        Prisma.sql`SELECT COUNT(*) AS count FROM purchases WHERE email = ${email} AND purchase_state = 'successful'`,
      );
      if (Number(row?.count ?? 0) === 0) return failure(`No purchases found for email: ${email}`, 404);
      throw new NotPortedError("a grouped receipt mail (CustomerMailer.grouped_receipt)", SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/resend_receipt",
    run: async (admin) => {
      if ((await fetchPurchase(admin.params.id)) === null) return failure("Purchase not found", 404);
      throw new NotPortedError("a receipt mail (Purchase#resend_receipt)", SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/refund_taxes",
    run: async (admin) => {
      const found = await findPurchaseForEmail(admin);
      if ("refusal" in found) return found.refusal;
      throw new NotPortedError("a tax refund (Purchase#refund_gumroad_taxes!)", SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/refund",
    run: async (admin) => {
      const buyerEmail = strippedParam(admin.params.email).toLowerCase();
      if (isBlank(buyerEmail)) return failure("email is required", 400);
      if (isBlank(strippedParam(admin.params.reason))) return failure("reason is required", 400);
      const found = await matchBuyer(admin, buyerEmail);
      if ("refusal" in found) return found.refusal;
      const { purchase } = found;
      return audited(admin, "purchases.refund", purchase, async () => {
        const refusal = alreadyRefunded(purchase) ?? (await noChargeToRefund(purchase));
        if (refusal !== null) return refusal;
        if (castBoolean(admin.params.force) !== true) {
          const policyRefusal = await refundPolicyRefusal(purchase);
          if (policyRefusal !== null) return policyRefusal;
        }
        const amountProblem = amountRefusal(admin.params.amount_cents);
        if (amountProblem !== null) return amountProblem;
        throw new NotPortedError("a refund (Purchase#refund! calls the charge processor)", SOURCE);
      });
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/cancel_subscription",
    run: async (admin) => {
      const found = await findPurchaseForEmail(admin);
      if ("refusal" in found) return found.refusal;
      const { purchase } = found;
      return audited(admin, "purchases.cancel_subscription", purchase, async () => {
        const subscription =
          purchase.subscription_id === null
            ? null
            : await db.subscription.findUnique({ where: { id: purchase.subscription_id } });
        if (subscription === null) return failure("Purchase has no subscription", 422);
        if (subscription.cancelled_at !== null) {
          return jsonRendered({
            success: true,
            status: "already_cancelled",
            message: "Subscription is already cancelled",
            cancelled_at: timeJson(subscription.cancelled_at),
            cancelled_by_admin: SubscriptionFlags.isSet(subscription.flags, "cancelled_by_admin"),
          });
        }
        if (subscription.deactivated_at !== null) {
          // Subscription#termination_reason
          const reason =
            subscription.failed_at !== null
              ? "failed_payment"
              : subscription.ended_at !== null
                ? "fixed_subscription_period_ended"
                : "cancelled";
          return jsonRendered({
            success: true,
            status: "already_inactive",
            message: "Subscription is no longer active",
            termination_reason: reason,
            deactivated_at: timeJson(subscription.deactivated_at),
          });
        }
        throw new NotPortedError("a subscription cancellation (Subscription#cancel!)", SOURCE);
      });
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/block_buyer",
    run: async (admin) => {
      const found = await findPurchaseForEmail(admin);
      if ("refusal" in found) return found.refusal;
      throw new NotPortedError("a buyer block (Purchase#block_buyer!)", SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/unblock_buyer",
    run: async (admin) => {
      const found = await findPurchaseForEmail(admin);
      if ("refusal" in found) return found.refusal;
      throw new NotPortedError("a buyer unblock (block state across five tables and the Radar rule lookup)", SOURCE);
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/:id/refund_for_fraud",
    run: async (admin) => {
      const found = await findPurchaseForEmail(admin);
      if ("refusal" in found) return found.refusal;
      const { purchase } = found;
      return audited(admin, "purchases.refund_for_fraud", purchase, async () => {
        const refusal = alreadyRefunded(purchase) ?? (await noChargeToRefund(purchase));
        if (refusal !== null) return refusal;
        throw new NotPortedError("a refund for fraud (Purchase#refund_for_fraud_and_block_buyer!)", SOURCE);
      });
    },
  },
  {
    method: "POST",
    pattern: "/internal/admin/purchases/reassign",
    run: (admin) => {
      const from = strippedParam(admin.params.from);
      const to = strippedParam(admin.params.to);
      return recordAdminWrite(admin, { action: "purchases.reassign", target: null, wrapper: WRAPPER }, async () => {
        // Purchase::ReassignByEmailService#perform up to the first row it would change.
        if (from === "" || to === "") return failure("Both 'from' and 'to' email addresses are required", 400);
        if (asciiFold(from) === asciiFold(to)) return failure("from and to emails are the same", 422);
        const [match] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT id FROM purchases WHERE email = ${from} LIMIT 1`);
        if (match === undefined) return failure(`No purchases found for email: ${from}`, 404);
        throw new NotPortedError("a purchase reassignment (Purchase::ReassignByEmailService)", SOURCE);
      });
    },
  },
);
