// The write side of app/models/subscription.rb that EndSubscriptionWorker, UnsubscribeAndFailWorker and
// SetSubscriptionAsDeactivatedWorker use: updates of a stored subscription (callbacks, validations,
// PaperTrail), `with_lock`, `deactivate!`, `end_subscription!` and `unsubscribe_and_fail!`.
// Reads go through SubscriptionRecord (subscription.ts) over the same record, so an association loads once
// per instance and `reload` (what `with_lock` does) drops it, as in ActiveRecord.
//
// Refused with NotPortedError before any SQL: creating or destroying a subscription (`update_last_payment_option`,
// `enable_mor_fee`, the dependent rows), and, in the jobs, the paths that need Stripe or models that are not
// ported (see subscription-write-jobs.ts).
import { Prisma, type CreditCard, type Purchase, type Subscription, type User, type Workflow } from "@prisma/client";

import { HandBackToRuby } from "../jobs/hand-back.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { afterCommitEverywhere, currentJobsRuntime, performAsync } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { PurchaseRecord } from "./purchase-pricing.ts";
import { PURCHASES } from "./purchase.ts";
import { findById } from "./row-reads.ts";
import { defineModel, type Callback, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { SentEmailInfos, mailerKeyDigest } from "./sent-email-info.ts";
import { castRow, column, execute, findInBatches, quoteName, selectRows, table } from "./sql.ts";
import {
  latestSubscriptionEvent,
  SubscriptionEvents,
  SUBSCRIPTION_EVENT_TYPES,
  type SubscriptionEventType,
} from "./subscription-event.ts";
import { SubscriptionFlags, SubscriptionRecord, type SubscriptionDeps } from "./subscription.ts";
import { NotPortedError, UserFlags } from "./user.ts";
import { ArgumentError } from "./with-filtering.ts";
import { SEND_WORKFLOW_INSTALLMENT_WORKER, schedulableInstallments } from "./workflow-scheduling.ts";
import { assertWorkflowSupported, WorkflowRecord } from "./workflow.ts";

export type SubscriptionModel = ModelRecord<Subscription>;

// Subscription::ALLOWED_TIME_BEFORE_SENDING_REPEATED_CANCELLATION_EMAIL_TO_CREATOR
const REPEATED_CANCELLATION_EMAIL_DAYS = 7;
// ElasticsearchIndexerWorker.perform_in(2.seconds, ...) and PostToPingEndpointsWorker.perform_in(5.seconds, ...)
const PURCHASE_INDEX_DELAY_SECONDS = 2;
const PING_DELAY_SECONDS = 5;
const PURCHASE_FIND_EACH_BATCH_SIZE = 1000;
// Purchase::COUNTS_TOWARDS_INVENTORY_STATES
const COUNTS_TOWARDS_INVENTORY_STATES = [
  "preorder_authorization_successful",
  "in_progress",
  "successful",
  "not_charged",
];
// ResourceSubscription::CANCELLED_RESOURCE_NAME and SUBSCRIPTION_ENDED_RESOURCE_NAME
const CANCELLED_RESOURCE_NAME = "cancellation";
const SUBSCRIPTION_ENDED_RESOURCE_NAME = "subscription_ended";
const WORKFLOWS = "workflows";
const SENT_EMAIL_INFOS = "sent_email_infos";
const CUSTOMER_LOW_PRIORITY_MAILER = "CustomerLowPriorityMailer";
const CONTACTING_CREATOR_MAILER = "ContactingCreatorMailer";
const SUBSCRIPTION_CANCELLATION_EMAIL_JOB = "SubscriptionCancellationEmailJob";

class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

// ----- the record and its associations

const MEMO = "subscriptionMemo";
const DEPS = "subscriptionDeps";

// A stored subscription with the clock and Flipper it runs under.
export function loadSubscription(row: Subscription, deps: SubscriptionDeps): SubscriptionModel {
  const record = Subscriptions.load(row);
  record.ivars[DEPS] = deps;
  return record;
}

// The period logic of subscription.ts over this record's attributes and association cache.
export function subscriptionView(record: SubscriptionModel): SubscriptionRecord {
  const view = new SubscriptionRecord(record.attributes as Subscription, record.ivars[DEPS] as SubscriptionDeps);
  view.memo = (record.ivars[MEMO] ??= new Map()) as Map<string, Promise<unknown>>;
  return view;
}

const nowOf = (record: SubscriptionModel) => (record.ivars[DEPS] as SubscriptionDeps).now();
const flag = (record: SubscriptionModel, name: Parameters<typeof SubscriptionFlags.isSet>[1]) =>
  SubscriptionFlags.isSet(record.get("flags"), name);

// `payment_options`, loaded once
function paymentOptions(record: SubscriptionModel): Promise<unknown[]> {
  return subscriptionView(record).loaded("payment_options", () =>
    selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`payment_options`.*")} FROM ${table("payment_options")} WHERE ${column("payment_options", "subscription_id")} = ${record.get("id")}`,
    ),
  );
}

