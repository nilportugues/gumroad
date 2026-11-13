// Port of app/sidekiq/send_workflow_emails_to_past_canceled_members_job.rb: a member cancellation workflow post that goes to the
// members who cancelled before it was scheduled (or, after a delay edit, to the ones whose send time moved) is queued for each
// of them at `deactivated_at + delay`. Golden: __fixtures__/send-workflow-emails-to-past-canceled-members-job.golden.json
// (scripts/golden/send-workflow-emails-to-past-canceled-members-job.rb).
//
// Handed back to Rails before the job's first write, because the schedule intent writes (`begin_fanout`, `renew_fanout`,
// `mark_processed`) are not ported: a call that carries an intent token or a fanout token. So is everything Node cannot judge
// before the rule version is cached: a reschedule whose old delay is not an Integer or whose cutoff is not the `...Z` form the
// intents write, a minimum rule version that is not an Integer, filters Node does not read, and a first batch of 1000 members
// (the next batch's statement is not recorded). Sub-millisecond digits of `deactivated_at` are not read (the driver hands back
// milliseconds), so a send time can differ from Ruby's by less than a millisecond.
import { Prisma, type Installment, type InstallmentRule, type Purchase, type Subscription } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { present } from "../../server/models/installment-reschedule.ts";
import { cacheVersionBang } from "../../server/models/installment-rule.ts";
import { PurchaseRecord } from "../../server/models/purchase-pricing.ts";
import { findById, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo, uncached } from "../../server/models/runtime/query-cache.ts";
import { quote } from "../../server/models/runtime/quoting.ts";
import { castRow, column, columnIn, selectRows, table } from "../../server/models/sql.ts";
import { defaultSubscriptionDeps, SubscriptionRecord } from "../../server/models/subscription.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { SELLER_TYPE } from "../../server/models/with-filtering.ts";
import { SEND_WORKFLOW_INSTALLMENT_WORKER } from "../../server/models/workflow-scheduling.ts";
import { assertWorkflowSupported, installmentRuleOf, WorkflowRecord } from "../../server/models/workflow.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const SECOND_MS = 1000;
const FIND_EACH_BATCH_SIZE = 1000;
const RESCHEDULE_JOB = "SendWorkflowInstallmentRescheduleJob";
const UTC_ISO8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const ORIGINAL_SUBSCRIPTION_PURCHASE_FLAG = 1 << 2;
const ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE_FLAG = 1 << 17;

export class RuleNotCommittedError extends Error {
  constructor() {
    super("SendWorkflowEmailsToPastCanceledMembersJob::RuleNotCommittedError");
    this.name = "SendWorkflowEmailsToPastCanceledMembersJob::RuleNotCommittedError";
  }
}

export class FanoutNotEnqueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendWorkflowEmailsToPastCanceledMembersJob::FanoutNotEnqueuedError";
  }
}

type Extras = { redis: () => Redis; logError: (message: string) => void };

