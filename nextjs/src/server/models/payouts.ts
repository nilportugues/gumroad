// Port of Payouts.create_payments (app/business/payments/payouts/payouts.rb) for the Stripe processor, one slice at a time:
// the claim under the seller lock, the payout groups, the withheld-ledger hold and its note. Golden:
// scripts/golden/payouts-create-payments.rb.
//
// Refused with NotPortedError, from what the lock and the reads already returned and before any write: a seller whose payouts a
// chargeback-rate hold may pay at 75% (the reserve), `retrying`, and everything payout-reads.ts refuses. A payout whose
// groups Rails would split, release or reserve against a debt is refused before the first claim, from the unpaid balances
// already read; `MultiplePayoutGroupsError` is refused the same way.
import { createHash } from "node:crypto";

import { Prisma, type Comment } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { Balances, fireBalanceEventBang, type BalanceRecord } from "./balance.ts";
import { Comments, COMMENT_TYPES, alive, commentsOf, withType } from "./comment.ts";
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import {
  jsonData,
  jsonGet,
  jsonDataForAttr as recordJsonDataForAttr,
  setJsonDataForAttr as setRecordJsonDataForAttr,
} from "./concerns/json-data.ts";
import { RubyHash } from "./concerns/psych.ts";
import { rubyJsonGenerate } from "./concerns/serialized-columns.ts";
import { gumroadAdminId } from "./gumroad-admin-id.ts";
import { HOLDER_OF_FUNDS } from "./merchant-account.ts";
import {
  holdOf,
  getPayoutDetails,
  unpaidBalancesUpTo,
  minimumPayoutAmountCents,
  payableBalancesForProcessor,
  type HeldBalance,
  type PayoutDetails,
} from "./payout-reads.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, columnIn, selectRows, table } from "./sql.ts";
import { isFlagSet, jsonDataForAttr, NotPortedError, Users, type UserRecord } from "./user.ts";

export const PAYOUT_TYPE_STANDARD = "standard";
export const PAYOUT_TYPE_INSTANT = "instant";
// StripePayoutProcessor::MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS
export const MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS = 1_00;
const PAYOUT_PAUSE_SOURCE_SYSTEM = "system";

export type PayoutType = typeof PAYOUT_TYPE_STANDARD | typeof PAYOUT_TYPE_INSTANT;
export type Claim = { balances: BalanceRecord[]; underReserve: boolean };

// `payout_minimum_cents`
export const payoutMinimumCents = (user: UserRecord, payoutType: PayoutType) =>
  payoutType === PAYOUT_TYPE_INSTANT
    ? Promise.resolve(MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS)
    : minimumPayoutAmountCents(user);

// `under_chargeback_rate_reserve?` is true only for a seller paused by the system; whether that pause is the chargeback-rate hold
// is read from a comment, so such a seller is refused instead.
function refuseChargebackRateReserve(user: UserRecord, payoutType: PayoutType): void {
  if (payoutType === PAYOUT_TYPE_INSTANT || isFlagSet(user, "payouts_paused_by_user")) return;
  if (
    isFlagSet(user, "payouts_paused_internally") &&
    jsonDataForAttr(user, "payouts_paused_by") === PAYOUT_PAUSE_SOURCE_SYSTEM
  )
    throw new NotPortedError(
      "a payout for a seller paused by the system (chargeback-rate reserve)",
      "app/business/payments/payouts/payouts.rb under_chargeback_rate_reserve?",
    );
}

const isPaused = (user: UserRecord) =>
  isFlagSet(user, "payouts_paused_internally") || isFlagSet(user, "payouts_paused_by_user");

