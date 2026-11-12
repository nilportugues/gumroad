// Port of User#instant_payouts_supported? (app/models/user.rb): compliance, pause, a completed payout, the seasoning of every account a
// payout could resolve to, the legal entity's country, and the one Stripe read of the bank account's payout methods. Golden:
// scripts/golden/payouts-instant-supported.rb.
//
// Refused with NotPortedError, from rows already read and before the Stripe read: everything payout-reads.ts refuses (Connect routing,
// a retired or foreign-currency Stripe-held balance, a destination taken from a balance's own account). A Stripe read that fails with a
// StripeError answers false, as in Ruby; a payout-methods answer without the list is refused (Ruby raises NoMethodError there).
import { Prisma, type BankAccount } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";
import { StripeError } from "../stripe/errors.ts";
import { Account } from "../stripe/resources.ts";

import { balanceMerchantAccount, assignBalanceMerchantAccount, type BalanceRecord } from "./balance.ts";
import {
  holderOfFunds,
  HOLDER_OF_FUNDS,
  isStripeConnectAccount,
  MerchantAccounts,
  STRIPE_CHARGE_PROCESSOR_ID,
  type MerchantAccountRow,
} from "./merchant-account.ts";
import {
  aliveUserComplianceInfo,
  destinationMerchantAccount,
  isBalancePayable,
  sharedJsonDataForAccount,
  unpaidBalancesUpTo,
  type HeldBalance,
} from "./payout-reads.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, columnIn, selectRows, table } from "./sql.ts";
import { legalEntityCountryCode } from "./user-compliance-info.ts";
import { isCompliant, isPayoutsPaused, NotPortedError, type UserRecord } from "./user.ts";

const USER_REF = "app/models/user.rb instant_payouts_supported?";
const DAY_MS = 24 * 60 * 60 * 1000;
// User::MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS
const MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS_MS = 60 * DAY_MS;
const INSTANT = "instant";
const REQUIRED_COUNTRY = "US";
// BankAccount::STALE_EXTERNAL_ACCOUNT_MESSAGES
const STALE_EXTERNAL_ACCOUNT_MESSAGES = [/has been deleted and can no longer be used/u, /No such external account/u];

const clock = (options: SaveOptions) => (options.now ?? (() => new Date()))();
// `Date.today`
export const todayOf = (options: SaveOptions) => new Date(`${clock(options).toISOString().slice(0, 10)}T00:00:00Z`);

type Row = Record<string, unknown>;
const present = (value: unknown) => value != null && String(value).trim() !== "";
const timeOf = (value: unknown) => (value instanceof Date ? value.getTime() : Date.parse(String(value)));

export const isAccountActive = (account: Row) =>
  account.deleted_at == null &&
  present(account.charge_processor_alive_at) &&
  account.charge_processor_deleted_at == null;

// `user.bank_accounts.alive.first`
export async function activeBankAccount(user: UserRecord): Promise<BankAccount | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`bank_accounts`.*")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${user.get("id")} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC LIMIT 1`,
  );
  return row ? castRow<BankAccount>("BankAccount", row) : null;
}

