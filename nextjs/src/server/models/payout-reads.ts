// The reads Payouts.create_payments makes before it claims anything, as the real models send them: the seller's unpaid balances up
// to a date, which of them the Stripe processor would pay (`is_balance_payable`, `filter_aggregate_payable_balances`,
// `destination_merchant_account`), and the payout minimum (`User#minimum_payout_amount_cents`). Golden:
// scripts/golden/payouts-create-payments.rb.
//
// Refused with NotPortedError, from rows already read and before anything is written: a Stripe-held balance in a currency other
// than its account's (`pay_out_currency?` would probe Stripe), an account retired by adoption or no longer active, an unpaid
// balance the processor does not claim, a seller with Stripe Connect routing on, a seller with no Gumroad-managed Stripe
// account, a destination account that is not in USD, and a compliance country other than the United States.
import { Prisma, type Balance, type UserComplianceInfo } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";

import { Balances, balanceMerchantAccount, type BalanceRecord } from "./balance.ts";
import { jsonData, jsonDataForAttr as sharedJsonDataForAttr } from "./concerns/json-data.ts";
import {
  HOLDER_OF_FUNDS,
  holderOfFunds,
  stripeAccountOf,
  type MerchantAccountRecord,
  type MerchantAccountRow,
} from "./merchant-account.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { legalEntityCountryCode } from "./user-compliance-info.ts";
import { isFlagSet, jsonDataForAttr, NotPortedError, type UserRecord } from "./user.ts";

export const PAYOUTS_REF = "app/business/payments/payouts/payouts.rb";
const PROCESSOR_REF = "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb";
export const MIN_AMOUNT_CENTS = 100_00;
export const GUMROAD_HELD_USD_MIN_TRANSFER_CENTS = 1_00;
const MERCHANT_MIGRATION_FEATURE = "merchant_migration";
const USD = "usd";
const MINIMUM_THRESHOLD_COUNTRY = "US";

// What the reads ask of the outside world, replaceable in a test. The default reads Flipper.
export type PayoutReadCollaborators = {
  isFeatureEnabled: (name: string, actor: string) => Promise<boolean>;
};
let collaborators: PayoutReadCollaborators = { isFeatureEnabled: (name, actor) => isFeatureEnabled(name, actor) };
export const setPayoutReadCollaborators = (next: PayoutReadCollaborators) => void (collaborators = next);
export const resetPayoutReadCollaborators = () =>
  void (collaborators = { isFeatureEnabled: (name, actor) => isFeatureEnabled(name, actor) });

export const dateString = (date: Date) => date.toISOString().slice(0, 10);

export type HeldBalance = { balance: BalanceRecord; account: MerchantAccountRecord; holder: string };

// `user.unpaid_balances_up_to_date(date).to_a`
export async function unpaidBalancesUpTo(user: UserRecord, date: Date): Promise<BalanceRecord[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid' AND (date <= ${dateString(date)})`,
  );
  return rows.map((row) => Balances.load(castRow<Balance>("Balance", row)));
}

// `balance.merchant_account.holder_of_funds`: each balance loads its own account, and a Gumroad-held one has no user to read.
export async function holdOf(balance: BalanceRecord): Promise<HeldBalance> {
  const account = await balanceMerchantAccount(balance);
  if (account === null) throw new NotPortedError("a balance with no merchant account", PROCESSOR_REF);
  return { balance, account, holder: await holderOfFunds(account) };
}

const retiredByAdoption = (account: MerchantAccountRecord) =>
  !isBlank(sharedJsonDataForAttr(account as never, "retired_by_adoption_at") as string | null);
const isActive = (account: MerchantAccountRecord) =>
  account.get("deleted_at") == null &&
  account.get("charge_processor_alive_at") != null &&
  account.get("charge_processor_deleted_at") == null;

// `StripePayoutProcessor.is_balance_payable`
export function isBalancePayable({ balance, account, holder }: HeldBalance): boolean {
  if (holder === HOLDER_OF_FUNDS.GUMROAD) return true;
  if (holder !== HOLDER_OF_FUNDS.STRIPE) return false;
  if (retiredByAdoption(account) || !isActive(account))
    throw new NotPortedError(
      "a balance held on a retired Stripe account",
      `${PROCESSOR_REF} split_retired_account_groups`,
    );
  const currency = String(balance.get("holding_currency") ?? "");
  if (currency === "") return false;
  if (currency === String(account.get("currency") ?? "")) return true;
  throw new NotPortedError(
    "a balance in a currency its Stripe account does not hold",
    `${PROCESSOR_REF} pay_out_currencies`,
  );
}

// `user.has_stripe_account_connected?`, for a seller it is false for.
export async function assertNoStripeConnect(user: UserRecord): Promise<void> {
  // Rails reads the user's json_data on the way to the feature check, which counts a NULL column as changed.
  if (!isFlagSet(user, "check_merchant_account_is_linked")) {
    const stored = user.get("json_data");
    jsonData(user);
    // The feature check also leaves every attribute materialized in column order unless the read above changed one (a NULL column
    // becomes {}); PaperTrail's `object` of a later save lists them in that order.
    if (stored != null) user.materializeAll();
  }
  if (
    isFlagSet(user, "check_merchant_account_is_linked") ||
    (await collaborators.isFeatureEnabled(MERCHANT_MIGRATION_FEATURE, userActor(user.get("id"))))
  )
    throw new NotPortedError("a seller with Stripe Connect routing", `${PROCESSOR_REF} destination_merchant_account`);
}

