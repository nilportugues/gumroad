// Read side of app/models/refund.rb: what the failed-refund and fee-retention jobs look at. Nothing
// here writes a refunds row; `Refunds` refuses every save, so a port that reaches one hands the job
// back to Rails (Refund's callbacks, `with_lock` writes and the Stripe fee-retention calls are Ruby).
// Golden: worker/jobs/__fixtures__/refund-dispute-jobs.golden.json (scripts/golden/refund-dispute-jobs.rb).
import { Prisma, type Purchase, type Refund } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, connection, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export type RefundRecord = ModelRecord<Refund>;

export const REFUNDS = "refunds";
// Refund::FRAUD
export const FRAUD = "fraud";

const refuse = () => {
  throw new NotPortedError("Refund#save", "refund.rb: sync_fee_retention_recoverable, assign_product, assign_seller, JsonData merge");
};

export const Refunds = defineModel<Refund>({
  rubyClass: "Refund",
  prismaModel: "Refund",
  delegate: (tx) => tx.refund as never,
  beforeValidation: [{ name: "refuse writes", run: refuse }],
  beforeSave: [{ name: "refuse writes", run: refuse }],
});

const PURCHASE: BelongsTo = { name: "purchase", foreignKey: "purchase_id", targetTable: "purchases", targetModel: "Purchase" };

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
  const described = Array.isArray(value) ? "an instance of Array" : typeof value === "object" ? "an instance of Hash" : String(value);
  throw new TypeError(`undefined method 'to_i' for ${described}`);
}

// Refund#retained_fee_cents.to_i
export const retainedFeeCents = (record: RefundRecord): number => rubyToI(jsonDataForAttr(record, "retained_fee_cents"));

// scope :pending_fee_retention, as the `where` of a `findInBatches(REFUNDS, ...)`.
export const pendingFeeRetention = () => Prisma.sql`${column(REFUNDS, "fee_retention_recoverable")} = ${true}`;

// `Credit.where(fee_retention_refund: refund).failed_refund_fee_reversals.exists?`
export async function failedRefundFeeReversalExists(refundId: bigint | number): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("credits")} WHERE ${column("credits", "fee_retention_refund_id")} = ${refundId} AND ${column("credits", "failed_refund_id")} IS NOT NULL LIMIT 1`,
  );
  return rows.length > 0;
}
