// The props of `Purchases/RefundRequest/Show` (GET /purchases/:purchase_id/refund_request, Purchases::RefundRequestsController#show),
// with the eligibility rules of PurchaseRefundRequest they are made of. Built and proven against Rails' own answers in
// refund-request.test.ts, not served: the token (a secure external id that expires), the `buyer_refund_requests` flag and the
// refund policy of a subscription's or preorder's original purchase are the caller's to resolve, and the POST that creates a
// request queues mail, so /purchases/:id/refund_request stays in Rails. It only reads; nothing here refunds anything.
import type { Purchase } from "@prisma/client";

import { formattedDisplayPrice } from "../../presenters/mobile-serializers.ts";

export const REFUND_REQUEST_COMPONENT = "Purchases/RefundRequest/Show";

// PurchaseRefundRequest::MAX_MESSAGE_LENGTH, ESCALATION_BUSINESS_DAYS
export const MAX_MESSAGE_LENGTH = 2_000;
const ESCALATION_BUSINESS_DAYS = 2;
const DAY_MS = 86_400_000;

// PurchaseRefundRequest::REASON_LABELS
export const REASON_LABELS: Record<string, string> = {
  not_received: "I never received the product",
  not_as_described: "The product wasn't as described",
  no_longer_needed: "I no longer need it",
  duplicate_purchase: "I was charged twice for the same purchase",
  other: "Something else",
};

export type RefundRequestRow = { email: string; reason: string; escalated_at: Date | null; created_at: Date };

// Time#strftime(PurchaseRefundRequest::DATE_FORMAT), "%A, %B %-d", in UTC
export const formatDeadline = (time: Date): string =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    .format(time)
    .replace(/^(\w+) (\w+ \d+)$/u, "$1, $2");

// PurchaseRefundRequest.escalation_deadline_from: weekdays only, to the end of the day.
export function escalationDeadlineFrom(time: Date): Date {
  let day = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
  const isWeekend = (ms: number) => [0, 6].includes(new Date(ms).getUTCDay());
  for (let step = 0; step < ESCALATION_BUSINESS_DAYS; step += 1) {
    day += DAY_MS;
    while (isWeekend(day)) day += DAY_MS;
  }
  return new Date(day + DAY_MS - 1);
}

// PurchaseRefundRequest#status: read from the purchase, so a refund or dispute needs no sync back to the row.
export function refundRequestStatus(purchase: Purchase, request: RefundRequestRow): string {
  if (purchase.stripe_refunded === true) return "refunded";
  if (purchase.chargeback_date != null) return "disputed";
  return request.escalated_at != null ? "escalated" : "requested";
}

// PurchaseRefundRequest.ineligibility; `maxRefundPeriodInDays` is refund_period_in_days(purchase).
export function ineligibility(purchase: Purchase, maxRefundPeriodInDays: number | null, now: Date): string | null {
  if (purchase.purchase_state !== "successful" || (purchase.price_cents ?? 0) <= 0) return "not_charged";
  if (purchase.stripe_refunded === true) return "refunded";
  if (purchase.chargeback_date != null) return "disputed";
  if (purchase.stripe_partially_refunded === true) return "partially_refunded";
  // 0 = the seller sells "no refunds"
  if (maxRefundPeriodInDays !== null && maxRefundPeriodInDays <= 0) return "no_refunds";
  if (
    maxRefundPeriodInDays !== null &&
    purchase.created_at!.getTime() <= now.getTime() - maxRefundPeriodInDays * DAY_MS
  )
    return "outside_window";
  return null;
}

// PurchaseRefundRequest.refund_window_end
const refundWindowEnd = (purchase: Purchase, maxRefundPeriodInDays: number | null): Date | null =>
  maxRefundPeriodInDays !== null && maxRefundPeriodInDays > 0
    ? new Date(purchase.created_at!.getTime() + maxRefundPeriodInDays * DAY_MS)
    : null;

export function refundRequestPageProps(input: {
  purchaseRouteId: string;
  purchase: Purchase;
  productName: string;
  sellerName: string;
  refundRequest: RefundRequestRow | null;
  maxRefundPeriodInDays: number | null;
  now: Date;
}) {
  const { purchase, refundRequest, maxRefundPeriodInDays, now } = input;
  const reason = ineligibility(purchase, maxRefundPeriodInDays, now);
  // A request made now would get this deadline; an existing one keeps its own.
  const respondBy = escalationDeadlineFrom(refundRequest?.created_at ?? now);
  const windowEnd = reason === "outside_window" ? refundWindowEnd(purchase, maxRefundPeriodInDays) : null;
  return {
    purchase_route_id: input.purchaseRouteId,
    product_name: input.productName,
    seller_name: input.sellerName,
    formatted_price: formattedDisplayPrice(purchase),
    respond_by: formatDeadline(respondBy),
    max_message_length: MAX_MESSAGE_LENGTH,
    reasons: Object.entries(REASON_LABELS).map(([value, label]) => ({ value, label })),
    refund_request: refundRequest && {
      status: refundRequestStatus(purchase, refundRequest),
      email: refundRequest.email,
      reason_label: REASON_LABELS[refundRequest.reason],
    },
    ineligibility: reason,
    refund_window_ended_on: windowEnd && formatDeadline(windowEnd),
  };
}
