// What refund_purchase! (app/modules/purchase/refundable.rb) does after the VAT credit, inside its transaction and after it:
// the seller's webhook, the buyer's mail, the analytics cache, the Elasticsearch document, the related-products job, the fraud
// check, and the licence. Golden: __fixtures__/refund-purchase-tail.golden.json (scripts/golden/refund-purchase-body.rb, `full`).
import { Prisma, type License } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { currentJobsRuntime, performAsync } from "./concerns/job-runtime.ts";
import { instantInTimeZoneIso8601 } from "./concerns/rails-time-zone.ts";
import { Licenses, disabled } from "./license.ts";
import { type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import { PURCHASE_URL_PARAMETERS } from "./purchase-url-parameter.ts";
import { heldGiftGiven } from "./refund-held-associations.ts";
import { refundPurchaseBodyBang, type RefundBodyArguments } from "./refund-purchase-body.ts";
import { externalId, refundJsonAttr, type RefundRecord } from "./refund.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { isFlagSet, NotPortedError, Users } from "./user.ts";

// ResourceSubscription::REFUNDED_RESOURCE_NAME
const REFUNDED_RESOURCE_NAME = "refund";
const REFUND_WEBHOOK_DELAY_SECONDS = 5;
const CREATOR_ANALYTICS_DELAY_SECONDS = 2;
const SEARCH_INDEX_DELAY_SECONDS = 2;
const LOW_BALANCE_FRAUD_CHECK_DELAY_SECONDS = 5;

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#refund_purchase! with ${what}`, "app/modules/purchase/refundable.rb:288");

export type RefundTailOptions = {
  fundsRefundedCents: number;
  partiallyRefundedPreviously: boolean | null;
  now?: () => Date;
};

const flag = (purchase: PurchaseRecord, name: (typeof PurchaseFlags.names)[number]) =>
  PurchaseFlags.isSet(purchase.get("flags"), name);

// send_refunded_notification_webhook
export async function sendRefundedNotificationWebhook(purchase: PurchaseRecord): Promise<void> {
  if (flag(purchase, "is_gift_sender_purchase")) return;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchase_url_parameters`.*")} FROM ${table(PURCHASE_URL_PARAMETERS)} WHERE ${column(PURCHASE_URL_PARAMETERS, "purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  // the row's `params` reach the ping as `url_params`; no golden holds one yet
  if (row !== undefined) throw notPorted("a sale with URL parameters");
  await performAsync("PostToPingEndpointsWorker", [purchase.get("id"), null, REFUNDED_RESOURCE_NAME] as never, {
    delaySeconds: REFUND_WEBHOOK_DELAY_SECONDS,
  });
}

// `CustomerMailer.partial_refund(...)` or `.refund(...)`.deliver_later(queue: "critical"). The partial mail carries the refund's
// buyer-currency amount as plain values: the job can run before the Refund row is visible.
export async function enqueueRefundMail(
  purchase: PurchaseRecord,
  refund: RefundRecord,
  options: RefundTailOptions,
): Promise<void> {
  const partiallyRefunded = purchase.get("stripe_partially_refunded") === true;
  const common = [purchase.get("email") as string, Number(purchase.get("link_id")), Number(purchase.get("id"))];
  const partial = options.partiallyRefundedPreviously === true || partiallyRefunded;
  // formatted_refund_state
  const state = partiallyRefunded ? "partially" : purchase.get("stripe_refunded") === true ? "fully" : "";
  const method = partial ? "partial_refund" : "refund";
  const amount = refundJsonAttr(refund, "presentment_amount_cents");
  const currency = refundJsonAttr(refund, "presentment_currency");
  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: "CustomerMailer",
      method,
      args: partial
        ? [
            ...common,
            options.fundsRefundedCents,
            state,
            (amount ?? null) as number | null,
            (currency ?? null) as string | null,
          ]
        : common,
      queue: "critical",
    },
    mailRoute("CustomerMailer", method),
  );
}

const localDate = (timezone: string, instant: Date) => instantInTimeZoneIso8601(timezone, instant).slice(0, 10);

// update_creator_analytics_cache(force: true): the cache does not cover the seller's today
export async function updateCreatorAnalyticsCache(purchase: PurchaseRecord, now: () => Date): Promise<void> {
  const seller = (purchase.ivars.context as PurchaseContext).seller;
  const purchaseDate = localDate(seller.timezone, purchase.get("created_at") as Date);
  if (purchaseDate === localDate(seller.timezone, now())) return;
  await performAsync("RegenerateCreatorAnalyticsCacheWorker", [Number(purchase.get("seller_id")), purchaseDate], {
    delaySeconds: CREATOR_ANALYTICS_DELAY_SECONDS,
  });
}

// What the transaction does after the VAT credit, in Ruby's order
export async function refundPurchaseTail(
  purchase: PurchaseRecord,
  refund: RefundRecord,
  options: RefundTailOptions,
): Promise<true> {
  const now = options.now ?? (() => new Date());
  await sendRefundedNotificationWebhook(purchase);
  await enqueueRefundMail(purchase, refund, options);
  await updateCreatorAnalyticsCache(purchase, now);
  // send_to_elasticsearch("index"): the whole document, as a refund changes most of its fields
  await performAsync(
    "ElasticsearchIndexerWorker",
    ["index", { record_id: purchase.get("id"), class_name: "Purchase" }],
    {
      delaySeconds: SEARCH_INDEX_DELAY_SECONDS,
    },
  );
  // enqueue_update_sales_related_products_infos_job(false)
  await performAsync("UpdateSalesRelatedProductsInfosJob", [purchase.get("id"), false] as never);

  // `refund.user&.is_team_member?`
  const refundingUserId = refund.get("refunding_user_id");
  const refunder =
    refundingUserId == null
      ? null
      : (
          await selectRows(
            Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${refundingUserId} LIMIT 1`,
          )
        )[0];
  // no golden has a refund issued by a team member
  if (refunder != null && isFlagSet(Users.load(castRow("User", refunder)), "is_team_member"))
    throw notPorted("a refund issued by a team member");
  await performAsync("LowBalanceFraudCheckWorker", [purchase.get("id")] as never, {
    delaySeconds: LOW_BALANCE_FRAUD_CHECK_DELAY_SECONDS,
  });
  return true;
}