// `unpaid_balances_up_to_date(date).includes(:merchant_account)`: the balances, then one read of the accounts they name. Balances that
// name the same account share one record, so its user is read once.
export async function unpaidBalancesWithAccounts(user: UserRecord, date: Date): Promise<BalanceRecord[]> {
  const balances = await unpaidBalancesUpTo(user, date);
  const ids = [
    ...new Set(balances.map((balance) => balance.get("merchant_account_id")).filter((id) => id != null)),
  ] as unknown[];
  if (ids.length === 0) return balances;
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${columnIn("merchant_accounts", "id", ids)}`,
  );
  const accounts = new Map(
    rows.map((row) => [String(row.id), MerchantAccounts.load(castRow("MerchantAccount", row))] as const),
  );
  for (const balance of balances) {
    const account = accounts.get(String(balance.get("merchant_account_id")));
    if (account) assignBalanceMerchantAccount(balance, account);
  }
  return balances;
}

// `User#stripe_held_unpaid_balances`
async function stripeHeldUnpaidBalances(user: UserRecord, options: SaveOptions): Promise<HeldBalance[]> {
  const held: HeldBalance[] = [];
  for (const balance of await unpaidBalancesWithAccounts(user, todayOf(options))) {
    const account = await balanceMerchantAccount(balance);
    if (account === null) continue;
    const holder = await holderOfFunds(account);
    const entry = { balance, account, holder };
    if (holder === HOLDER_OF_FUNDS.STRIPE && isBalancePayable(entry)) held.push(entry);
  }
  return held;
}

// `merchant_accounts.stripe.any? { ... }`: an earlier account of the same kind that actually carried money.
async function hasSeasonedPredecessor(user: UserRecord, account: MerchantAccountRow, cutoff: number): Promise<boolean> {
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID}`,
  );
  return rows.some(
    (predecessor) =>
      timeOf(predecessor.created_at) <= cutoff &&
      isStripeConnectAccount(predecessor as unknown as MerchantAccountRow) === isStripeConnectAccount(account) &&
      !String(
        sharedJsonDataForAccount(predecessor as unknown as MerchantAccountRow, "stripe_disabled_reason") ?? "",
      ).startsWith("rejected.") &&
      (present(predecessor.charge_processor_deleted_at) || present(predecessor.charge_processor_alive_at)),
  );
}

// `stripe_accounts_seasoned_for_instant_payouts?`
async function stripeAccountsSeasoned(user: UserRecord, options: SaveOptions): Promise<boolean> {
  const destinations: MerchantAccountRow[] = [];
  const own = await destinationMerchantAccount(user, []);
  if (own) destinations.push(own);
  const withHeld = await destinationMerchantAccount(user, await stripeHeldUnpaidBalances(user, options));
  if (withHeld && !destinations.some((account) => String(account.id) === String(withHeld.id)))
    destinations.push(withHeld);
  if (destinations.length === 0) return false;
  const cutoff = clock(options).getTime() - MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS_MS;
  for (const account of destinations) {
    if (!isAccountActive(account as unknown as Row)) return false;
    if (timeOf((account as unknown as Row).created_at) <= cutoff) continue;
    if (!(await hasSeasonedPredecessor(user, account, cutoff))) return false;
  }
  return true;
}

// `User#eligible_for_instant_payouts?`
export async function eligibleForInstantPayouts(user: UserRecord, options: SaveOptions = {}): Promise<boolean> {
  if (!isCompliant(user) || isPayoutsPaused(user)) return false;
  const [completed] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("payments")} WHERE ${column("payments", "user_id")} = ${user.get("id")} AND ${column("payments", "state")} = 'completed' LIMIT 1`,
  );
  if (!completed) return false;
  if (!(await stripeAccountsSeasoned(user, options))) return false;
  const info = await aliveUserComplianceInfo(user);
  return info !== null && legalEntityCountryCode(info) === REQUIRED_COUNTRY;
}

// `BankAccount#supports_instant_payouts?`
async function bankAccountSupportsInstantPayouts(bank: BankAccount): Promise<boolean> {
  const accountId = bank.stripe_connect_account_id;
  const externalAccountId = bank.stripe_bank_account_id;
  if (!present(accountId) || !present(externalAccountId)) return false;
  try {
    const external = (await Account.retrieveExternalAccount(accountId, externalAccountId)) as {
      available_payout_methods?: unknown;
    };
    if (!Array.isArray(external.available_payout_methods))
      throw new NotPortedError("an external account answered without its payout methods", USER_REF);
    return external.available_payout_methods.includes(INSTANT);
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (!STALE_EXTERNAL_ACCOUNT_MESSAGES.some((pattern) => pattern.test(error.message))) notifyError(error);
    return false;
  }
}

// `User#instant_payouts_supported?`
export async function instantPayoutsSupported(user: UserRecord, options: SaveOptions = {}): Promise<boolean> {
  if (!(await eligibleForInstantPayouts(user, options))) return false;
  const bank = await activeBankAccount(user);
  return bank === null ? false : bankAccountSupportsInstantPayouts(bank);
}
