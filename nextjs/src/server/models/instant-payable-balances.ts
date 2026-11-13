// Port of User#instantly_payable_unpaid_balances (app/modules/user/money_balance.rb) and
// StripePayoutProcessor.instantly_payable_amount_cents_on_stripe: the unpaid balances an instant payout can claim, cut at the first date
// the seller's instant-available Stripe balance cannot cover once the 3% fee is added. Golden: scripts/golden/payouts-instant-balances.rb.
//
// Every balance loads its own merchant account (and that account its user) in each pass, as in Rails: the statements are held to the
// golden one for one. A Stripe error on the balance read propagates, as it does in Ruby. A balance that names no account, or an account
// whose holder Node cannot name (PayPal), is refused with NotPortedError where Ruby would raise or answer. The result is sorted by date
// stably; Ruby's sort_by is not stable, so balances sharing a date can come back in another order (the caller re-sorts by created_at and
// refuses ties there).
import { Prisma, type Balance as BalanceRow } from "@prisma/client";

import { Balance } from "../stripe/resources.ts";

import { Balances, type BalanceRecord } from "./balance.ts";
import { activeBankAccount, todayOf } from "./instant-payouts-supported.ts";
import { HOLDER_OF_FUNDS } from "./merchant-account.ts";
import { dateString, holdOf, unpaidBalancesUpTo, type HeldBalance } from "./payout-reads.ts";
import { INSTANT_PAYOUT_FEE_PERCENT } from "./payouts.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError, type UserRecord } from "./user.ts";

const PROCESSOR_REF =
  "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb instantly_payable_amount_cents_on_stripe";
const EXPAND = "instant_available.net_available";

type NetAvailable = { destination?: unknown; amount?: unknown };
type InstantAvailable = { net_available?: unknown };

const holdingCents = (balance: BalanceRecord) => Number(balance.get("holding_amount_cents") ?? 0);
// `sum(&:holding_amount_cents)` raises on a nil.
export function summedHoldingCents(balances: BalanceRecord[]): number {
  return balances.reduce((total, balance) => {
    if (balance.get("holding_amount_cents") == null)
      throw new NotPortedError("a balance without a holding amount", PROCESSOR_REF);
    return total + holdingCents(balance);
  }, 0);
}
const dateOf = (balance: BalanceRecord) => balance.get("date") as unknown as Date;
const byDate = (a: BalanceRecord, b: BalanceRecord) => dateOf(a).getTime() - dateOf(b).getTime();

// `StripePayoutProcessor.instantly_payable_amount_cents_on_stripe(user)`
export async function instantlyPayableAmountCentsOnStripe(user: UserRecord): Promise<number> {
  const bank = await activeBankAccount(user);
  if (bank === null) return 0;
  const accountId = bank.stripe_connect_account_id;
  const externalAccountId = bank.stripe_bank_account_id;
  if (accountId == null || String(accountId).trim() === "" || externalAccountId == null)
    throw new NotPortedError("a bank account without its Stripe ids", PROCESSOR_REF);
  const balance = (await Balance.retrieve({ expand: [EXPAND] }, { stripeAccount: String(accountId) })) as {
    instant_available?: unknown;
  };
  const first = Array.isArray(balance.instant_available)
    ? (balance.instant_available[0] as InstantAvailable | undefined)
    : undefined;
  const net = first?.net_available;
  if (!Array.isArray(net)) return 0;
  const entry = (net as NetAvailable[]).find((candidate) => candidate.destination === externalAccountId);
  const amount = entry?.amount;
  return amount == null || amount === false ? 0 : Number(amount);
}

// `unpaid_balances_up_to_date(date).where("date < ?", before)`
async function unpaidBalancesBefore(user: UserRecord, date: Date, before: Date): Promise<BalanceRecord[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid' AND (date <= ${dateString(date)}) AND (date < ${dateString(before)})`,
  );
  return rows.map((row) => Balances.load(castRow<BalanceRow>("Balance", row)));
}

async function heldBy(balances: BalanceRecord[]): Promise<HeldBalance[]> {
  const held: HeldBalance[] = [];
  for (const balance of balances) held.push(await holdOf(balance));
  return held;
}

// `User#instantly_payable_unpaid_balances_up_to_date(date)`
export async function instantlyPayableUnpaidBalancesUpTo(user: UserRecord, date: Date): Promise<BalanceRecord[]> {
  const availableOnStripe = await instantlyPayableAmountCentsOnStripe(user);
  let firstUnpayable: Date | null = null;
  const stripeDates = (await heldBy(await unpaidBalancesUpTo(user, date)))
    .filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE)
    .map((entry) => entry.balance)
    .sort(byDate)
    .map(dateOf);
  for (const day of stripeDates) {
    const heldCents = (await heldBy(await unpaidBalancesUpTo(user, day)))
      .filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE)
      .reduce((total, entry) => total + holdingCents(entry.balance), 0);
    if (Math.floor((heldCents * 100) / (100 + INSTANT_PAYOUT_FEE_PERCENT)) > availableOnStripe) {
      firstUnpayable = day;
      break;
    }
  }
  const payable =
    firstUnpayable === null
      ? await unpaidBalancesUpTo(user, date)
      : await unpaidBalancesBefore(user, date, firstUnpayable);
  return (await heldBy(payable))
    .filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE || entry.holder === HOLDER_OF_FUNDS.GUMROAD)
    .map((entry) => entry.balance)
    .sort(byDate);
}

// `User#instant_payout_pipeline_unpaid_balance_cents`: every unpaid balance Stripe or Gumroad holds, whatever its date. A balance that names
// no account is Ruby's `&.` nil here but refused by `holdOf`, so it is not served.
export async function instantPayoutPipelineUnpaidBalanceCents(user: UserRecord): Promise<number> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`balances`.*")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const balances = rows.map((row) => Balances.load(castRow<BalanceRow>("Balance", row)));
  return summedHoldingCents(
    (await heldBy(balances))
      .filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE || entry.holder === HOLDER_OF_FUNDS.GUMROAD)
      .map((entry) => entry.balance),
  );
}

// `User#instantly_payable_unpaid_balances`
export const instantlyPayableUnpaidBalances = (user: UserRecord, options: SaveOptions = {}) =>
  instantlyPayableUnpaidBalancesUpTo(user, todayOf(options));
