// Purchase#update_balance_and_mark_successful! for a free purchase, and for a charged one through markPaidPurchaseSuccessful (app/models/purchase.rb, Purchase::MarkSuccessfulService): the
// succeeded_at save, then the `in_progress` to `successful` transition with the after_transition callbacks that apply to a
// plain free download, in the order the state machine declares them. The jobs they enqueue are the ones the Rails recording
// pushed (purchase-create.golden.json), in the same order against the statements.
//
// Callbacks whose condition is false for a free, one-time, non-gift, non-affiliate purchase of a plain product are left out
// (subscription and rental scheduling, affiliate notices, video transcoding, the Indian card mandate check): the purchase is
// refused by assertFreeCheckoutPurchase before it reaches here. A seller on the "waive Gumroad fee" day or a purchase that
// trips the free-download velocity block hands back, since both write rows this port does not.
import { Prisma, type UrlRedirect } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { defaultCheckoutEffects, type CheckoutEffects } from "./checkout-effects.ts";
import { afterCommitEverywhere, currentJobsRuntime, performAsync } from "./concerns/job-runtime.ts";
import { ago } from "./concerns/ruby-time.ts";
import { Purchases, type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import { incrementSellersBalanceBang, type SellerBalanceFacts } from "./purchase-seller-balance.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, selectRows, table } from "./sql.ts";
import { findUrlRedirectForPurchase, UrlRedirects } from "./url-redirect.ts";
import { NotPortedError } from "./user.ts";

// Purchase::BaseService / queue_product_cache_invalidation: InvalidateProductCacheWorker.perform_in(1.minute)
const PRODUCT_CACHE_INVALIDATION_DELAY_SECONDS = 60;
// update_product_search_index!: SendToElasticsearchWorker.perform_in(5.seconds)
const PRODUCT_SEARCH_INDEX_DELAY_SECONDS = 5;
const PRODUCT_SEARCH_INDEX_FIELDS = ["is_recommendable", "sales_volume", "total_fee_cents", "past_year_fee_cents"];
// send_notification_webhook: PostToPingEndpointsWorker.perform_in(10.seconds)
const SALE_PING_DELAY_SECONDS = 10;
// schedule_workflow_jobs: ScheduleWorkflowEmailsWorker.perform_in(5.seconds)
const WORKFLOW_EMAILS_DELAY_SECONDS = 5;
// notify_seller!: ContactingCreatorMailer.notify(id).deliver_later(queue: "critical", wait: 3.seconds)
const SELLER_NOTIFICATION_DELAY_SECONDS = 3;
// block_fraudulent_free_purchases!: the defaults of Redis keys nobody has set
const DEFAULT_FREE_PURCHASES_WATCH_HOURS = 4;
const DEFAULT_MAX_ALLOWED_FREE_PURCHASES_OF_SAME_PRODUCT = 2;
const FREE_PURCHASES_WATCH_HOURS_KEY = "free_purchases_watch_hours";
const MAX_ALLOWED_FREE_PURCHASES_KEY = "max_allowed_free_purchases_of_same_product";
const FRAUDULENT_FREE_PURCHASES_BLOCK_HOURS_KEY = "fraudulent_free_purchases_block_hours";
const GUMROAD_DAY_DATE_KEY = "gumroad_day_date";

const notPorted = (what: string) => new NotPortedError(`Purchase success with ${what}`, "app/models/purchase.rb");

type Options = { now?: () => Date };
const nowOf = (options: Options) => (options.now ?? (() => new Date()))();
const effectsOf = (context: PurchaseContext): CheckoutEffects => context.effects ?? defaultCheckoutEffects;
const contextOf = (record: PurchaseRecord) => record.ivars.context as PurchaseContext;
// Attributes typed to a datetime(0) column keep whole seconds
const wholeSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);
const toInt = (value: string | null, fallback: number) => (value == null ? fallback : Number.parseInt(value, 10) || 0);

// Purchase#set_succeeded_at: `update(succeeded_at: Time.current) unless succeeded_at.present?`
async function setSucceededAt(record: PurchaseRecord, options: Options): Promise<void> {
  if (record.get("succeeded_at") != null) return;
  await Purchases.update(record, { succeeded_at: wholeSeconds(nowOf(options)) }, options);
}

// Purchase#create_artifacts_and_send_receipt! for a product that is not a bundle, a commission or licensed
async function createArtifactsAndSendReceipt(record: PurchaseRecord, options: Options): Promise<UrlRedirect | null> {
  const context = contextOf(record);
  const existing = await findUrlRedirectForPurchase(record.get("id"));
  let redirect: UrlRedirect | null = existing;
  if (!existing) {
    redirect = (
      await UrlRedirects.createBang(
        {
          uses: 0,
          expires_at: null,
          purchase_id: record.get("id"),
          link_id: context.link.id,
          flags: 0,
          installment_id: null,
          subscription_id: null,
          preorder_id: null,
          imported_customer_id: null,
          rental_first_viewed_at: null,
        },
        options,
      )
    ).attributes as UrlRedirect;
  }
  // send_receipt enqueues nothing: an order with a charge sends one receipt for the whole charge (SendChargeReceiptJob)
  return redirect;
}

