// Ports of the jobs that read refunds, failed-refund exceptions and disputes:
//   app/sidekiq/fight_disputes_job.rb
//   app/sidekiq/dispatch_pending_failed_refund_exceptions_job.rb
//   app/sidekiq/notify_failed_refund_exception_job.rb
//   app/sidekiq/refund_unpaid_purchases_worker.rb
// and, handed back to Rails as soon as their read finds work (the rest writes through Refund's
// callbacks, creates dispute evidence or calls the charge processor, which Node does not do yet):
//   app/sidekiq/recover_pending_refund_fee_retention_job.rb
//   app/sidekiq/create_missing_dispute_evidence_job.rb
// Golden: __fixtures__/refund-dispute-jobs.golden.json (scripts/golden/refund-dispute-jobs.rb).
import { Prisma, type DisputeEvidence, type Refund } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { COMMENT_TYPES, Comments } from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { DISPUTE_EVIDENCES, disputeEvidenceScopes, windowOpen } from "../../server/models/dispute-evidence.ts";
import {
  disputesMissingEvidenceFirstBatch,
  preloadDisputes,
  TERMINAL_DISPUTE_STATES,
} from "../../server/models/dispute.ts";
import {
  escalateBang,
  failedRefundExceptionScopes,
  FAILED_REFUND_EXCEPTIONS,
  findFailedRefundExceptionBang,
  incrementNotificationFailures,
  loadFailedRefundException,
  markNotificationSentBang,
  MAX_NOTIFICATION_FAILURES,
  refundOf,
  type FailedRefundExceptionRecord,
} from "../../server/models/failed-refund-exception.ts";
import {
  externalId,
  failedRefundFeeReversalExists,
  jsonDataForAttr,
  pendingFeeRetention,
  purchaseOf,
  REFUNDS,
  Refunds,
  retainedFeeCents,
  type RefundRecord,
} from "../../server/models/refund.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { clearQueryCache } from "../../server/models/runtime/query-cache.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { findUserBang, isSuspended, nameOrUsername, NotPortedError } from "../../server/models/user.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

// ErrorNotifier.notify(message, context: {...}): `context:` is a keyword of its own, so what reaches
// Sentry's extra scope is `{ context: {...} }`.
export type RefundDisputeDeps = { notify: (errorOrMessage: unknown, context: Record<string, unknown>) => void };
const defaultDeps: RefundDisputeDeps = { notify: (errorOrMessage, context) => notifyError(errorOrMessage, context) };

// Time#iso8601: whole seconds, UTC.
const iso8601 = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;
const n = (value: bigint | number | null | undefined) => (value == null ? null : Number(value));

// ---------------------------------------------------------------------------------------------
// FightDisputesJob

const FIGHT_DISPUTE_JOB = "FightDisputeJob";
const BATCH_SIZE = 1_000;

