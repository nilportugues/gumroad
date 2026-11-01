// Port of ScheduleWorkflowInstallmentJob#reschedule_pending_resubscribed_memberships (app/sidekiq/schedule_workflow_installment_job.rb):
// when a creator edits the delay of a workflow post, the memberships that restarted since the old delay was set are
// rescheduled under the new one. Golden: worker/jobs/__fixtures__/schedule-workflow-installment.golden.json (the "delay edit" cases).
//
// Workflows that exclude buyers of other products (`not_bought_*`) read through a probe batch Node does not port; they, and any
// filter `assertWorkflowSupported` refuses, are decided before the intent's fanout is claimed (`assertMembershipsReschedulable`).
import { Prisma, type BaseVariant, type InstallmentRule, type License, type Link, type Purchase, type Subscription, type SubscriptionEvent } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { InstallmentPost } from "./installment-post.ts";
import { VariantRecord } from "./offer-code.ts";
import { PurchaseRecord } from "./purchase-pricing.ts";
import { quote } from "./runtime/quoting.ts";
import { castRow, column, columnIn, selectRows, table } from "./sql.ts";
import { SubscriptionRecord, type SubscriptionDeps } from "./subscription.ts";
import { NotPortedError } from "./user.ts";
import { filterValue, SELLER_TYPE } from "./with-filtering.ts";
import { assertWorkflowSupported, type WorkflowRecord } from "./workflow.ts";

const SECOND_MS = 1000;
const BATCH_SIZE = 1000;
const RESTARTED_EVENT_TYPE = 1;
const DEACTIVATED_EVENT_TYPE = 0;
const RESCHEDULE_JOB = "SendWorkflowInstallmentRescheduleJob";

// `return if workflow.member_cancellation_trigger?; return unless seller_or_product_or_variant_type? || audience_type?`
export function reschedulesMemberships(workflow: WorkflowRecord): boolean {
  return !workflow.memberCancellationTrigger && (workflow.row.workflow_type === SELLER_TYPE || workflow.productType || workflow.variantType || workflow.audienceType);
}

// What Node cannot judge, asked before the intent's fanout is claimed so the job can still go back to Rails untouched.
export function assertMembershipsReschedulable(workflow: WorkflowRecord): void {
  assertWorkflowSupported(workflow.row);
  const json = { jsonData: () => workflow.jsonData() };
  if (filterValue(json, "not_bought_products") !== null || filterValue(json, "not_bought_variants") !== null) {
    throw new NotPortedError("a workflow that excludes buyers of other products (ResubscriptionExclusionProbe)", "schedule_workflow_installment_job.rb");
  }
}

// `latest_event_time(events, type)`: the newest by [occurred_at, id]
function latestEventTime(events: SubscriptionEvent[], eventType: number): Date | null {
  let latest: SubscriptionEvent | null = null;
  for (const event of events) {
    if (event.event_type !== eventType) continue;
    if (latest === null || event.occurred_at.getTime() > latest.occurred_at.getTime() || (event.occurred_at.getTime() === latest.occurred_at.getTime() && BigInt(event.id) > BigInt(latest.id))) latest = event;
  }
  return latest === null ? null : latest.occurred_at;
}

const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / SECOND_MS) * SECOND_MS);
const iso8601 = (time: Date) => time.toISOString().replace(".000Z", "Z");
const star = (name: string) => Prisma.raw(`\`${name}\`.*`);
const distinct = <T>(values: (T | null)[]): T[] => [...new Set(values.filter((value): value is T => value !== null))];

// `candidate_subscriptions(workflow, restarted_after:)` in batches of `find_in_batches`
async function candidateBatch(workflow: WorkflowRecord, restartedAfter: Date, afterId: bigint | null): Promise<Subscription[]> {
  const sellerId = workflow.row.seller_id;
  const events = `SELECT \`subscription_events\`.\`subscription_id\` FROM \`subscription_events\` WHERE (\`subscription_events\`.\`seller_id\` = ${quote(sellerId)} OR \`subscription_events\`.\`seller_id\` IS NULL) AND \`subscription_events\`.\`event_type\` = ${RESTARTED_EVENT_TYPE} AND (occurred_at > ${quote(restartedAfter)})`;
  const link = workflow.productType || workflow.variantType ? ` AND \`subscriptions\`.\`link_id\` = ${quote(workflow.row.link_id)}` : "";
  const after = afterId === null ? "" : ` AND \`subscriptions\`.\`id\` > ${afterId}`;
  const rows = await selectRows(
    Prisma.raw(`SELECT \`subscriptions\`.* FROM \`subscriptions\` WHERE \`subscriptions\`.\`id\` IN (${events}) AND \`subscriptions\`.\`seller_id\` = ${quote(sellerId)}${link}${after} ORDER BY \`subscriptions\`.\`id\` ASC LIMIT ${BATCH_SIZE}`),
  );
  return rows.map((row) => castRow<Subscription>("Subscription", row));
}

