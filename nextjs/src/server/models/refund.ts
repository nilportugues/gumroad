// app/models/refund.rb: the read side the failed-refund and fee-retention jobs look at, and the row itself (`Refunds`: assign_product,
// assign_seller, the processor_refund_id uniqueness, JsonData and sync_fee_retention_recoverable). The Stripe fee-retention calls and
// the `with_lock` bookkeeping of recover_pending_fee_retention! are not here.
// Goldens: worker/jobs/__fixtures__/refund-dispute-jobs.golden.json (scripts/golden/refund-dispute-jobs.rb) for the readers,
// __fixtures__/refund-write.golden.json (scripts/golden/refund-write.rb) for the saves.
import { Prisma, type Purchase, type Refund } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";

import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import {
  jsonDataForAttr as storedJsonAttr,
  mergeJsonDataWithCurrentRow,
  setJsonDataForAttr,
} from "./concerns/json-data.ts";
import type { YamlValue } from "./concerns/psych.ts";
import { belongsToRequired, loadBelongsTo, validatesUniqueness, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord, Row } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, connection, selectRows, table } from "./sql.ts";

export type RefundRecord = ModelRecord<Refund>;

export const REFUNDS = "refunds";
// Refund::FRAUD
export const FRAUD = "fraud";
// Refund::MAX_FEE_RETENTION_ATTEMPTS: one week of hourly runs.
export const MAX_FEE_RETENTION_ATTEMPTS = 168;

const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};
const PRODUCT: BelongsTo = { name: "product", foreignKey: "link_id", targetTable: "links", targetModel: "Link" };
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

const refundFlags = defineFlags("refunds", { 1: "is_for_fraud" }, { queryMode: "bit_operator" });

// attr_json_data_accessor, in the order the model declares them
export const JSON_DATA_ATTRIBUTES = [
  "note",
  "business_vat_id",
  "debited_stripe_transfer",
  "retained_fee_cents",
  "fee_retention_pending",
  "fee_retention_error",
  "fee_retention_collected_cents",
  "fee_retention_source_transfer",
  "fee_retention_attempts",
  "fee_retention_written_off_cents",
  "fee_retention_written_off_at",
  "fee_retention_write_off_reason",
  "fee_retention_write_off_transaction_id",
  "presentment_currency",
  "presentment_amount_cents",
  "presentment_price_cents",
  "presentment_tip_cents",
  "presentment_seller_tax_cents",
  "presentment_gumroad_tax_cents",
  "presentment_shipping_cents",
  "presentment_settled_currency",
  "presentment_settled_amount_cents",
  "gumroad_funded",
  "balance_reconciliation_needed",
  "balance_reversed_on_failure",
  "balance_reversed_on_failure_at",
  "paypal_refund_unreadable_at",
  "paypal_refund_unreadable_issue",
] as const;

// `refund.<attr>` of an attr_json_data_accessor (nil when blank). Reading it makes Rails rewrite a NULL json_data as `{}`.
export const refundJsonAttr = (refund: RefundRecord, attribute: (typeof JSON_DATA_ATTRIBUTES)[number]): YamlValue =>
  storedJsonAttr(refund, attribute);

// Refund#sync_fee_retention_recoverable
function syncFeeRetentionRecoverable(refund: RefundRecord): void {
  if (!isBlank(refundJsonAttr(refund, "fee_retention_written_off_at") as never))
    setJsonDataForAttr(refund, "fee_retention_pending", false);
  const exhausted = rubyToI(refundJsonAttr(refund, "fee_retention_attempts")) >= MAX_FEE_RETENTION_ATTEMPTS;
  refund.set("fee_retention_recoverable", refundJsonAttr(refund, "fee_retention_pending") === true && !exhausted);
}

// assign_product / assign_seller: `self.link_id = purchase.link_id`
async function assignFromPurchase(refund: RefundRecord, target: "link_id" | "seller_id"): Promise<void> {
  const purchase = await loadBelongsTo(refund, PURCHASE, { tx: (await connection()) as never });
  if (purchase === null) throw new TypeError(`undefined method '${target}' for nil`);
  refund.set(target, purchase[target] as never);
}

const uniqueProcessorRefundId = validatesUniqueness<Refund>("Refund", "refunds", "processor_refund_id", {
  scope: ["link_id"],
});