export const fightDisputesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const now = deps.now();
  const where = Prisma.sql`${disputeEvidenceScopes.sellerContacted()} AND ${disputeEvidenceScopes.notResolved()}`;
  await findInBatches<DisputeEvidence>(DISPUTE_EVIDENCES, where, BATCH_SIZE, async (rows) => {
    const evidences = rows.map((row) => castRow<DisputeEvidence>("DisputeEvidence", row));
    const disputes = await preloadDisputes(evidences);
    for (const evidence of evidences) {
      if (windowOpen(evidence.seller_contacted_at, now)) continue;
      const dispute = disputes.get(String(evidence.dispute_id));
      if (!dispute) throw new TypeError("undefined method 'state' for nil");
      if (dispute.state != null && TERMINAL_DISPUTE_STATES.includes(dispute.state)) continue;
      await performAsync(FIGHT_DISPUTE_JOB, [Number(dispute.id)]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// NotifyFailedRefundExceptionJob

const NOTIFY_JOB = "NotifyFailedRefundExceptionJob";

async function handlingSummary(exception: FailedRefundExceptionRecord, refund: RefundRecord): Promise<string> {
  if (!exception.get("balance_reversed")) {
    return "Nothing was reversed automatically. Review the exception before changing any ledger, payout, dispute, or buyer state.";
  }
  let summary = "Balance debits recorded on the refund were reversed automatically.";
  const retainedFee = retainedFeeCents(refund);
  if (retainedFee > 0) {
    summary += (await failedRefundFeeReversalExists(refund.get("id")))
      ? ` The ${retainedFee}-cent processor fee retained via a separate credit was also given back to the seller.`
      : ` The ${retainedFee}-cent processor fee retained via a separate credit was NOT reversed; the seller is still debited that fee, and a re-refund will retain it again.`;
  }
  return summary;
}

function nilReceiver(method: string): never {
  throw new TypeError(`undefined method '${method}' for nil`);
}

export const notifyFailedRefundExceptionJobWith = (
  overrides: Partial<JobDeps> = {},
  extra: Partial<RefundDisputeDeps> = {},
) => {
  const { notify } = { ...defaultDeps, ...extra };
  return modelJob({ min: 1 }, async ([exceptionId], deps) => {
    const id = await beforeSideEffects(() => recordIdFrom(exceptionId, "FailedRefundException.find"));
    const exception = await findFailedRefundExceptionBang(id);
    if (exception.get("state") !== "pending") return;
    if (exception.get("notification_sent_at") != null) return;
    if (exception.get("notification_failures") >= MAX_NOTIFICATION_FAILURES) return;

    const refund = (await refundOf(exception)) ?? nilReceiver("purchase");
    const purchase = (await purchaseOf(refund)) ?? nilReceiver("external_id");
    const dueAt = exception.get("due_at");
    const purchaseExternalId = externalId(purchase.id);
    const message =
      `Refund failed after acceptance; the buyer was NOT made whole. ${await handlingSummary(exception, refund)} ` +
      `Exception #${String(exception.get("id"))} is assigned to ${exception.get("owner")}, ` +
      `with a target response by ${iso8601(dueAt)}. ` +
      `Refund ${String(refund.get("id"))} (${refund.get("processor_refund_id") ?? ""}), purchase ${purchaseExternalId}, ` +
      `seller ${purchase.seller_id ?? ""}. Review buyer communication, re-refund, subscription state, ` +
      "payout effects, and any fee or tax side effects.";
    const context = {
      failed_refund_exception_id: n(exception.get("id")),
      owner: exception.get("owner"),
      notification_room: exception.get("notification_room"),
      due_at: dueAt,
      refund_id: n(refund.get("id")),
      processor_refund_id: refund.get("processor_refund_id"),
      purchase_id: n(purchase.id),
      purchase_external_id: purchaseExternalId,
      seller_id: n(purchase.seller_id),
      refund_amount_cents: refund.get("amount_cents"),
      presentment_currency: jsonDataForAttr(refund, "presentment_currency"),
      presentment_amount_cents: jsonDataForAttr(refund, "presentment_amount_cents"),
      balance_reversed: exception.get("balance_reversed"),
      retained_fee_cents: retainedFeeCents(refund),
    };

    try {
      notify(message, { context });
    } catch (error) {
      // Only a completed reporting failure counts; counting before the call would let the
      // dispatcher mistake an in-flight final attempt for an exhausted one.
      await incrementNotificationFailures(exception);
      throw error;
    }
    await markNotificationSentBang(exception, deps.now);
  })(overrides);
};

// ---------------------------------------------------------------------------------------------
// DispatchPendingFailedRefundExceptionsJob

async function escalate(
  exception: FailedRefundExceptionRecord,
  reason: string,
  notify: RefundDisputeDeps["notify"],
  deps: JobDeps,
): Promise<void> {
  const message = `Failed-refund exception #${String(exception.get("id"))} escalated. ${reason} Refund ${String(exception.get("refund_id"))}, owner ${exception.get("owner")}.`;
  // Unrescued on purpose: if Sentry itself raises, the row stays pending and the next run retries.
  notify(message, {
    context: {
      failed_refund_exception_id: n(exception.get("id")),
      refund_id: n(exception.get("refund_id")),
      owner: exception.get("owner"),
      notification_room: exception.get("notification_room"),
      due_at: exception.get("due_at"),
      notification_failures: exception.get("notification_failures"),
    },
  });
  await escalateBang(exception, reason, deps.now);
}

export const dispatchPendingFailedRefundExceptionsJobWith = (
  overrides: Partial<JobDeps> = {},
  extra: Partial<RefundDisputeDeps> = {},
) => {
  const { notify } = { ...defaultDeps, ...extra };
  return modelJob({ min: 0 }, async (_args, deps) => {
    const each = (where: Prisma.Sql, body: (exception: FailedRefundExceptionRecord) => Promise<void>) =>
      findInBatches(FAILED_REFUND_EXCEPTIONS, where, BATCH_SIZE, async (rows) => {
        for (const row of rows) await body(loadFailedRefundException(row));
      });

    await each(failedRefundExceptionScopes.notificationDeliverable(), async (exception) => {
      await performAsync(NOTIFY_JOB, [Number(exception.get("id"))]);
    });
    await each(failedRefundExceptionScopes.deliveryExhausted(), (exception) =>
      escalate(
        exception,
        `Sentry reporting failed ${exception.get("notification_failures")} times; the error reporter needs attention.`,
        notify,
        deps,
      ),
    );
    // `Time.current` is read when the relation is built, after the first two loops.
    await each(failedRefundExceptionScopes.overdue(deps.now()), (exception) =>
      escalate(
        exception,
        `Response SLA breached: due by ${iso8601(exception.get("due_at"))} and still pending.`,
        notify,
        deps,
      ),
    );
  })(overrides);
};

// ---------------------------------------------------------------------------------------------
// RefundUnpaidPurchasesWorker

const REFUND_PURCHASE_WORKER = "RefundPurchaseWorker";
const SUSPENDED_REFUND_REASON = "Account suspended; unpaid sale refunded to the buyer";

// RefundUnpaidPurchasesWorker.unpaid_purchases_for(user).ids
async function unpaidPurchaseIds(userId: unknown): Promise<unknown[]> {
  const p = (name: string) => column("purchases", name);
  const b = (name: string) => column("balances", name);
  const rows = await selectRows<{ id: unknown }>(
    Prisma.sql`SELECT ${p("id")} FROM ${table("purchases")} WHERE ${p("seller_id")} = ${userId} AND ${p("purchase_success_balance_id")} IN (SELECT ${b("id")} FROM ${table("balances")} WHERE ${b("user_id")} = ${userId} AND ${b("state")} = ${"unpaid"}) AND ${p("purchase_state")} = ${"successful"} AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)`,
  );
  return rows.map((row) => row.id);
}

export const refundUnpaidPurchasesWorkerWith = modelJob({ min: 2 }, async ([userIdArg, adminUserIdArg], deps) => {
  const { userId, adminId } = await beforeSideEffects(() => ({
    userId: recordIdFrom(userIdArg, "User.find"),
    adminId: recordIdFrom(adminUserIdArg, "User.find"),
  }));
  const user = await findUserBang(userId);
  if (!isSuspended(user)) return;

  for (const purchaseId of await unpaidPurchaseIds(user.get("id"))) {
    await performAsync(REFUND_PURCHASE_WORKER, [
      Number(purchaseId),
      adminUserIdArg as JsonValue,
      SUSPENDED_REFUND_REASON,
    ]);
  }

  const admin = await findUserBang(adminId);
  const adminName = nameOrUsername(admin);
  await Comments.createBang(
    {
      commentable_id: BigInt(user.get("id")),
      commentable_type: "User",
      author_id: BigInt(admin.get("id")),
      author_name: adminName,
      comment_type: COMMENT_TYPES.REFUND_BALANCE,
      content: `Refund balance initiated by ${adminName ?? ""}.`,
    },
    { now: deps.now },
  );
});

// ---------------------------------------------------------------------------------------------
// RecoverPendingRefundFeeRetentionJob

// Refund#recover_pending_fee_retention! up to the point it writes: `purchase.with_lock { reload.fee_retention_pending }`.
// A refund with a fee still pending goes to Rails (a Stripe transfer lookup, ledger rows, `save!`).
// Like the Ruby job, an error on one refund (a lock wait timeout, say) is reported and the sweep moves
// on; if a later refund then has to be handed back, Rails reports the first one again.
export const recoverPendingRefundFeeRetentionJobWith = (
  overrides: Partial<JobDeps> = {},
  extra: Partial<RefundDisputeDeps> = {},
) => {
  const { notify } = { ...defaultDeps, ...extra };
  return modelJob({ min: 0 }, async () => {
    await beforeSideEffects(() =>
      findInBatches(REFUNDS, pendingFeeRetention(), BATCH_SIZE, async (rows) => {
        for (const row of rows) {
          const refund = Refunds.load(castRow<Refund>("Refund", row));
          try {
            if (!(await feeRetentionPending(refund))) continue;
          } catch (error) {
            if (error instanceof NotPortedError) throw error;
            notify(error, { context: { refund_id: n(refund.get("id")), purchase_id: n(refund.get("purchase_id")) } });
            continue;
          }
          throw new NotPortedError(
            "Refund#collect_pending_fee_retention!",
            "refund.rb:collect_pending_fee_retention! (Stripe fee transfer, ledger rows, save!)",
          );
        }
      }),
    );
  })(overrides);
};

// `pending = purchase.with_lock { reload.fee_retention_pending }`
async function feeRetentionPending(refund: RefundRecord): Promise<boolean> {
  const purchase = await purchaseOf(refund);
  if (purchase === null)
    throw new NotPortedError(
      "Refund#recover_pending_fee_retention! without a purchase",
      "refund.rb:recover_pending_fee_retention!",
    );
  const pending = await transaction(async () => {
    // lock! reloads the purchase FOR UPDATE.
    clearQueryCache();
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id} LIMIT 1 FOR UPDATE`,
    );
    await Refunds.reload(refund);
    return jsonDataForAttr(refund, "fee_retention_pending");
  });
  return pending !== null;
}

// ---------------------------------------------------------------------------------------------
// CreateMissingDisputeEvidenceJob

// An empty scan is the whole job. A dispute in it is built by Rails: evidence attachments, deadline
// lookup at the processor, the seller's notice and the submission.
export const createMissingDisputeEvidenceJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  await beforeSideEffects(async () => {
    const disputes = await disputesMissingEvidenceFirstBatch(deps.now());
    if (disputes.length > 0)
      throw new NotPortedError(
        "CreateMissingDisputeEvidenceJob#create_evidence_for",
        "create_missing_dispute_evidence_job.rb:create_evidence_for",
      );
  });
});

export const fightDisputesJob = fightDisputesJobWith();
export const dispatchPendingFailedRefundExceptionsJob = dispatchPendingFailedRefundExceptionsJobWith();
export const notifyFailedRefundExceptionJob = notifyFailedRefundExceptionJobWith();
export const refundUnpaidPurchasesWorker = refundUnpaidPurchasesWorkerWith();
export const recoverPendingRefundFeeRetentionJob = recoverPendingRefundFeeRetentionJobWith();
export const createMissingDisputeEvidenceJob = createMissingDisputeEvidenceJobWith();
