// Port of app/models/balance.rb with Balance::RefundEligibilityUnderwriter, for what the money
// flows do to a balance: create, change the amounts under a lock, and the after-commit refund
// eligibility check. The state machine's events are not ported (nothing here moves a balance out
// of `unpaid`). Golden: worker/jobs/__fixtures__/money-jobs.golden.json.
import type { Balance } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";
import { assignBelongsTo, readBelongsTo } from "./concerns/belongs-to-record.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { HOLDER_OF_FUNDS, holderOfFunds, MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { isFlagSet, isOnProbation, Users, type UserRecord } from "./user.ts";

export type BalanceRecord = ModelRecord<Balance>;

export const BALANCE_STATES = ["unpaid", "processing", "paid", "forfeited"] as const;
export const USD = "usd";

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const MERCHANT_ACCOUNT: BelongsTo = { name: "merchant_account", foreignKey: "merchant_account_id", targetTable: "merchant_accounts", targetModel: "MerchantAccount" };

export const balanceUser = (balance: BalanceRecord) => readBelongsTo(balance, USER, Users);
export const balanceMerchantAccount = (balance: BalanceRecord) => readBelongsTo(balance, MERCHANT_ACCOUNT, MerchantAccounts);
export const assignBalanceUser = (balance: BalanceRecord, user: UserRecord) => assignBelongsTo(balance, USER, user);
export const assignBalanceMerchantAccount = (balance: BalanceRecord, account: MerchantAccountRecord) => assignBelongsTo(balance, MERCHANT_ACCOUNT, account);

const isUnpaid = (balance: BalanceRecord) => balance.get("state") === "unpaid";

// `merchant_account&.holder_of_funds == HolderOfFunds::GUMROAD`
async function isGumroadHeld(balance: BalanceRecord): Promise<boolean> {
  const account = await balanceMerchantAccount(balance);
  return account !== null && (await holderOfFunds(account)) === HOLDER_OF_FUNDS.GUMROAD;
}

const isCanonicalUsd = (balance: BalanceRecord) => String(balance.get("currency")) === USD && String(balance.get("holding_currency")) === USD;

// Rails' user.refunds_disabled? / on_probation? and `UpdateSellerRefundEligibilityJob.perform_async`.
async function updateSellerRefundEligibility(balance: BalanceRecord): Promise<void> {
  const userId = balance.get("user_id");
  if (userId == null) return;
  // anticipate_refund_eligibility_changes?
  if (!balance.savedChangeTo("amount_cents")) return;
  const before = balance.attributeBeforeLastSave("amount_cents") ?? 0;
  const after = balance.get("amount_cents") as number;
  const user = await balanceUser(balance);
  if (user === null) throw new TypeError("undefined method 'refunds_disabled?' for nil");
  const increased = before < after;
  const decreased = before > after;
  const refundsDisabled = isFlagSet(user, "refunds_disabled");
  if ((increased && (refundsDisabled || isOnProbation(user))) || (decreased && !refundsDisabled)) await performAsync("UpdateSellerRefundEligibilityJob", [Number(userId)]);
}

export const Balances = defineModel<Balance>({
  rubyClass: "Balance",
  prismaModel: "Balance",
  delegate: (tx) => tx.balance as never,
  validations: [
    validatesAssociationPresence<Balance>(MERCHANT_ACCOUNT),
    validatesPresenceOf<Balance>(["currency", "holding_currency"]),
    {
      name: "validate_amounts_are_only_changed_when_unpaid",
      on: "update",
      run(balance) {
        if (isUnpaid(balance)) return;
        for (const field of ["amount_cents", "holding_amount_cents"] as const) {
          if (balance.attributeChanged(field)) balance.errors.add(field, `may not be changed in ${String(balance.get("state"))} state.`);
        }
      },
    },
    {
      name: "validate_gumroad_held_relabel_is_canonical_usd",
      on: "update",
      if: (balance) => balance.attributeChanged("currency") || balance.attributeChanged("holding_currency"),
      async run(balance) {
        if (!(await isGumroadHeld(balance))) return;
        if (!isCanonicalUsd(balance)) balance.errors.add("holding_currency", "must be usd, as must currency, on a Gumroad-held balance");
        // Label-only: an amount correction has to be its own save.
        if (balance.attributeChanged("amount_cents") || balance.attributeChanged("holding_amount_cents")) balance.errors.add("base", "a Gumroad-held relabel may not change amounts");
        if (balance.get("holding_amount_cents") !== balance.get("amount_cents")) balance.errors.add("holding_amount_cents", "must equal amount_cents on a Gumroad-held balance");
      },
    },
    // state_machine(:state) declares `state any { validates_presence_of :amount_cents }` after them.
    validatesPresenceOf<Balance>(["amount_cents"]),
  ],
  afterCreate: [
    {
      // Runs inside the insert: a notifier failure must not roll back a ledger write.
      name: "report_non_usd_gumroad_held_balance",
      async run(balance) {
        if (!(await isGumroadHeld(balance)) || isCanonicalUsd(balance)) return;
        notifyError("Non-USD Gumroad-held balance created; its payouts will fail with currency_mismatch", {
          balance_id: balance.get("id"),
          merchant_account_id: balance.get("merchant_account_id"),
          currency: balance.get("currency"),
          holding_currency: balance.get("holding_currency"),
        });
      },
    },
  ],
  afterCommit: [{ name: "update_seller_refund_eligibility", run: updateSellerRefundEligibility }],
});

// Balance.create!(user:, merchant_account:, currency:, holding_currency:, date:)
export async function createBalanceBang(
  attributes: { user: UserRecord; merchantAccount: MerchantAccountRecord; currency: string; holdingCurrency: string; date: Date },
  options?: SaveOptions,
) {
  const balance = Balances.build({ state: "unpaid", currency: attributes.currency, holding_currency: attributes.holdingCurrency, date: attributes.date });
  assignBalanceUser(balance, attributes.user);
  assignBalanceMerchantAccount(balance, attributes.merchantAccount);
  return Balances.saveBang(balance, options);
}