// `select_and_claim_payable_balances`: each payable balance is locked, and claimed only if it is still unpaid.
export async function selectAndClaimPayableBalances(
  user: UserRecord,
  date: Date,
  payoutType: PayoutType,
  options: SaveOptions,
  singleGroup = false,
): Promise<BalanceRecord[]> {
  const unpaid = await unpaidBalancesUpTo(user, date);
  const { payable, merchantAccount } = await payableBalancesForProcessor(user, unpaid);
  await payoutMinimumCents(user, payoutType);
  assertPayoutShape(payable, merchantAccount, singleGroup);
  const claimed: BalanceRecord[] = [];
  for (const { balance } of payable) {
    await Balances.withLock(balance, async () => {
      if (balance.get("state") !== "unpaid") return;
      await fireBalanceEventBang(balance, "mark_processing", options);
      claimed.push(balance);
    });
  }
  return claimed;
}

// `mark_balances_processing`, decided under the seller lock.
export function markBalancesProcessing(
  user: UserRecord,
  date: Date,
  payoutType: PayoutType = PAYOUT_TYPE_STANDARD,
  options: SaveOptions = {},
  singleGroup = false,
): Promise<Claim> {
  return Users.withLock(user, async () => {
    refuseChargebackRateReserve(user, payoutType);
    if (isPaused(user)) return { balances: [], underReserve: false };
    return {
      balances: await selectAndClaimPayableBalances(user, date, payoutType, options, singleGroup),
      underReserve: false,
    };
  });
}

const LEDGER_HOLD_FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const STRIPE = "STRIPE";
const rubyIso8601 = (time: Date) => time.toISOString().replace(/\.\d+Z$/u, "Z");
const amountOf = (balance: BalanceRecord) => Number(balance.get("amount_cents") ?? 0);
const sumAmounts = (balances: BalanceRecord[]) => balances.reduce((total, balance) => total + amountOf(balance), 0);

export type PayoutGroup = {
  merchantAccount: PayoutDetails["merchantAccount"];
  currency: string | null;
  balances: HeldBalance[];
};

// `StripePayoutProcessor.payout_groups` when no balance is held on a retired account: every Stripe-held group pays through the
// seller's own account, Gumroad-held money joins the group of that account and currency.
export async function payoutGroups(user: UserRecord, held: HeldBalance[]): Promise<PayoutGroup[]> {
  const { merchantAccount, heldByGumroad, heldByStripe } = await getPayoutDetails(user, held);
  return groupHeldBalances(merchantAccount, heldByGumroad, heldByStripe);
}

// The grouping itself, from rows already read.
export function groupHeldBalances(
  merchantAccount: PayoutDetails["merchantAccount"],
  heldByGumroad: HeldBalance[],
  heldByStripe: HeldBalance[],
): PayoutGroup[] {
  const groups = new Map<string, PayoutGroup>();
  for (const entry of heldByStripe) {
    const currency = String(entry.balance.get("holding_currency") ?? "");
    const key = `${String(entry.balance.get("merchant_account_id"))}:${currency}`;
    const group = groups.get(key) ?? { merchantAccount, currency, balances: [] };
    group.balances.push(entry);
    groups.set(key, group);
  }
  if (heldByGumroad.length > 0) {
    if (merchantAccount === null)
      throw new NotPortedError(
        "Gumroad-held money with no account to pay into",
        "stripe_payout_processor.rb payout_groups",
      );
    const currency = String((merchantAccount as unknown as { currency: unknown }).currency ?? "");
    const key = `${String(merchantAccount.id)}:${currency}`;
    const group = groups.get(key);
    if (group) group.balances.push(...heldByGumroad);
    else groups.set(key, { merchantAccount, currency, balances: [...heldByGumroad] });
  }
  return [...groups.values()];
}

const groupSum = (group: PayoutGroup) => sumAmounts(group.balances.map((entry) => entry.balance));