// `cancelled?`
export function isCancelled(record: SubscriptionModel): boolean {
  return !subscriptionView(record).alive(true) && record.get("cancelled_at") != null;
}

// ----- callbacks

const paperTrail = hasPaperTrail<Subscription>("Subscription", { itemType: "Subscription" });

const savedColumns = (record: SubscriptionModel) => Object.keys(record.savedChanges);

const validations: Callback<Subscription>[] = [
  {
    name: "belongs_to :seller (required)",
    async run(record) {
      if ((await subscriptionView(record).seller()) === null) record.errors.add("seller", "required");
    },
  },
  {
    name: "must_have_payment_option",
    async run(record) {
      if ((await paymentOptions(record)).length === 0)
        record.errors.add("base", "Subscription must have at least one PaymentOption");
    },
  },
  {
    name: "installment_plans_cannot_be_cancelled_by_buyer",
    run(record) {
      if (!flag(record, "is_installment_plan")) return;
      if (!record.attributeChanged("cancelled_at", { from: null })) return;
      if (flag(record, "cancelled_by_admin")) return;
      if (flag(record, "cancelled_by_buyer"))
        record.errors.add("base", "Installment plans cannot be cancelled by the customer");
    },
  },
];

// `create_interruption_event`
async function createInterruptionEvent(record: SubscriptionModel, ctx: CallbackContext): Promise<void> {
  const eventType: SubscriptionEventType = record.get("deactivated_at") != null ? "deactivated" : "restarted";
  const latest = await latestSubscriptionEvent(record.get("id"));
  if (latest !== null && latest.event_type === SUBSCRIPTION_EVENT_TYPES[eventType]) return;

  const now = ctx.now ?? (() => new Date());
  const event = SubscriptionEvents.build({
    subscription_id: record.get("id"),
    event_type: SUBSCRIPTION_EVENT_TYPES[eventType],
    occurred_at: record.get("deactivated_at") ?? now(),
  });
  event.ivars.subscription = record;
  await SubscriptionEvents.saveBang(event, { now });
}

