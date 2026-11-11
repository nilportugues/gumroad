// Port of app/sidekiq/alert_on_retired_managed_account_activity_job.rb: rows that landed on a Gumroad-managed Stripe account after a
// Stripe Connect link retired it (balance transactions, charges and the owner's balances created at or after the retirement) are
// reported to the payouts room. A merchant account id Rails would cast from anything but an Integer or its digits, and a retirement
// time that is not a String or whose Ruby error depends on which range check trips first, are handed back before any write.
// Golden: __fixtures__/alert-on-retired-managed-account-activity-job.golden.json
// (scripts/golden/alert-on-retired-managed-account-activity-job.rb).
import { Prisma, type MerchantAccount } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { timeIso8601 } from "../../server/models/concerns/ruby-time-parse.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

// Report at most this many landed rows per leg: the alert exists to be read.
const MAX_REPORTED = 25;

type LandedRow = {
  id: bigint | number;
  created_at: Date;
  state?: string | null;
  amount_cents?: number;
  currency?: string;
};
type Landed = { kind: string; record: LandedRow; createdAt: Date };

// `scope.where("created_at >= ?", retired_at).order(:created_at).limit(MAX_REPORTED + 1)`
async function collect(landed: Landed[], kind: string, tableName: string, owners: Prisma.Sql, retiredAt: Date) {
  const rows = await selectRows<LandedRow>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${owners} AND (created_at >= ${retiredAt}) ORDER BY ${column(tableName, "created_at")} ASC LIMIT ${Prisma.raw(String(MAX_REPORTED + 1))}`,
  );
  for (const record of rows) landed.push({ kind, record, createdAt: record.created_at });
}

// Time#utc.iso8601
const iso8601 = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;

function lineFor({ kind, record, createdAt }: Landed): string {
  const position = `${kind} ${record.id} at ${iso8601(createdAt)}`;
  return kind === "balance"
    ? `• ${position} — ${record.state ?? ""}, ${record.amount_cents ?? ""} ${record.currency ?? ""} cents`
    : `• ${position}`;
}

function messageFor(account: MerchantAccount, retiredAt: Date, landed: Landed[]): string {
  const lines = landed.slice(0, MAX_REPORTED).map(lineFor);
  const truncated = landed.length > lines.length;
  return [
    `${truncated ? "At least " : ""}${landed.length} row${landed.length === 1 ? "" : "s"} landed on ` +
      `Gumroad-managed Stripe account ${account.charge_processor_merchant_id} ` +
      `(merchant account ${account.id}, seller ${account.user_id ?? ""}) after a ` +
      `Stripe Connect link retired it at ${iso8601(retiredAt)}.`,
    "",
    ...lines,
    ...(truncated ? [`…and more, past the ${MAX_REPORTED} this report lists.`] : []),
    "",
    "Retiring the account removed it as a payout destination, so a balance that booked to it " +
      "afterwards cannot be paid out from it. These rows are a sale that was in flight when the " +
      "account was retired or that settled late, or a refund or chargeback that arrived " +
      "afterwards — none of which a check at the switch can order. Check the account's Stripe " +
      "balance before deciding: recovering it needs a payout from the retired account, which is " +
      "a human decision. See gumroad-private#3182.",
  ].join("\n");
}

export const alertOnRetiredManagedAccountActivityJobWith = modelJob({ min: 2 }, async ([accountId, retiredAtIso]) => {
  const id = await beforeSideEffects(() => recordIdFrom(accountId, "MerchantAccount.find_by"));
  const account = await findById<MerchantAccount>("MerchantAccount", id);
  if (account === null) return;
  // MerchantAccount#active?: alive and charge_processor_alive
  if (
    account.deleted_at === null &&
    account.charge_processor_alive_at !== null &&
    account.charge_processor_deleted_at === null
  )
    return;

  if (typeof retiredAtIso !== "string") throw new HandBackToRuby("the retirement time is not a String");
  const retiredAt = await beforeSideEffects(() => timeIso8601(retiredAtIso));

  const landed: Landed[] = [];
  await collect(
    landed,
    "balance_transaction",
    "balance_transactions",
    Prisma.sql`${column("balance_transactions", "merchant_account_id")} = ${account.id}`,
    retiredAt,
  );
  await collect(
    landed,
    "charge",
    "charges",
    Prisma.sql`${column("charges", "merchant_account_id")} = ${account.id}`,
    retiredAt,
  );
  if (account.user_id !== null && account.user_id !== undefined) {
    await collect(
      landed,
      "balance",
      "balances",
      Prisma.sql`${column("balances", "user_id")} = ${account.user_id} AND ${column("balances", "merchant_account_id")} = ${account.id}`,
      retiredAt,
    );
  }
  if (landed.length === 0) return;

  await performAsync("InternalNotificationWorker", [
    "payouts",
    "Activity on a retired Stripe account",
    messageFor(account, retiredAt, landed),
  ]);
});

export const alertOnRetiredManagedAccountActivityJob = alertOnRetiredManagedAccountActivityJobWith();