export const Refunds = defineModel<Refund>({
  rubyClass: "Refund",
  prismaModel: "Refund",
  delegate: (tx) => tx.refund as never,
  beforeValidation: [
    { name: "assign_product", on: "create", run: (refund) => assignFromPurchase(refund, "link_id") },
    { name: "assign_seller", on: "create", run: (refund) => assignFromPurchase(refund, "seller_id") },
  ],
  validations: [
    belongsToRequired<Refund>(PURCHASE),
    belongsToRequired<Refund>(PRODUCT),
    belongsToRequired<Refund>(SELLER),
    // allow_blank: true
    { ...uniqueProcessorRefundId, if: (refund) => !isBlank(refund.get("processor_refund_id")) },
  ],
  // JsonData is included before the model's own callbacks, so the merge runs first.
  beforeSave: [
    mergeJsonDataWithCurrentRow<Refund>("refunds"),
    { name: "sync_fee_retention_recoverable", run: syncFeeRetentionRecoverable },
  ],
});

// `refund.<name> = value` for a column, the is_for_fraud flag or an attr_json_data_accessor
export function assignRefundAttribute(refund: RefundRecord, name: string, value: unknown): void {
  if (name === "is_for_fraud") {
    refund.set("flags", refundFlags.set(refund.get("flags") as bigint | null, "is_for_fraud", value === true) as never);
  } else if ((JSON_DATA_ATTRIBUTES as readonly string[]).includes(name)) {
    setJsonDataForAttr(refund, name, value as YamlValue);
  } else {
    refund.set(name as keyof Refund, value as never);
  }
}

// `purchase.refunds << refund` for a persisted purchase: the refund is saved with validations inside a transaction, and one that is not
// valid rolls the transaction back (ActiveRecord::Rollback, swallowed) and answers nil instead of raising.
export function appendRefund<P extends Row>(
  purchase: ModelRecord<P>,
  refund: RefundRecord,
  options: SaveOptions = {},
): Promise<boolean> {
  assignBelongsTo(refund, PURCHASE, purchase);
  return transaction(() => Refunds.save(refund, options), { returningStatus: true });
}

// refund.purchase (a belongs_to, loaded once per record)
export async function purchaseOf(refund: RefundRecord): Promise<Purchase | null> {
  return (await loadBelongsTo(refund, PURCHASE, { tx: (await connection()) as never })) as Purchase | null;
}

// ExternalId#external_id
export const externalId = (id: bigint | number): string => encrypt(id);

// JsonData#json_data: `serialize :json_data, coder: JSON`, nil as {}.
export function jsonData(record: RefundRecord): Record<string, unknown> {
  const raw = record.get("json_data");
  if (raw == null || isBlank(raw)) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json_data must be a hash");
  return parsed as Record<string, unknown>;
}

// JsonData#json_data_for_attr / attr_json_data_reader: the value when present?, else nil.
export function jsonDataForAttr(record: RefundRecord, attribute: string): unknown {
  const value = jsonData(record)[attribute];
  return isBlank(value) ? null : value;
}

// Object#to_i for what a JSON value can hold.
export function rubyToI(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(value);
    return match ? Number(match[1]!.replaceAll("_", "")) : 0;
  }
  const described = Array.isArray(value)
    ? "an instance of Array"
    : typeof value === "object"
      ? "an instance of Hash"
      : String(value);
  throw new TypeError(`undefined method 'to_i' for ${described}`);
}

// Refund#retained_fee_cents.to_i
export const retainedFeeCents = (record: RefundRecord): number =>
  rubyToI(jsonDataForAttr(record, "retained_fee_cents"));

// scope :pending_fee_retention, as the `where` of a `findInBatches(REFUNDS, ...)`.
export const pendingFeeRetention = () => Prisma.sql`${column(REFUNDS, "fee_retention_recoverable")} = ${true}`;

// `Credit.where(fee_retention_refund: refund).failed_refund_fee_reversals.exists?`
export async function failedRefundFeeReversalExists(refundId: bigint | number): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("credits")} WHERE ${column("credits", "fee_retention_refund_id")} = ${refundId} AND ${column("credits", "failed_refund_id")} IS NOT NULL LIMIT 1`,
  );
  return rows.length > 0;
}