// `sync_inventory_counter_caches_for_purchases`. Purchase.inventory_pending_create_commit_ids is the
// set of purchases created in the open transaction; Node creates none, so the clause is always empty.
async function syncInventoryCounterCaches(record: SubscriptionModel): Promise<void> {
  const [previous, current] = record.savedChanges.deactivated_at ?? [null, null];
  const sign = previous == null && current != null ? -1 : previous != null && current == null ? 1 : 0;
  if (sign === 0) return;

  const bit = (name: Parameters<typeof PurchaseFlags.bit>[0]) => PurchaseFlags.bit(name);
  const states = COUNTS_TOWARDS_INVENTORY_STATES.map((state) => `'${state}'`).join(",");
  const conditions = [
    `p.subscription_id = ${record.get("id")}`,
    `p.purchase_state IN (${states})`,
    `(p.flags IS NULL OR p.flags & ${bit("is_additional_contribution")} = 0)`,
    `(p.flags & ${bit("is_archived_original_subscription_purchase")} = 0)`,
    `(p.flags & ${bit("is_original_subscription_purchase")} != 0 OR p.flags & ${bit("is_gift_receiver_purchase")} != 0)`,
  ].join(" AND ");

  await execute(
    Prisma.raw(
      `UPDATE base_variants bv INNER JOIN ( SELECT bvp.base_variant_id AS id, SUM(p.quantity) AS total FROM base_variants_purchases bvp INNER JOIN purchases p ON p.id = bvp.purchase_id WHERE ${conditions} GROUP BY bvp.base_variant_id ) t ON t.id = bv.id SET bv.sales_count_for_inventory_cache = bv.sales_count_for_inventory_cache + (${sign} * t.total)`,
    ),
  );
  await execute(
    Prisma.raw(
      `UPDATE links l INNER JOIN ( SELECT p.link_id AS id, SUM(p.quantity) AS total FROM purchases p WHERE ${conditions} GROUP BY p.link_id ) t ON t.id = l.id SET l.sales_count_for_inventory_cache = l.sales_count_for_inventory_cache + (${sign} * t.total)`,
    ),
  );
}

// PostToPingEndpointsWorker.perform_in(5.seconds, nil, nil, resource_name, id)
function sendNotificationWebhook(record: SubscriptionModel, resourceName: string): Promise<string | null> {
  return performAsync("PostToPingEndpointsWorker", [null, null, resourceName, record.get("id")], {
    delaySeconds: PING_DELAY_SECONDS,
  });
}

// Purchase#schedule_audience_member_refresh, evaluated for `purchase.email` now and run after commit.
// RefreshAudienceMemberJob.enqueue swallows a Redis outage.
function scheduleAudienceMemberRefresh(purchase: Purchase): Promise<void> {
  const email = purchase.email;
  return afterCommitEverywhere(async () => {
    try {
      await performAsync("RefreshAudienceMemberJob", [email, purchase.seller_id]);
    } catch (error) {
      if (!isRedisTransportError(error)) throw error;
    }
  });
}

// REDIS_TRANSPORT_ERRORS: connection failures, as ioredis reports them.
function isRedisTransportError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";
  return (
    name === "MaxRetriesPerRequestError" ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "NR_CLOSED"].includes(code)
  );
}

// TransactionalAttributeChangeTracker
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";
const COMMITTED = "attributesCommitted";