const licenseOf = async (purchaseId: unknown) => {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`licenses`.*")} FROM ${table("licenses")} WHERE ${column("licenses", "purchase_id")} = ${purchaseId} LIMIT 1`,
  );
  return row === undefined ? null : Licenses.load(castRow<License>("License", row));
};

// What disableAttachedLicenseIfFullyRefundedBang cannot do yet. It runs after the processor has refunded, so a caller checks this
// before it makes the refund.
export function licenseDisableRefusal(purchase: PurchaseRecord, forFraud: boolean): string | null {
  if (flag(purchase, "is_bundle_purchase")) return "a bundle's licences";
  if (forFraud && isRecurringSubscriptionCharge(purchase)) return "a subscription charge's licence";
  return null;
}

// `subscription.present? && !is_original_subscription_purchase && !is_gift_receiver_purchase`
const isRecurringSubscriptionCharge = (purchase: PurchaseRecord) =>
  purchase.get("subscription_id") != null &&
  !flag(purchase, "is_original_subscription_purchase") &&
  !flag(purchase, "is_gift_receiver_purchase");

// disable_attached_license_if_fully_refunded!, after the transaction commits: a failure is reported and swallowed, so that a
// failed licence write cannot undo a refund the processor already made
export async function disableAttachedLicenseIfFullyRefundedBang(
  purchase: PurchaseRecord,
  options: { forFraud?: boolean; now?: () => Date } = {},
): Promise<void> {
  const refusal = licenseDisableRefusal(purchase, options.forFraud === true);
  if (refusal !== null) throw notPorted(refusal);
  try {
    if (purchase.get("stripe_refunded") !== true || isRecurringSubscriptionCharge(purchase)) return;
    const targets = [await licenseOf(purchase.get("id"))];
    const giftee = flag(purchase, "is_gift_sender_purchase") ? heldGiftGiven(purchase)?.giftee : null;
    if (giftee != null) targets.push(await licenseOf(giftee.get("id")));
    const now = options.now ?? (() => new Date());
    for (const license of targets) {
      if (license === null || disabled(license)) continue;
      // License#disable!; the column keeps whole seconds
      license.set("disabled_at", new Date(Math.floor(now().getTime() / 1000) * 1000));
      // its numericality validation reads `uses` next, which PaperTrail's `object` lists ahead of the columns nothing touched
      license.touch("uses");
      await Licenses.saveBang(license, { now });
    }
  } catch (error) {
    notifyError("Failed to disable license after refund", {
      purchase_id: purchase.get("id"),
      purchase_external_id: externalId(purchase.get("id")),
      error_class: error instanceof Error ? error.constructor.name : "Error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Purchase#refund_purchase! to its end, given what the processor answered: the body, the tail, and after the commit the licence.
// Nothing here calls the processor.
export async function refundPurchaseBang(
  purchase: PurchaseRecord,
  args: RefundBodyArguments,
  options: SaveOptions = {},
): Promise<boolean> {
  const refusal = licenseDisableRefusal(purchase, args.isForFraud === true);
  if (refusal !== null) throw notPorted(refusal);
  const refunded = await refundPurchaseBodyBang(
    purchase,
    args,
    (refund, facts) => refundPurchaseTail(purchase, refund, { ...facts, now: options.now }),
    options,
  );
  if (refunded)
    await disableAttachedLicenseIfFullyRefundedBang(purchase, { forFraud: args.isForFraud === true, now: options.now });
  return refunded;
}