// What Rails would do with a ledger that is not withheld, judged before the first claim from the unpaid balances already read
// (all of which are payable, or the read refused): it splits into several payouts when `single_group` is asked for, and
// releases a group that sums to nothing. Neither was recorded, so both are refused here instead of after the claim.
export function assertPayoutShape(
  payable: HeldBalance[],
  merchantAccount: PayoutDetails["merchantAccount"],
  singleGroup: boolean,
): void {
  if (payable.length === 0) return;
  const heldByGumroad = payable.filter((entry) => entry.holder === HOLDER_OF_FUNDS.GUMROAD);
  const heldByStripe = payable.filter((entry) => entry.holder === HOLDER_OF_FUNDS.STRIPE);
  const groups = groupHeldBalances(merchantAccount, heldByGumroad, heldByStripe);
  const balances = payable.map((entry) => entry.balance);
  if (isNegativeLedger(balances, groups)) return;
  if (groups.some((group) => groupSum(group) <= 0))
    throw new NotPortedError(
      "a payout group that sums to nothing",
      "app/business/payments/payouts/payouts.rb create_payments",
    );
  if (singleGroup && groups.length > 1)
    throw new NotPortedError("MultiplePayoutGroupsError", "app/business/payments/payouts/payouts.rb create_payments");
}

// A negative ledger holds everything: the sum of the unpaid ledger is not positive, or one of its groups is negative. (A debt in
// a currency the account cannot pay out would reserve instead, but a balance in such a currency is refused earlier.)
export function isNegativeLedger(ledger: BalanceRecord[], ledgerGroups: PayoutGroup[]): boolean {
  return sumAmounts(ledger) <= 0 || ledgerGroups.some((group) => groupSum(group) < 0);
}