const afterCommit: Callback<Subscription>[] = [
  {
    // Purchase::Searchable::SubscriptionCallbacks#update_purchase_index
    name: "update_purchase_index",
    on: "update",
    async run(record) {
      const tracked = ["cancelled_at", "deactivated_at"];
      const committed = (record.ivars[COMMITTED] as string[] | undefined) ?? [];
      const changed = committed.filter((name) => tracked.includes(name));
      if (changed.length > 0) {
        const fields = changed.map((name) => `subscription_${name}`);
        await findInBatches<{ id: bigint }>(
          PURCHASES,
          Prisma.sql`${column(PURCHASES, "subscription_id")} = ${record.get("id")}`,
          PURCHASE_FIND_EACH_BATCH_SIZE,
          async (rows) => {
            for (const purchase of rows) {
              await performAsync(
                "ElasticsearchIndexerWorker",
                ["update", { record_id: purchase.id, class_name: "Purchase", fields }],
                { delaySeconds: PURCHASE_INDEX_DELAY_SECONDS },
              );
            }
          },
          column(PURCHASES, "id"),
        );
      }
      // Reassigning the subscription changes what Subscription#email resolves to.
      if (committed.includes("user_id")) {
        const original = await subscriptionView(record).originalPurchase();
        if (original !== null) {
          await performAsync(
            "ElasticsearchIndexerWorker",
            [
              "update",
              {
                record_id: original.id,
                class_name: "Purchase",
                fields: ["subscription_current_email", "subscription_current_email_domain"],
              },
            ],
            { delaySeconds: PURCHASE_INDEX_DELAY_SECONDS },
          );
        }
      }
    },
  },
  {
    name: "send_ended_notification_webhook",
    if: (record) => {
      const change = record.savedChanges.deactivated_at;
      return record.get("deactivated_at") != null && change !== undefined && change[0] == null;
    },
    run: async (record) => {
      await sendNotificationWebhook(record, SUBSCRIPTION_ENDED_RESOURCE_NAME);
    },
  },
  {
    name: "update_original_purchase_audience_member_details",
    if: (record) => record.savedChanges.cancelled_at !== undefined,
    async run(record) {
      const original = await subscriptionView(record).originalPurchase();
      if (original !== null) await scheduleAudienceMemberRefresh(original);
    },
  },
  {
    // before_commit of TransactionalAttributeChangeTracker. after_commit callbacks run in reverse
    // definition order, so the last one defined runs first.
    name: "TransactionalAttributeChangeTracker before_commit",
    run: (record) => {
      const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
      if (changed === undefined) return;
      record.ivars[COMMITTED] = [...changed];
      changed.clear();
    },
  },
];

export const Subscriptions = defineModel<Subscription>({
  rubyClass: "Subscription",
  prismaModel: "Subscription",
  delegate: (tx) => tx.subscription as never,
  beforeValidation: [
    {
      name: "(guard) create",
      on: "create",
      run: () => {
        throw new NotPortedError(
          "Subscription#create",
          "subscription.rb:82-91 (enable_mor_fee, update_last_payment_option)",
        );
      },
    },
  ],
  validations,
  beforeSave: [
    {
      name: "end_indian_card_mandate_hold",
      unless: (record) => subscriptionView(record).indianCardMandateHeld(),
      run: (record) =>
        record.set("flags", SubscriptionFlags.set(record.get("flags"), "indian_card_mandate_hold_pending", false)),
    },
  ],
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    {
      name: "TransactionalAttributeChangeTracker after_save",
      run: (record) => {
        record.ivars[COMMITTED] = null;
        const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
        for (const name of savedColumns(record)) changed.add(name);
      },
    },
    {
      name: "create_interruption_event",
      if: (record) => record.savedChanges.deactivated_at !== undefined,
      run: createInterruptionEvent,
    },
    {
      name: "sync_inventory_counter_caches_for_purchases",
      if: (record) => record.savedChanges.deactivated_at !== undefined,
      run: syncInventoryCounterCaches,
    },
  ],
  beforeDestroy: [
    {
      name: "(guard) destroy",
      run: () => {
        throw new NotPortedError("Subscription#destroy", "subscription.rb");
      },
    },
  ],
  afterCommit,
});

// ----- locking

// `with_lock`: a transaction around `lock!`, which reloads the row and the association cache.
export function withLock<T>(record: SubscriptionModel, fn: () => Promise<T>): Promise<T> {
  return Subscriptions.withLock(record, async () => {
    record.ivars[MEMO] = undefined;
    return fn();
  });
}

// ----- deactivation

export type DeactivateOptions = {
  // The workflows `schedule_member_cancellation_workflow_jobs` reads, fetched before the first write
  // (see readWorkflowsForCancellation), or a reader called where Ruby reads them (a caller whose transaction rolls back).
  workflows?: Workflow[] | (() => Promise<Workflow[]>);
};