// The `preload(:subscription_events, original_purchase: [:link, :variant_attributes, :license, :subscription])` of one batch.
async function preloadBatch(subscriptions: Subscription[], deps: SubscriptionDeps) {
  const ids = subscriptions.map((subscription) => subscription.id);
  const events = (await selectRows(Prisma.sql`SELECT ${star("subscription_events")} FROM ${table("subscription_events")} WHERE ${columnIn("subscription_events", "subscription_id", ids)}`)).map((row) => castRow<SubscriptionEvent>("SubscriptionEvent", row));
  const purchaseRows = (
    await selectRows(
      Prisma.sql`SELECT ${star("purchases")} FROM ${table("purchases")} WHERE ((${column("purchases", "flags")} & 4 = 4)) AND ((${column("purchases", "flags")} & 131072 = 0)) AND ${columnIn("purchases", "subscription_id", ids)}`,
    )
  ).map((row) => castRow<Purchase>("Purchase", row));
  const links = new Map<number, Link>();
  const variants = new Map<string, VariantRecord[]>();
  const licenses = new Map<string, License>();
  if (purchaseRows.length > 0) {
    const purchaseIds = purchaseRows.map((purchase) => purchase.id);
    const linkIds = distinct(purchaseRows.map((purchase) => purchase.link_id));
    if (linkIds.length > 0) {
      for (const row of await selectRows(Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", linkIds)}`)) {
        const link = castRow<Link>("Link", row);
        links.set(Number(link.id), link);
      }
    }
    const joins = await selectRows<{ base_variant_id: number; purchase_id: bigint }>(
      Prisma.sql`SELECT ${star("base_variants_purchases")} FROM ${table("base_variants_purchases")} WHERE ${columnIn("base_variants_purchases", "purchase_id", purchaseIds)}`,
    );
    for (const row of await selectRows(Prisma.sql`SELECT ${star("licenses")} FROM ${table("licenses")} WHERE ${columnIn("licenses", "purchase_id", purchaseIds)}`)) {
      const license = castRow<License>("License", row);
      if (license.purchase_id !== null && !licenses.has(String(license.purchase_id))) licenses.set(String(license.purchase_id), license);
    }
    if (joins.length > 0) {
      const variantRows = new Map<number, BaseVariant>();
      for (const row of await selectRows(Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${columnIn("base_variants", "id", distinct(joins.map((join) => join.base_variant_id)))}`)) {
        const variant = castRow<BaseVariant>("BaseVariant", row);
        variantRows.set(Number(variant.id), variant);
      }
      for (const join of joins) {
        const variant = variantRows.get(Number(join.base_variant_id));
        if (variant !== undefined) variants.set(String(join.purchase_id), [...(variants.get(String(join.purchase_id)) ?? []), new VariantRecord(variant)]);
      }
    }
  }
  return { events, purchaseRows, links, variants, licenses };
}

// notEnqueued: the job's FanoutNotEnqueuedError
export type MembershipDeps = { subscriptionDeps: SubscriptionDeps; notEnqueued: (message: string) => Error };

// `reschedule_pending_resubscribed_memberships(installment, old_delayed_delivery_time, cutoff_reference_time)`
export async function reschedulePendingResubscribedMemberships(
  post: InstallmentPost,
  workflow: WorkflowRecord,
  rule: InstallmentRule,
  oldDelayedDeliveryTime: number | null,
  cutoffReferenceTime: Date,
  deps: MembershipDeps,
): Promise<void> {
  if (oldDelayedDeliveryTime === null) return;
  if (!reschedulesMemberships(workflow)) return;
  assertMembershipsReschedulable(workflow);

  const restartedAfter = new Date(cutoffReferenceTime.getTime() - oldDelayedDeliveryTime * SECOND_MS);
  let afterId: bigint | null = null;
  for (;;) {
    const subscriptions = await candidateBatch(workflow, restartedAfter, afterId);
    if (subscriptions.length === 0) return;
    if (subscriptions.length >= BATCH_SIZE) throw new NotPortedError("more than one batch of restarted memberships", "schedule_workflow_installment_job.rb");
    const loaded = await preloadBatch(subscriptions, deps.subscriptionDeps);

    for (const row of subscriptions) {
      const subscription = new SubscriptionRecord(row, deps.subscriptionDeps);
      if (!subscription.alive()) continue;
      const original = loaded.purchaseRows.find((purchase) => purchase.subscription_id === row.id);
      if (original === undefined) continue;
      const purchase = new PurchaseRecord(original, subscription);
      purchase.memo.set("link", Promise.resolve(original.link_id === null ? null : (loaded.links.get(Number(original.link_id)) ?? null)));
      purchase.memo.set("variant_attributes", Promise.resolve(loaded.variants.get(String(original.id)) ?? []));
      purchase.memo.set("license", Promise.resolve(loaded.licenses.get(String(original.id)) ?? null));
      if (!(await workflow.appliesToPurchase(purchase))) continue;

      const events = loaded.events.filter((event) => event.subscription_id === row.id);
      const restartedAt = latestEventTime(events, RESTARTED_EVENT_TYPE);
      const deactivatedAt = latestEventTime(events, DEACTIVATED_EVENT_TYPE);
      if (restartedAt === null || deactivatedAt === null) continue;
      if (original.created_at === null) throw new TypeError("undefined method '+' for nil");
      const reference = wholeSeconds(new Date(original.created_at.getTime() + (restartedAt.getTime() - deactivatedAt.getTime())));
      if (post.flag("is_for_new_customers_of_workflow") && reference.getTime() < post.row.published_at!.getTime()) continue;
      if (reference.getTime() + oldDelayedDeliveryTime * SECOND_MS <= cutoffReferenceTime.getTime()) continue;
      if (rule.delayed_delivery_time === null) throw new TypeError("nil can't be coerced into Integer");
      const jid = await performAsync(RESCHEDULE_JOB, [post.id, rule.version, Number(original.id), null, null, null, iso8601(reference)], { at: new Date(reference.getTime() + rule.delayed_delivery_time * SECOND_MS) });
      if (!jid) throw deps.notEnqueued("Sidekiq did not enqueue the workflow installment");
    }
    if (subscriptions.length < BATCH_SIZE) return;
    afterId = BigInt(subscriptions.at(-1)!.id);
  }
}
