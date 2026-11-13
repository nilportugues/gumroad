// app/models/purchase_refund_request.rb, the part a request reaches: reading a purchase's request and creating one
// (Purchases::RefundRequestsController). Raw SQL, because prisma/schema.prisma does not carry this table yet.
import { Prisma } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, execute, isRecordNotUnique, selectRows, table } from "./sql.ts";

const REQUESTS = "purchase_refund_requests";
export const REFUND_REQUEST_SECURE_ID_SCOPE = "refund_request";
export const REFUND_REQUESTS_FEATURE = "buyer_refund_requests";

// PurchaseRefundRequest::REASONS
export const REFUND_REASONS = ["not_received", "not_as_described", "no_longer_needed", "duplicate_purchase", "other"];

// PurchaseRefundRequest::MAX_MESSAGE_LENGTH
export const MAX_MESSAGE_LENGTH = 2_000;

// `params[:message].to_s.strip.first(MAX_MESSAGE_LENGTH).presence`. String#strip takes ASCII whitespace only, where JavaScript's trim
// also takes the Unicode kinds; `first` counts code points; `presence` is `blank?`, which does take them.
export function refundRequestMessage(message: string): string | null {
  const cut = [...message.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "")].slice(0, MAX_MESSAGE_LENGTH).join("");
  return isBlank(cut) ? null : cut;
}

export type StoredRefundRequest = {
  id: bigint;
  email: string;
  reason: string;
  escalated_at: Date | null;
  created_at: Date;
};

// `purchase.refund_request`: has_one, unique on purchase_id.
export async function findRefundRequest(purchaseId: bigint): Promise<StoredRefundRequest | null> {
  const [row] = await selectRows<{
    id: bigint | number;
    email: string;
    reason: string;
    escalated_at: Date | null;
    created_at: Date;
  }>(
    Prisma.sql`SELECT ${column(REQUESTS, "id")}, ${column(REQUESTS, "email")}, ${column(REQUESTS, "reason")}, ${column(REQUESTS, "escalated_at")}, ${column(REQUESTS, "created_at")} FROM ${table(REQUESTS)} WHERE ${column(REQUESTS, "purchase_id")} = ${purchaseId} LIMIT 1`,
  );
  return row ? { ...row, id: BigInt(row.id) } : null;
}

// `PurchaseRefundRequest.create!(...)` for a valid row (a present email, a known reason, a message within its limit), rescuing
// ActiveRecord::RecordNotUnique: a purchase gets one request, so a repeat submit writes nothing and queues nothing.
export async function createRefundRequest(input: {
  purchaseId: bigint;
  email: string;
  reason: string;
  message: string | null;
  now: Date;
}): Promise<boolean> {
  try {
    await execute(
      Prisma.sql`INSERT INTO ${table(REQUESTS)} (${column(REQUESTS, "purchase_id")}, ${column(REQUESTS, "email")}, ${column(REQUESTS, "reason")}, ${column(REQUESTS, "message")}, ${column(REQUESTS, "created_at")}, ${column(REQUESTS, "updated_at")}) VALUES (${input.purchaseId}, ${input.email}, ${input.reason}, ${input.message}, ${input.now}, ${input.now})`,
    );
  } catch (error) {
    if (isRecordNotUnique(error)) return false;
    throw error;
  }
  const created = (await findRefundRequest(input.purchaseId))!;
  // after_create_commit :notify_seller_and_buyer
  for (const [mailer, method] of [
    ["ContactingCreatorMailer", "refund_requested"],
    ["CustomerLowPriorityMailer", "refund_request_received"],
  ] as const)
    await deliverLater(
      currentJobsRuntime(),
      { mailer, method, args: [Number(created.id)], queue: "default" },
      mailRoute(mailer, method),
    );
  return true;
}