// `destination_merchant_account(user, balances_held_by_stripe)` without Connect routing: `user.stripe_account || ...first.merchant_account`.
export async function destinationMerchantAccount(
  user: UserRecord,
  heldByStripe: HeldBalance[],
): Promise<MerchantAccountRow | null> {
  await assertNoStripeConnect(user);
  const own = await stripeAccountOf(user.get("id"));
  if (own !== null) return own;
  if (heldByStripe.length === 0) return null;
  throw new NotPortedError(
    "a payout destination taken from a balance's own account",
    `${PROCESSOR_REF} destination_merchant_account`,
  );
}

export type PayoutDetails = {
  merchantAccount: MerchantAccountRow | null;
  heldByGumroad: HeldBalance[];
  heldByStripe: HeldBalance[];
};

// `get_payout_details(user, balances)`
export async function getPayoutDetails(user: UserRecord, held: HeldBalance[]): Promise<PayoutDetails> {
  const heldByGumroad = held.filter((entry) => entry.holder === HOLDER_OF_FUNDS.GUMROAD);
  const heldByStripe = held.filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE);
  return { merchantAccount: await destinationMerchantAccount(user, heldByStripe), heldByGumroad, heldByStripe };
}

const accountCurrency = (account: MerchantAccountRow) =>
  String((account as unknown as { currency: unknown }).currency ?? "");

// `filter_aggregate_payable_balances`, which only ever drops Gumroad-held money for a destination that is not in USD. Returns the
// destination it read with the balances.
export async function filterAggregatePayableBalances(
  user: UserRecord,
  payable: HeldBalance[],
): Promise<{ payable: HeldBalance[]; merchantAccount: MerchantAccountRow | null }> {
  if (payable.length === 0) return { payable, merchantAccount: null };
  const { merchantAccount } = await getPayoutDetails(user, payable);
  if (merchantAccount === null)
    throw new NotPortedError(
      "a seller with no Gumroad-managed Stripe account",
      `${PROCESSOR_REF} filter_aggregate_payable_balances`,
    );
  if (accountCurrency(merchantAccount) !== USD)
    throw new NotPortedError(
      "a payout destination that is not in USD",
      `${PROCESSOR_REF} filter_aggregate_payable_balances`,
    );
  return { payable, merchantAccount };
}

// `payable_balances_for_processor(user, unpaid, STRIPE)`. A balance the processor would not claim stays in the ledger and
// brings reads Node has not been shown, so it is refused here, after only the reads Rails sends.
export async function payableBalancesForProcessor(user: UserRecord, unpaid: BalanceRecord[]) {
  const held: HeldBalance[] = [];
  for (const balance of unpaid) held.push(await holdOf(balance));
  const payable = held.filter((entry) => isBalancePayable(entry));
  if (payable.length !== held.length)
    throw new NotPortedError(
      "an unpaid balance the Stripe processor does not claim",
      `${PROCESSOR_REF} is_balance_payable`,
    );
  return filterAggregatePayableBalances(user, payable);
}

// User#stripe_rejected_payout_floor_applies?, memoized per instance as in Rails: the merchant account read happens once.
const REJECTED_FLOOR = Symbol("stripe_rejected_payout_floor_applies");
async function stripeRejectedPayoutFloorApplies(user: UserRecord): Promise<boolean> {
  const ivars = user.ivars as Record<symbol, boolean | undefined>;
  if (ivars[REJECTED_FLOOR] !== undefined) return ivars[REJECTED_FLOOR];
  const account = await stripeAccountOf(user.get("id"));
  const disabledReason =
    account === null ? "" : String(sharedJsonDataForAccount(account, "stripe_disabled_reason") ?? "");
  if (disabledReason.startsWith("rejected."))
    throw new NotPortedError(
      "a seller whose Stripe account was rejected",
      "app/models/user.rb stripe_rejected_payout_floor_applies?",
    );
  ivars[REJECTED_FLOOR] = false;
  return false;
}

export function sharedJsonDataForAccount(account: MerchantAccountRow, key: string): unknown {
  const raw = (account as { json_data: unknown }).json_data;
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return undefined;
  const data: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
}

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
export async function aliveUserComplianceInfo(user: UserRecord): Promise<UserComplianceInfo | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`user_compliance_info`.*")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "user_id")} = ${user.get("id")} AND ${column("user_compliance_info", "deleted_at")} IS NULL ORDER BY ${column("user_compliance_info", "id")} DESC LIMIT 1`,
  );
  return row ? castRow<UserComplianceInfo>("UserComplianceInfo", row) : null;
}

// `minimum_payout_threshold_cents`: the larger of the $100 floor and the cross-border minimum of the legal entity's country,
// which is nothing for the United States.
async function minimumPayoutThresholdCents(user: UserRecord): Promise<number> {
  const info = await aliveUserComplianceInfo(user);
  const country = info === null ? null : legalEntityCountryCode(info);
  if (country !== null && country !== MINIMUM_THRESHOLD_COUNTRY)
    throw new NotPortedError(
      "a payout minimum for a country other than the United States",
      "app/models/country.rb min_cross_border_payout_amount_usd_cents",
    );
  return MIN_AMOUNT_CENTS;
}

// `user.minimum_payout_amount_cents`: `payout_threshold_cents` evaluates its default, the threshold, whether or not a value is
// stored, so the compliance info is read once for it and once more for the threshold the `max` takes.
export async function minimumPayoutAmountCents(user: UserRecord): Promise<number> {
  await stripeRejectedPayoutFloorApplies(user);
  const fallback = await minimumPayoutThresholdCents(user);
  const stored = jsonDataForAttr(user, "payout_threshold_cents", fallback);
  const payoutThreshold = typeof stored === "number" ? Math.trunc(stored) : Number.parseInt(String(stored), 10) || 0;
  return Math.max(payoutThreshold, await minimumPayoutThresholdCents(user));
}