// `seller.workflows.alive.seller_or_product_or_variant_type`, the read of `schedule_member_cancellation_workflow_jobs`.
// Node issues it before the job's first write, where Rails issues it last, so a seller with a
// member-cancellation workflow whose filters Node cannot judge (with-filtering.ts) can be handed back
// to Rails while nothing has been written. A column that is not a Hash raises in Ruby after the
// commit, so it is handed back too.
export async function readWorkflowsForCancellation(record: SubscriptionModel): Promise<Workflow[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(WORKFLOWS)}.*`)} FROM ${table(WORKFLOWS)} WHERE ${column(WORKFLOWS, "seller_id")} = ${record.get("seller_id")} AND ${column(WORKFLOWS, "deleted_at")} IS NULL AND ${column(WORKFLOWS, "workflow_type")} IN ('seller', 'product', 'variant')`,
  );
  const workflows = rows.map((row) => castRow<Workflow>("Workflow", row));
  for (const workflow of workflows) {
    try {
      if (new WorkflowRecord(workflow).memberCancellationTrigger) assertWorkflowSupported(workflow);
    } catch (error) {
      if (error instanceof ArgumentError)
        throw new NotPortedError("a workflow whose json_data is not a Hash", "json_data.rb");
      throw error;
    }
  }
  return workflows;
}

// `schedule_member_cancellation_workflow_jobs` after `return if alive? || !cancelled?`: one
// SendWorkflowInstallmentWorker at `deactivated_at + delay` per installment of each member
// cancellation workflow that applies to the original purchase.
async function scheduleMemberCancellationWorkflowJobs(
  record: SubscriptionModel,
  original: Purchase | null,
  workflows: Workflow[],
): Promise<void> {
  const purchase = original === null ? null : new PurchaseRecord(original, subscriptionView(record));
  const deactivatedAt = record.get("deactivated_at") as Date;
  for (const row of workflows) {
    const workflow = new WorkflowRecord(row);
    if (!workflow.memberCancellationTrigger) continue;
    if (purchase === null)
      throw new NoMethodError(
        workflow.productType ? "undefined method 'link_id' for nil" : "undefined method 'slice' for nil",
      );
    if (!(await workflow.appliesToPurchase(purchase))) continue;

    for (const { installment, rule } of await schedulableInstallments(workflow, { published: false })) {
      if (rule.delayed_delivery_time === null) throw new TypeError("can't convert nil into an exact number");
      const at = new Date(deactivatedAt.getTime() + rule.delayed_delivery_time * 1000);
      await performAsync(
        SEND_WORKFLOW_INSTALLMENT_WORKER,
        [installment.id, rule.version, null, null, null, Number(record.get("id"))],
        { at },
      );
    }
  }
}

// `deactivate!`
export async function deactivateBang(record: SubscriptionModel, options: DeactivateOptions = {}): Promise<void> {
  const now = () => nowOf(record);
  record.set("deactivated_at", now());
  await Subscriptions.saveBang(record, { now });

  const original = await subscriptionView(record).originalPurchase();
  if (original !== null) await scheduleAudienceMemberRefresh(original);
  await afterCommitEverywhere(async () => {
    if (original === null) throw new NoMethodError("undefined method 'id' for nil");
    await performAsync("DeactivateIntegrationsWorker", [original.id]);
  });

  if (isCancelled(record)) {
    if (options.workflows === undefined)
      throw new NotPortedError("Subscription#schedule_member_cancellation_workflow_jobs", "subscription.rb:2028");
    const workflows = typeof options.workflows === "function" ? await options.workflows() : options.workflows;
    await scheduleMemberCancellationWorkflowJobs(record, original, workflows);
  }
}

// ----- mail

async function deliverMail(record: SubscriptionModel, mailer: string, method: string, queue: string): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    { mailer, method, args: [Number(record.get("id"))], queue },
    mailRoute(mailer, method),
  );
}

async function enablePaymentEmail(record: SubscriptionModel): Promise<boolean> {
  const seller = await subscriptionView(record).seller();
  if (seller === null) throw new NoMethodError("undefined method 'enable_payment_email?' for nil");
  return UserFlags.isSet(seller.flags, "enable_payment_email");
}

