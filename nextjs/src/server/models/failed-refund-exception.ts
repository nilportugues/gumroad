// Port of app/models/failed_refund_exception.rb (golden: worker/jobs/__fixtures__/refund-dispute-jobs.golden.json).
// The scopes the failed-refund jobs read, `escalate!`, `update!(notification_sent_at:)` and
// `increment!(:notification_failures)`. `resolve!` is a plain `update!` that nothing in Node calls,
// and the routing-policy class methods (`default_owner`, `response_sla`) belong to the code that
// creates exceptions, which is Ruby.
import { Prisma, type FailedRefundException } from "@prisma/client";

import { readBelongsTo } from "./concerns/belongs-to-record.ts";
import { belongsToRequired, validatesUniqueness, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";
import { Refunds, type RefundRecord } from "./refund.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";

export type FailedRefundExceptionRecord = ModelRecord<FailedRefundException>;

export const FAILED_REFUND_EXCEPTIONS = "failed_refund_exceptions";
// Ceiling on notification delivery failures; past it the dispatcher escalates instead of re-enqueuing.
export const MAX_NOTIFICATION_FAILURES = 20;
export const FAILED_REFUND_EXCEPTION_STATES = ["pending", "escalated", "resolved"] as const;
// CHAT_ROOMS.keys (config/initializers/chat_rooms.rb)
export const CHAT_ROOM_KEYS = ["agent_reports", "announcements", "awards", "internals_log", "migrations", "payments", "payouts", "risk", "test"] as const;

const REFUND: BelongsTo = { name: "refund", foreignKey: "refund_id", targetTable: "refunds", targetModel: "Refund" };

export const FailedRefundExceptions = defineModel<FailedRefundException>({
  rubyClass: "FailedRefundException",
  prismaModel: "FailedRefundException",
  delegate: (tx) => tx.failedRefundException as never,
  validations: [
    belongsToRequired<FailedRefundException>(REFUND),
    validatesUniqueness<FailedRefundException>("FailedRefundException", FAILED_REFUND_EXCEPTIONS, "refund_id"),
    validatesPresenceOf<FailedRefundException>(["owner", "notification_room", "state", "due_at"]),
    validatesInclusionOf<FailedRefundException>(["notification_room"], { in: CHAT_ROOM_KEYS }),
    validatesInclusionOf<FailedRefundException>(["state"], { in: FAILED_REFUND_EXCEPTION_STATES }),
  ],
});

const col = (name: string) => column(FAILED_REFUND_EXCEPTIONS, name);
const pending = () => Prisma.sql`${col("state")} = ${"pending"}`;

// scope :notification_pending
const notificationPending = () => Prisma.sql`${pending()} AND ${col("notification_sent_at")} IS NULL`;

// The `where` of each scope, for `findInBatches(FAILED_REFUND_EXCEPTIONS, ...)`.
export const failedRefundExceptionScopes = {
  // scope :notification_deliverable
  notificationDeliverable: () => Prisma.sql`${notificationPending()} AND ${col("notification_failures")} < ${MAX_NOTIFICATION_FAILURES}`,
  // scope :delivery_exhausted
  deliveryExhausted: () => Prisma.sql`${notificationPending()} AND ${col("notification_failures")} >= ${MAX_NOTIFICATION_FAILURES}`,
  // scope :overdue; `due_at: ..Time.current` keeps the fraction (datetime(6)).
  overdue: (now: Date) => Prisma.sql`${pending()} AND ${col("due_at")} <= ${now}`,
};

// FailedRefundException.find(id)
export async function findFailedRefundExceptionBang(id: bigint): Promise<FailedRefundExceptionRecord> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`failed_refund_exceptions`.*")} FROM ${table(FAILED_REFUND_EXCEPTIONS)} WHERE ${col("id")} = ${id} LIMIT 1`);
  if (!row) throw new RecordNotFound(`Couldn't find FailedRefundException with 'id'=${String(id)}`);
  return loadFailedRefundException(row);
}

export const loadFailedRefundException = (row: Record<string, unknown>): FailedRefundExceptionRecord =>
  FailedRefundExceptions.load(castRow<FailedRefundException>("FailedRefundException", row));

// failed_refund_exception.refund (a belongs_to, loaded once per record)
export const refundOf = (record: FailedRefundExceptionRecord): Promise<RefundRecord | null> => readBelongsTo(record, REFUND, Refunds);

// #escalate!
export const escalateBang = (record: FailedRefundExceptionRecord, resolution: string, now: () => Date) =>
  FailedRefundExceptions.updateBang(record, { state: "escalated", resolution }, { now });

// #update!(notification_sent_at: Time.current)
export const markNotificationSentBang = (record: FailedRefundExceptionRecord, now: () => Date) =>
  FailedRefundExceptions.updateBang(record, { notification_sent_at: now() }, { now });

// #increment!(:notification_failures): one counter UPDATE outside any transaction, without updated_at.
export async function incrementNotificationFailures(record: FailedRefundExceptionRecord): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table(FAILED_REFUND_EXCEPTIONS)} SET ${col("notification_failures")} = COALESCE(${col("notification_failures")}, 0) + 1 WHERE ${col("id")} = ${record.get("id")}`,
  );
}