const holdNoteQuery = (user: UserRecord, prefix: string) =>
  Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${commentsOf("User", user.get("id"))} AND ${withType(COMMENT_TYPES.PAYOUT_NOTE)} AND ${alive} AND ${column("comments", "author_id")} = ${gumroadAdminId()} AND (content LIKE ${`${prefix}%`}) ORDER BY ${column("comments", "created_at")} DESC, ${column("comments", "id")} DESC LIMIT 1`;

// The debit that last made each negative row negative (`t<id>`), else the row itself (`b<id>`).
async function blockingKeys(ledger: BalanceRecord[]): Promise<string[]> {
  const negativeIds = ledger.filter((balance) => amountOf(balance) < 0).map((balance) => balance.get("id"));
  if (negativeIds.length === 0) return ledger.map((balance) => `b${String(balance.get("id"))}`);
  const rows = await selectRows<{ maximum_id: unknown; balance_transactions_balance_id: unknown }>(
    Prisma.sql`SELECT MAX(${column("balance_transactions", "id")}) AS ${Prisma.raw("`maximum_id`")}, ${column("balance_transactions", "balance_id")} AS ${Prisma.raw("`balance_transactions_balance_id`")} FROM ${table("balance_transactions")} WHERE ${columnIn("balance_transactions", "balance_id", negativeIds)} AND (issued_amount_net_cents < 0) GROUP BY ${column("balance_transactions", "balance_id")}`,
  );
  const latest = new Map(rows.map((row) => [String(row.balance_transactions_balance_id), row.maximum_id]));
  return negativeIds.map((id) => (latest.has(String(id)) ? `t${String(latest.get(String(id)))}` : `b${String(id)}`));
}

const noteState = (note: ReturnType<typeof Comments.load>) =>
  String(recordJsonDataForAttr(note, "ledger_hold_notification_state"));

// The `after_all_transactions_commit` of the hold: report once, then mark the note notified (or failed).
async function reportLedgerHold(
  note: ReturnType<typeof Comments.load>,
  report: Record<string, unknown>,
  options: SaveOptions,
) {
  try {
    notifyError("Payout withheld for non-payable ledger", report);
    setRecordJsonDataForAttr(note, "ledger_hold_notification_state", "notified");
    await Comments.saveBang(note, options);
  } catch {
    try {
      setRecordJsonDataForAttr(note, "ledger_hold_notification_state", "failed");
      await Comments.saveBang(note, options);
    } catch {
      // Rails logs the second failure and moves on.
    }
  }
}

// The hold of Payouts.create_payments for a negative ledger: one note per incident, an error report once, the claim undone.
export async function holdNegativeLedger(
  user: UserRecord,
  date: Date,
  ledger: BalanceRecord[],
  claimed: BalanceRecord[],
  options: SaveOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const keys = await blockingKeys(ledger);
  const prefix = `Payout ${STRIPE} withheld for ledger `;
  const [previousRow] = await selectRows(holdNoteQuery(user, prefix));
  const previous = previousRow ? Comments.load(castRow<Comment>("Comment", previousRow)) : null;
  const known =
    previous === null ? [] : ((jsonGet(jsonData(previous), "ledger_hold_debt_keys") as string[] | undefined) ?? []);
  const newKeys = keys.filter((key) => !known.includes(key));
  let note = previous;
  let notify = false;
  if (previous === null || newKeys.length > 0) {
    const incidentKeys = [...new Set([...known, ...keys])].sort();
    const holdKey = createHash("sha256").update(incidentKeys.join(",")).digest("hex").slice(0, 16);
    note = await Comments.createBang(
      {
        commentable_id: user.get("id") as never,
        commentable_type: "User",
        content: `${prefix}${holdKey} because the unpaid ledger is not payable. Reconcile the unpaid balance ledger before retry.`,
        author_id: BigInt(gumroadAdminId() as number),
        comment_type: COMMENT_TYPES.PAYOUT_NOTE,
        json_data: rubyJsonGenerate(
          new RubyHash([
            ["ledger_hold_debt_keys", incidentKeys],
            ["ledger_hold_notification_state", "claimed"],
            ["ledger_hold_claimed_at", rubyIso8601(now())],
            ["seller_visible", false],
          ]),
        ),
      } as never,
      options,
    );
    notify = true;
  } else {
    const state = noteState(previous);
    const claimedAt = recordJsonDataForAttr(previous, "ledger_hold_claimed_at");
    const stale =
      state === "claimed" &&
      claimedAt != null &&
      Date.parse(String(claimedAt)) < now().getTime() - LEDGER_HOLD_FIFTEEN_MINUTES_MS;
    if (state === "failed" || stale)
      throw new NotPortedError(
        "renewing a stale ledger hold note",
        "app/business/payments/payouts/payouts.rb create_payments",
      );
  }
  if (notify) {
    const reported = note!;
    await afterCommitEverywhere(() =>
      reportLedgerHold(
        reported,
        { user_id: user.get("id"), payout_period_end_date: date.toISOString().slice(0, 10), processor_type: STRIPE },
        options,
      ),
    );
  }
  for (const balance of claimed) await fireBalanceEventBang(balance, "mark_unpaid", options);
}

export type CreatePaymentsOptions = {
  payoutType?: PayoutType;
  singleGroup?: boolean;
  retrying?: boolean;
  now?: () => Date;
};

// `Payouts.create_payments`, as far as the held ledger: the claim, the groups, and the hold. Returns the groups a payment is
// still to be made for (none when the ledger was withheld or nothing was payable).
export async function claimPayoutGroups(
  user: UserRecord,
  date: Date,
  input: CreatePaymentsOptions = {},
): Promise<PayoutGroup[]> {
  const payoutType = input.payoutType ?? PAYOUT_TYPE_STANDARD;
  if (input.retrying)
    throw new NotPortedError("a retried payout", "app/business/payments/payouts/payouts.rb create_payments");
  const options: SaveOptions = input.now ? { now: input.now } : {};
  return transaction(async () => {
    const { balances } = await markBalancesProcessing(user, date, payoutType, options, input.singleGroup);
    if (balances.length === 0) return [];
    const claimed: HeldBalance[] = [];
    for (const balance of balances) claimed.push(await holdOf(balance));
    const groups = await payoutGroups(user, claimed);
    const rest = await unpaidBalancesUpTo(user, date);
    if (rest.length > 0)
      throw new NotPortedError(
        "an unpaid balance left outside the claim",
        "app/business/payments/payouts/payouts.rb create_payments",
      );
    const ledger = balances;
    const ledgerGroups = await payoutGroups(user, claimed);
    // The argument `orphan_debt_reserve` is called with, read whether or not a debt is found.
    await payoutMinimumCents(user, payoutType);
    if (isNegativeLedger(ledger, ledgerGroups)) {
      await holdNegativeLedger(user, date, ledger, balances, options);
      return [];
    }
    return groups;
  });
}