// User#has_workflows?: `workflows.alive.present?`
async function sellerHasWorkflows(record: PurchaseRecord): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`workflows`.*")} FROM ${table("workflows")} WHERE ${column("workflows", "seller_id")} = ${record.get("seller_id")} AND ${column("workflows", "deleted_at")} IS NULL`,
  );
  return rows.length > 0;
}

// Purchase::Blockable#block_fraudulent_free_purchases!
async function blockFraudulentFreePurchases(record: PurchaseRecord, options: Options): Promise<void> {
  if (record.get("total_transaction_cents") !== 0) return;
  const context = contextOf(record);
  const [watch, max] = await effectsOf(context).redisMget([
    FREE_PURCHASES_WATCH_HOURS_KEY,
    MAX_ALLOWED_FREE_PURCHASES_KEY,
    FRAUDULENT_FREE_PURCHASES_BLOCK_HOURS_KEY,
  ]);
  const watchHours = toInt(watch ?? null, DEFAULT_FREE_PURCHASES_WATCH_HOURS);
  const maxAllowed = toInt(max ?? null, DEFAULT_MAX_ALLOWED_FREE_PURCHASES_OF_SAME_PRODUCT);
  // link.sales.successful.not_recurring_charge.where(total_transaction_cents: 0).where(ip_address:).where(created_at: n.hours.ago..)
  //   .where("purchaser_id IS NULL OR purchaser_id != ?", link.user_id).count
  const since = wholeSeconds(ago({ hours: watchHours }, nowOf(options)));
  const rows = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} WHERE ${column("purchases", "link_id")} = ${context.link.id} AND ${column("purchases", "purchase_state")} = ${"successful"} AND (purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32') AND ${column("purchases", "total_transaction_cents")} = ${0} AND ${column("purchases", "ip_address")} = ${record.get("ip_address")} AND ${column("purchases", "created_at")} >= ${since} AND (purchaser_id IS NULL OR purchaser_id != ${String(context.link.user_id)})`,
  );
  if (Number(rows[0]!["COUNT(*)"]) > maxAllowed) throw notPorted("a repeated free download from one address");
}

// Order#schedule_review_reminder, reached as `purchase.order`: an order with a cart is not ported
async function scheduleOrderReviewReminder(record: PurchaseRecord): Promise<void> {
  const orders = await selectRows<{ id: bigint; review_reminder_scheduled_at: Date | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`orders`.*")} FROM ${table("orders")} INNER JOIN ${table("order_purchases")} ON ${column("orders", "id")} = ${column("order_purchases", "order_id")} WHERE ${column("order_purchases", "purchase_id")} = ${record.get("id")} LIMIT 1`,
  );
  const order = orders[0];
  if (!order) return;
  if (order.review_reminder_scheduled_at != null) return;
  const carts = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`carts`.*")} FROM ${table("carts")} WHERE ${column("carts", "order_id")} = ${order.id} LIMIT 1`,
  );
  if (carts.length > 0) throw notPorted("an order with a cart");
}

// seller.save_gumroad_day_timezone: nothing to do unless today is Gumroad Day or the seller is flagged for the waiver
async function saveGumroadDayTimezone(record: PurchaseRecord): Promise<void> {
  const context = contextOf(record);
  const effects = effectsOf(context);
  if ((await effects.redisGet(GUMROAD_DAY_DATE_KEY)) != null) throw notPorted("a Gumroad Day date in Redis");
  if (await effects.featureActive("waive_gumroad_fee_on_new_sales", `User;${context.seller.id}`))
    throw notPorted("the waived Gumroad fee");
}

export type MarkSuccessfulResult = { urlRedirect: UrlRedirect | null };

// Purchase::MarkSuccessfulService#perform, then Order::ChargeService's `handle_recommended_purchase` (a recommended purchase
// is refused up front).
export async function markFreePurchaseSuccessful(
  record: PurchaseRecord,
  options: Options = {},
): Promise<MarkSuccessfulResult> {
  if (record.get("price_cents") !== 0) throw notPorted("a priced purchase");
  return markSuccessful(record, null, options);
}

// The same service for a purchase Stripe has charged and `save_charge_data` has filled in (purchase-paid-success.golden.json):
// `increment_sellers_balance!` runs between the succeeded_at save and the transition.
export async function markPaidPurchaseSuccessful(
  record: PurchaseRecord,
  facts: SellerBalanceFacts,
  options: Options = {},
): Promise<MarkSuccessfulResult> {
  paidGuards(record);
  return markSuccessful(record, facts, options);
}