// `Time.zone.iso8601(string)` for the UTC form the intents write; anything else Ruby may read differently.
function parseCutoff(value: JsonValue): Date {
  if (typeof value !== "string" || !UTC_ISO8601.test(value))
    throw new NotPortedError(
      `a cutoff reference time that is not ISO 8601 UTC (${JSON.stringify(value)})`,
      "send_workflow_emails_to_past_canceled_members_job.rb",
    );
  const time = new Date(value);
  if (Number.isNaN(time.getTime()) || time.toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new NotPortedError(
      `a cutoff reference time that is not a time (${JSON.stringify(value)})`,
      "send_workflow_emails_to_past_canceled_members_job.rb",
    );
  return time;
}

const integerArgument = (value: JsonValue, what: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new NotPortedError(
      `${what} that is not an Integer (${JSON.stringify(value)})`,
      "send_workflow_emails_to_past_canceled_members_job.rb",
    );
  return value;
};

// `where(column: value)`: NULL compares with IS
const equals = (name: string, value: bigint | number | null) =>
  value === null ? `\`subscriptions\`.\`${name}\` IS NULL` : `\`subscriptions\`.\`${name}\` = ${quote(value)}`;

// `candidate_subscriptions(workflow, deactivated_after:)`, the first `find_each` batch
async function candidateBatch(workflow: WorkflowRecord, deactivatedAfter: Date | null): Promise<Subscription[]> {
  const after = deactivatedAfter === null ? "" : ` AND (subscriptions.deactivated_at > ${quote(deactivatedAfter)})`;
  const owner =
    workflow.productType || workflow.variantType
      ? equals("link_id", workflow.row.link_id)
      : equals("seller_id", workflow.row.seller_id);
  const rows = await uncached(() =>
    selectRows(
      Prisma.raw(
        `SELECT \`subscriptions\`.* FROM \`subscriptions\` WHERE \`subscriptions\`.\`deactivated_at\` IS NOT NULL AND \`subscriptions\`.\`cancelled_at\` IS NOT NULL${after} AND ${owner} ORDER BY \`subscriptions\`.\`id\` ASC LIMIT ${FIND_EACH_BATCH_SIZE}`,
      ),
    ),
  );
  return rows.map((row) => castRow<Subscription>("Subscription", row));
}

// `.includes(:original_purchase)` of that batch: the original purchase that is not archived
async function originalPurchases(subscriptions: Subscription[]): Promise<Purchase[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ((${column("purchases", "flags")} & ${ORIGINAL_SUBSCRIPTION_PURCHASE_FLAG} = ${ORIGINAL_SUBSCRIPTION_PURCHASE_FLAG})) AND ((${column("purchases", "flags")} & ${ARCHIVED_ORIGINAL_SUBSCRIPTION_PURCHASE_FLAG} = 0)) AND ${columnIn(
      "purchases",
      "subscription_id",
      subscriptions.map((subscription) => subscription.id),
    )}`,
  );
  return rows.map((row) => castRow<Purchase>("Purchase", row));
}

const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / SECOND_MS) * SECOND_MS);
const iso8601 = (time: Date) => time.toISOString().replace(".000Z", "Z");
const NIL_DELAY = "can't convert NilClass into an exact number";

export const sendWorkflowEmailsToPastCanceledMembersJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<Extras> = {},
) => {
  const { redis = () => getRedis("main"), logError = (message: string) => console.error(message) } = extras;
  return modelJob({ min: 1, max: 6 }, async (args, deps) => {
    const [
      installmentIdArg,
      oldDelay = null,
      cutoffArg = null,
      minimumRuleVersion = null,
      intentToken = null,
      fanoutToken = null,
    ] = args;
    if (present(intentToken) || present(fanoutToken))
      throw new HandBackToRuby("a call that carries a schedule intent token or a fanout token");
    const rescheduling = present(oldDelay) && present(cutoffArg);
    const primaryPinned = present(minimumRuleVersion) || rescheduling;

    const { installmentId, oldDelaySeconds, cutoff, minimumVersion } = await beforeSideEffects(() => ({
      installmentId: recordIdFrom(installmentIdArg, "Installment.find_by"),
      oldDelaySeconds: rescheduling ? integerArgument(oldDelay, "an old delayed delivery time") : null,
      cutoff: rescheduling ? parseCutoff(cutoffArg) : null,
      minimumVersion: present(minimumRuleVersion)
        ? integerArgument(minimumRuleVersion, "a minimum rule version")
        : null,
    }));

    const withPrimary = <T>(pinned: boolean, fn: () => Promise<T>) => (pinned ? connectedTo("writing", fn) : fn());
    let installment: Installment | null = null;
    let workflow: WorkflowRecord | null = null;
    let rule: InstallmentRule | null = null;
    await withPrimary(primaryPinned, async () => {
      installment = await findOneBy<Installment>("Installment", "id", installmentId, true);
      if (installment === null) return;
      const workflowRow = await findById<ConstructorParameters<typeof WorkflowRecord>[0]>(
        "Workflow",
        installment.workflow_id,
      );
      const candidate = workflowRow === null ? null : new WorkflowRecord(workflowRow);
      if (
        candidate === null ||
        !(candidate.row.deleted_at === null && installment.deleted_at === null && installment.published_at !== null) ||
        !candidate.memberCancellationTrigger ||
        !(candidate.sendToPastCustomers || rescheduling) ||
        !(candidate.row.workflow_type === SELLER_TYPE || candidate.productType || candidate.variantType)
      )
        return;
      rule = await installmentRuleOf(installment.id);
      if (rule === null) return;
      // The filters of the workflow are judged before the first write; the ones Node does not read go back to Rails.
      await beforeSideEffects(() => assertWorkflowSupported(candidate.row));
      if (minimumVersion !== null && rule.version < minimumVersion) throw new RuleNotCommittedError();
      workflow = candidate;
      try {
        await cacheVersionBang(rule, redis());
      } catch (error) {
        logError(`InstallmentRule version cache failed: ${(error as Error).message}`);
      }
    });
    if (installment === null || workflow === null || rule === null) return;
    const post = new InstallmentPost(installment);
    const member: WorkflowRecord = workflow;
    const current: InstallmentRule = rule;

    await withPrimary(rescheduling, async () => {
      const deactivatedAfter = cutoff === null ? null : new Date(cutoff.getTime() - oldDelaySeconds! * SECOND_MS);
      const subscriptions = await candidateBatch(member, deactivatedAfter);
      if (subscriptions.length === 0) return;
      if (subscriptions.length >= FIND_EACH_BATCH_SIZE)
        throw new HandBackToRuby("more than one batch of cancelled members");
      const originals = await originalPurchases(subscriptions);
      const subscriptionDeps = { now: deps.now, featureActive: defaultSubscriptionDeps.featureActive };

      for (const row of subscriptions) {
        const subscription = new SubscriptionRecord(row, subscriptionDeps);
        // `next unless subscription.cancelled?`
        if (subscription.alive(true) || row.cancelled_at == null) continue;
        const original = originals.find((purchase) => purchase.subscription_id === row.id);
        if (original === undefined) continue;
        if (!(await member.appliesToPurchase(new PurchaseRecord(original, subscription)))) continue;

        const deactivatedAt = row.deactivated_at!;
        // `deactivated_at + delay` fails on a rule without a delay, and only for a member that gets this far.
        const sendAt = (from: Date) => {
          if (current.delayed_delivery_time === null) throw new TypeError(NIL_DELAY);
          return new Date(from.getTime() + current.delayed_delivery_time * SECOND_MS);
        };
        let jobId: string | null;
        if (rescheduling) {
          const reference = wholeSeconds(deactivatedAt);
          if (post.flag("is_for_new_customers_of_workflow") && reference.getTime() < post.row.published_at!.getTime())
            continue;
          if (!(reference.getTime() + oldDelaySeconds! * SECOND_MS > cutoff!.getTime())) continue;
          jobId = await performAsync(
            RESCHEDULE_JOB,
            [post.id, current.version, null, null, null, Number(row.id), iso8601(reference)],
            {
              at: sendAt(reference),
            },
          );
        } else {
          jobId = await performAsync(
            SEND_WORKFLOW_INSTALLMENT_WORKER,
            [post.id, current.version, null, null, null, Number(row.id)],
            {
              at: sendAt(deactivatedAt),
            },
          );
        }
        if (!jobId) throw new FanoutNotEnqueuedError("Sidekiq did not enqueue the workflow installment");
      }
    });
  })(overrides);
};

export const sendWorkflowEmailsToPastCanceledMembersJob = sendWorkflowEmailsToPastCanceledMembersJobWith();