// A subscription cancelled while the job waited for the lock would also schedule member
// cancellation workflows after deactivating, which Node has not read; Rails runs the job from scratch.
function handBackIfCancelled(record: SubscriptionModel): void {
  if (record.get("cancelled_at") != null)
    throw new HandBackToRuby("the subscription was cancelled while waiting for its lock");
}

// `cancel!(by_seller:, by_admin:)`: the member keeps access until `end_time_of_subscription`; `cancelled_at` is that date. Cancelling
// twice is a no-op. A member cancellation workflow is scheduled later, by the deactivation job (SetSubscriptionAsDeactivatedWorker).
export async function cancelBang(
  record: SubscriptionModel,
  { bySeller = true, byAdmin = false }: { bySeller?: boolean; byAdmin?: boolean } = {},
): Promise<void> {
  await withLock(record, async () => {
    if (record.get("cancelled_at") != null) return;

    const now = () => nowOf(record);
    record.set("user_requested_cancellation_at", now());
    record.set("cancelled_at", await subscriptionView(record).endTimeOfSubscription());
    let flags = SubscriptionFlags.set(record.get("flags"), "cancelled_by_buyer", !bySeller);
    flags = SubscriptionFlags.set(flags, "cancelled_by_admin", byAdmin);
    record.set("flags", flags);
    await Subscriptions.saveBang(record, { now });

    if (flag(record, "cancelled_by_buyer")) {
      await deliverMail(record, CUSTOMER_LOW_PRIORITY_MAILER, "subscription_cancelled", "low");
      if (await enablePaymentEmail(record))
        await deliverMail(record, CONTACTING_CREATOR_MAILER, "subscription_cancelled_by_customer", "critical");
    } else {
      await deliverMail(record, CUSTOMER_LOW_PRIORITY_MAILER, "subscription_cancelled_by_seller", "low");
      if (await enablePaymentEmail(record))
        await deliverMail(record, CONTACTING_CREATOR_MAILER, "subscription_cancelled", "critical");
    }

    await sendNotificationWebhook(record, CANCELLED_RESOURCE_NAME);
  });
}

// `end_subscription!`
export async function endSubscriptionBang(record: SubscriptionModel): Promise<void> {
  await withLock(record, async () => {
    if (record.get("ended_at") != null) return;
    handBackIfCancelled(record);

    record.set("ended_at", nowOf(record));
    await deactivateBang(record);

    await deliverMail(record, CUSTOMER_LOW_PRIORITY_MAILER, "subscription_ended", "low");
    if (await enablePaymentEmail(record))
      await deliverMail(record, CONTACTING_CREATOR_MAILER, "subscription_ended", "critical");
  });
}

// ----- unsubscribe_and_fail!

// `credit_card_to_charge`: the subscription's own card, else the buyer's.
async function creditCardToCharge(record: SubscriptionModel): Promise<CreditCard | null> {
  if (flag(record, "is_test_subscription")) return null;
  const view = subscriptionView(record);
  const own = await view.loaded("credit_card", () => findById<CreditCard>("CreditCard", record.get("credit_card_id")));
  if (own !== null) return own;
  const user = await view.user();
  if (user === null) return null;
  return findById<CreditCard>("CreditCard", (user as User & { credit_card_id?: bigint | null }).credit_card_id ?? null);
}