// What would change the recorded shape, read from the row alone: an affiliate (notify_affiliate!, create_product_affiliate),
// a recommended purchase, a membership charge and a purchase whose receipt is not the charge's.
function paidGuards(record: PurchaseRecord): void {
  if ((record.get("price_cents") ?? 0) <= 0) throw notPorted("a free purchase through the paid path");
  if (record.get("affiliate_id") != null) throw notPorted("an affiliate");
  if (record.get("subscription_id") != null) throw notPorted("a subscription");
  if (PurchaseFlags.isSet(record.get("flags"), "was_product_recommended")) throw notPorted("a recommended purchase");
  if (!contextOf(record).chargeReceipt) throw notPorted("a purchase without a charge receipt");
}

// Everything markPaidPurchaseSuccessful could still refuse after its first write (a cart on the order, a Gumroad Day date, the
// waived fee, the high-volume fee), asked with reads only. Call it BEFORE the processor is reached: a refusal after the charge
// would leave a charged card with an in-progress purchase.
export async function assertPaidSuccessServable(record: PurchaseRecord): Promise<void> {
  paidGuards(record);
  const context = contextOf(record);
  await scheduleOrderReviewReminder(record);
  await saveGumroadDayTimezone(record);
  if (await effectsOf(context).featureActive("high_volume_seller_fee", `User;${context.seller.id}`))
    throw notPorted("a seller on the high-volume fee");
}

async function markSuccessful(
  record: PurchaseRecord,
  facts: SellerBalanceFacts | null,
  options: Options,
): Promise<MarkSuccessfulResult> {
  const context = contextOf(record);
  const effects = effectsOf(context);
  if (!context.chargeReceipt) throw notPorted("a purchase without a charge receipt");
  const result: MarkSuccessfulResult = { urlRedirect: null };

  await setSucceededAt(record, options);
  if (facts) await incrementSellersBalanceBang(record, facts, options);

  // mark_successful!: the transition runs in one transaction, so the after_commit callbacks wait for its end
  await transaction(async () => {
    // before_transition in_progress: any, do: :zip_code_from_geoip
    if (record.get("zip_code") == null) record.set("zip_code", (context.geoInfo?.postalCode ?? null) as never);
    record.set("purchase_state", "successful");
    await Purchases.saveBang(record, options);

    // after_transition callbacks, in declaration order
    result.urlRedirect = await createArtifactsAndSendReceipt(record, options);
    if (await sellerHasWorkflows(record)) {
      await afterCommitEverywhere(async () => {
        await performAsync("ScheduleWorkflowEmailsWorker", [record.get("id")] as never, {
          delaySeconds: WORKFLOW_EMAILS_DELAY_SECONDS,
        });
      });
    }
    // notify_seller!
    await afterCommitEverywhere(async () => {
      await deliverLater(
        currentJobsRuntime(),
        {
          mailer: "ContactingCreatorMailer",
          method: "notify",
          args: [Number(record.get("id"))],
          queue: "critical",
          waitSeconds: SELLER_NOTIFICATION_DELAY_SECONDS,
        },
        mailRoute("ContactingCreatorMailer", "notify"),
      );
    });
    // queue_product_cache_invalidation
    await performAsync("InvalidateProductCacheWorker", [record.get("link_id")] as never, {
      delaySeconds: PRODUCT_CACHE_INVALIDATION_DELAY_SECONDS,
    });
    // update_product_search_index!
    await performAsync(
      "SendToElasticsearchWorker",
      [record.get("link_id"), "update", PRODUCT_SEARCH_INDEX_FIELDS] as never,
      { delaySeconds: PRODUCT_SEARCH_INDEX_DELAY_SECONDS },
    );
    // delete_failed_purchases_count
    const base = `product_${String(record.get("link_id"))}`;
    await effects.clearProductFailureStreak([base, `${base}:emails`, `${base}:cards`, `${base}:recorded`]);
    // send_notification_webhook
    await afterCommitEverywhere(async () => {
      await performAsync("PostToPingEndpointsWorker", [record.get("id"), context.urlParameters ?? null] as never, {
        delaySeconds: SALE_PING_DELAY_SECONDS,
      });
    });
    await blockFraudulentFreePurchases(record, options);
    await scheduleOrderReviewReminder(record);
  });

  // fix_later_charge_presentment is a no-op for a plain purchase
  await saveGumroadDayTimezone(record);
  await afterCommitEverywhere(async () => {
    await performAsync("ActivateIntegrationsWorker", [record.get("id")] as never);
  });
  return result;
}
