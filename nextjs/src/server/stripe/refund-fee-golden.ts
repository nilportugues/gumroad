// Test support for the refund fee retention goldens (__fixtures__/refund-fee-retention.golden.json): the golden itself, a scripted Stripe that
// answers each call from the case's queue as the Ruby harness did, and a refund row that notes its writes.
import { readFileSync } from "node:fs";

import { APIError, InvalidRequestError } from "./errors.ts";
import type { RefundFeeRefund, RefundStripe, StripeRequest } from "./refund-fee-collection.ts";

export type Answer = Record<string, unknown> & { error?: { class: string; message: string } };
export type Event = { call?: string; id?: string; second_id?: string; params?: unknown; options?: unknown; write?: string; refund?: unknown };
export type Answers = Record<string, Answer[]>;
export type Outcome = { returned?: boolean | number | null; raised?: string; message?: string };

export type CollectionCase = {
  name: string;
  input: {
    account: { country: string; currency: string };
    refund: Record<string, unknown>;
    collect: boolean;
    holder_of_funds: string;
    credit_amount_cents: number;
    on_lock: Record<string, unknown> | null;
    internal_transfer_ids: (string | null)[];
  };
  answers: Answers;
  events: Event[];
  outcome: Outcome;
  refund: Record<string, unknown>;
};

export type Golden = { now: string; rates: Record<string, string>; collection: CollectionCase[]; [section: string]: unknown };

export const GOLDEN = JSON.parse(readFileSync(new URL("./__fixtures__/refund-fee-retention.golden.json", import.meta.url), "utf8")) as Golden;

export const REFUND_ID = 4242;
export const ACCOUNT_ID = "acct_golden01";

// The golden writes the refund's id as <refund> (a string) and <refund:int> (the Integer metadata of a grouped debit).
export const withRefundId = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll('"<refund:int>"', String(REFUND_ID)).replaceAll("<refund>", String(REFUND_ID))) as T;

export function buildError(error: { class: string; message: string }): Error {
  if (error.class === "Stripe::InvalidRequestError") return new InvalidRequestError(error.message, null);
  if (error.class === "Stripe::APIError") return new APIError(error.message);
  throw new Error(`no error for ${error.class}`);
}

// Each call is noted and answered from its queue, the last answer repeating.
export function scriptedStripe(answers: Answers, events: Event[]): RefundStripe {
  const queues = new Map(Object.entries(withRefundId(answers)).map(([name, queue]) => [name, [...queue]]));
  return {
    async call(request: StripeRequest) {
      events.push({
        call: request.call,
        ...(request.id === undefined ? {} : { id: request.id }),
        ...(request.params === undefined ? {} : { params: request.params }),
        ...(request.secondId === undefined ? {} : { second_id: request.secondId }),
        ...(request.options === undefined ? {} : { options: request.options }),
      });
      const queue = queues.get(request.call);
      if (!queue) throw new Error(`unscripted Stripe call ${request.call}`);
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (answer.error) throw buildError(answer.error);
      return answer;
    },
  };
}

const TRACKED = ["fee_retention_source_transfer", "debited_stripe_transfer", "fee_retention_collected_cents", "fee_retention_written_off_at"] as const;

// `onLock` is what another process wrote to the row before the lock was granted; the first `with_lock` reloads it.
export function refundFor(
  state: Record<string, unknown>,
  events: Event[],
  onLock: Record<string, unknown> | null = null,
): RefundFeeRefund & { snapshot(): Record<string, unknown> } {
  let pendingChange = onLock;
  const refund = {
    id: REFUND_ID,
    debitedStripeTransfer: (state.debited_stripe_transfer as string | undefined) ?? null,
    feeRetentionSourceTransfer: (state.fee_retention_source_transfer as string | undefined) ?? null,
    feeRetentionCollectedCents: (state.fee_retention_collected_cents as number | undefined) ?? null,
    feeRetentionWrittenOffAt: (state.fee_retention_written_off_at as string | undefined) ?? null,
    snapshot() {
      const all: Record<string, unknown> = {
        fee_retention_source_transfer: refund.feeRetentionSourceTransfer,
        debited_stripe_transfer: refund.debitedStripeTransfer,
        fee_retention_collected_cents: refund.feeRetentionCollectedCents,
        fee_retention_written_off_at: refund.feeRetentionWrittenOffAt,
      };
      return Object.fromEntries(TRACKED.filter((key) => all[key] !== null).map((key) => [key, all[key]]));
    },
    async withLock<T>(fn: () => Promise<T>) {
      events.push({ write: "refund.with_lock" });
      if (pendingChange) {
        const change = pendingChange;
        pendingChange = null;
        if ("debited_stripe_transfer" in change) refund.debitedStripeTransfer = change.debited_stripe_transfer as string;
        if ("fee_retention_source_transfer" in change) refund.feeRetentionSourceTransfer = change.fee_retention_source_transfer as string;
        if ("fee_retention_collected_cents" in change) refund.feeRetentionCollectedCents = change.fee_retention_collected_cents as number;
        if ("fee_retention_written_off_at" in change) refund.feeRetentionWrittenOffAt = change.fee_retention_written_off_at as string;
      }
      return fn();
    },
    async save() {
      events.push({ write: "refund.save!", refund: refund.snapshot() });
    },
  };
  return refund;
}