// The part of `unsubscribe_and_fail!` before `with_lock`: for a subscription on a mandate-reliable
// merchant account, a failed charge on the current card that carries an Indian card mandate error
// is recovered through Stripe (refresh_indian_card_mandate!), which Node does not do. Only reads;
// throws NotPortedError when a failed charge could be such a failure.
export async function checkMandateRecovery(record: SubscriptionModel): Promise<void> {
  const view = subscriptionView(record);
  if (
    !((await view.indiaCardMandateReliabilityEnabled()) && !flag(record, "renewal_disabled_due_to_indian_card_mandate"))
  )
    return;

  const cardId = (await creditCardToCharge(record))?.id ?? null;
  const currentPeriodStartedAt = (await view.endTimeOfLastPaidPeriod()) ?? record.get("created_at");
  if (cardId === null) return;
  const [failure] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PURCHASES)}.*`)} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "subscription_id")} = ${record.get("id")} AND ${column(PURCHASES, "purchase_state")} = 'failed' AND ${column(PURCHASES, "credit_card_id")} = ${cardId} AND (created_at >= ${currentPeriodStartedAt}) ORDER BY ${column(PURCHASES, "created_at")} DESC, ${column(PURCHASES, "id")} DESC LIMIT 1`,
  );
  if (failure !== undefined)
    throw new NotPortedError(
      "Purchase#indian_card_mandate_error_status and Subscription#refresh_indian_card_mandate!",
      "subscription.rb:1124-1140",
    );
}

// The creator's "subscription_autocancelled" notice, at most once a week per subscription. The
// identity of an expired notice is kept (re-keyed) for delayed deliveries and SMTP retries.
async function notifyCreatorOfAutocancellation(record: SubscriptionModel): Promise<void> {
  const id = Number(record.get("id"));
  const key = mailerKeyDigest(CONTACTING_CREATOR_MAILER, "subscription_autocancelled", id);
  const where = Prisma.sql`${column(SENT_EMAIL_INFOS, "key")} = ${key}`;
  const cutoff = new Date(nowOf(record).getTime() - REPEATED_CANCELLATION_EMAIL_DAYS * 86_400_000);
  const [recent] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(SENT_EMAIL_INFOS)} WHERE ${where} AND (created_at > ${cutoff}) LIMIT 1`,
  );
  if (recent !== undefined) return;

  const now = () => nowOf(record);
  const [previous] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(SENT_EMAIL_INFOS)}.*`)} FROM ${table(SENT_EMAIL_INFOS)} WHERE ${where} ORDER BY ${column(SENT_EMAIL_INFOS, "id")} ASC LIMIT 1`,
  );
  if (previous !== undefined) {
    const stale = SentEmailInfos.load(castRow("SentEmailInfo", previous));
    await SentEmailInfos.updateBang(
      stale,
      { key: mailerKeyDigest(CONTACTING_CREATOR_MAILER, "subscription_autocancelled", id, previous.id) },
      { now },
    );
  }
  const notice = await SentEmailInfos.createBang({ key }, { now });

  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: CONTACTING_CREATOR_MAILER,
      method: "subscription_autocancelled",
      args: [id],
      queue: "critical",
      jobClass: SUBSCRIPTION_CANCELLATION_EMAIL_JOB,
      extraKeywords: { sent_email_info_id: Number(notice.get("id")) },
    },
    mailRoute(CONTACTING_CREATOR_MAILER, "subscription_autocancelled"),
  );
}

// `unsubscribe_and_fail!` after the mandate recovery check (checkMandateRecovery).
export async function unsubscribeAndFailBang(record: SubscriptionModel): Promise<void> {
  await withLock(record, async () => {
    if (record.get("failed_at") != null) return;
    const view = subscriptionView(record);
    if (await view.indiaCardMandateReliabilityEnabled()) {
      if (flag(record, "renewal_disabled_due_to_indian_card_mandate")) return;
    }
    handBackIfCancelled(record);

    record.set("failed_at", nowOf(record));
    await deactivateBang(record);

    await deliverMail(record, CUSTOMER_LOW_PRIORITY_MAILER, "subscription_autocancelled", "low");
    if (await enablePaymentEmail(record)) await notifyCreatorOfAutocancellation(record);
    await sendNotificationWebhook(record, CANCELLED_RESOURCE_NAME);
  });
}
