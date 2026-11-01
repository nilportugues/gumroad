// Port of app/models/backtax_collection.rb and the BacktaxAgreement readers the backtax recovery
// job uses (`has_one :credit`, `has_many :backtax_collections`, `update!(collected: true)`).
// Golden: worker/jobs/__fixtures__/money-jobs.golden.json.
import { Prisma, type BacktaxAgreement, type BacktaxCollection, type Credit } from "@prisma/client";

import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { BACKTAX_AGREEMENTS, BACKTAX_JURISDICTIONS, BacktaxAgreementFlags, BacktaxAgreements } from "./backtax-agreement.ts";
import { Credits, type CreditRecord } from "./credit.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import type { UserRecord } from "./user.ts";

export type BacktaxAgreementRecord = ModelRecord<BacktaxAgreement>;

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const BACKTAX_AGREEMENT: BelongsTo = { name: "backtax_agreement", foreignKey: "backtax_agreement_id", targetTable: "backtax_agreements", targetModel: "BacktaxAgreement" };

export const BacktaxCollections = defineModel<BacktaxCollection>({
  rubyClass: "BacktaxCollection",
  prismaModel: "BacktaxCollection",
  delegate: (tx) => tx.backtaxCollection as never,
  validations: [belongsToRequired<BacktaxCollection>(USER), belongsToRequired<BacktaxCollection>(BACKTAX_AGREEMENT)],
});

// BacktaxCollection.create!(user:, backtax_agreement:, ...)
export async function createBacktaxCollectionBang(
  attributes: { user: UserRecord; backtaxAgreement: BacktaxAgreementRecord; amountCents: number; amountCentsUsd: number; currency: string; stripeTransferId: string | null },
  options?: SaveOptions,
) {
  const collection = BacktaxCollections.build({
    amount_cents: attributes.amountCents,
    amount_cents_usd: attributes.amountCentsUsd,
    currency: attributes.currency,
    stripe_transfer_id: attributes.stripeTransferId,
  });
  assignBelongsTo(collection, USER, attributes.user);
  assignBelongsTo(collection, BACKTAX_AGREEMENT, attributes.backtaxAgreement);
  return BacktaxCollections.saveBang(collection, options);
}

// user.australia_backtax_agreement
// A has_many reader sets the inverse, so the agreement's own `user` is this user.
export async function australiaBacktaxAgreementOf(user: UserRecord): Promise<BacktaxAgreementRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`backtax_agreements`.*")} FROM ${table(BACKTAX_AGREEMENTS)} WHERE ${column(BACKTAX_AGREEMENTS, "user_id")} = ${user.get("id")} AND ${column(BACKTAX_AGREEMENTS, "jurisdiction")} = ${BACKTAX_JURISDICTIONS.AUSTRALIA} ORDER BY ${column(BACKTAX_AGREEMENTS, "id")} ASC LIMIT 1`,
  );
  if (!row) return null;
  const agreement = BacktaxAgreements.load(castRow<BacktaxAgreement>("BacktaxAgreement", row));
  assignBelongsTo(agreement, USER, user);
  return agreement;
}

export const isCollected = (agreement: BacktaxAgreementRecord) => BacktaxAgreementFlags.isSet(agreement.get("flags"), "collected");

// agreement.credit: `has_one`, so the credit's own backtax_agreement is this record (automatic inverse_of).
export async function creditOfBacktaxAgreement(agreement: BacktaxAgreementRecord): Promise<CreditRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`credits`.*")} FROM ${table("credits")} WHERE ${column("credits", "backtax_agreement_id")} = ${agreement.get("id")} LIMIT 1`,
  );
  if (!row) return null;
  const credit = Credits.load(castRow<Credit>("Credit", row));
  assignBelongsTo(credit, BACKTAX_AGREEMENT, agreement);
  return credit;
}

export const backtaxAgreementOfCredit = (credit: CreditRecord) => readBelongsTo(credit, BACKTAX_AGREEMENT, BacktaxAgreements);

// agreement.backtax_collections.size
export async function backtaxCollectionsSize(agreement: BacktaxAgreementRecord): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("backtax_collections")} WHERE ${column("backtax_collections", "backtax_agreement_id")} = ${agreement.get("id")}`,
  );
  return Number(Object.values(row!)[0]);
}

// agreement.backtax_collections.sum(:amount_cents_usd)
export async function backtaxCollectionsAmountCentsUsd(agreement: BacktaxAgreementRecord): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("backtax_collections", "amount_cents_usd")}) FROM ${table("backtax_collections")} WHERE ${column("backtax_collections", "backtax_agreement_id")} = ${agreement.get("id")}`,
  );
  const sum = Object.values(row!)[0];
  return sum == null ? 0 : Number(sum);
}

// agreement.update!(collected: true)
export async function markCollectedBang(agreement: BacktaxAgreementRecord, options?: SaveOptions) {
  agreement.set("flags", BacktaxAgreementFlags.set(agreement.get("flags"), "collected", true));
  return BacktaxAgreements.saveBang(agreement, options);
}
