// Credit.create_for_balance_change_on_stripe_account! and create_for_bank_debit_on_stripe_account!
// (app/models/credit.rb): a credit, its balance transaction, and the balance it lands on. The
// other create_for_* methods need models that are not ported (Purchase, Refund, Dispute, Payment)
// or mail (notify_user), and are not here.
import { getConfigValue } from "../infra/config.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { getUsdCents } from "./concerns/currency-helper.ts";
import { balanceTransactionBalance, createBalanceTransactionBang, type Amount } from "./balance-transaction.ts";
import { assignCreditCreditingUser, assignCreditMerchantAccount, assignCreditUser, creditMerchantAccount, creditUser, Credits, type CreditRecord } from "./credit.ts";
import { merchantAccountUser, type MerchantAccountRecord } from "./merchant-account.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { findUserBang } from "./user.ts";

const USD = "usd";

// GUMROAD_ADMIN_ID (config/initializers/004_constants.rb)
export const gumroadAdminId = () => getConfigValue("GUMROAD_ADMIN_ID", railsEnv() === "staging" ? 978 : 767082);

// Credit.create_for_balance_change_on_stripe_account!
export async function createForBalanceChangeOnStripeAccountBang(
  attributes: { amountCentsHoldingCurrency: number; merchantAccount: MerchantAccountRecord; amountCentsUsd?: number | null },
  options: SaveOptions = {},
): Promise<CreditRecord> {
  const { merchantAccount, amountCentsHoldingCurrency } = attributes;
  const credit = Credits.build({});
  assignCreditUser(credit, await merchantAccountUser(merchantAccount));
  // `amount_cents_usd.presence`: an Integer is present even when 0.
  const creditAmountCentsUsd = attributes.amountCentsUsd ?? (await getUsdCents(merchantAccount.get("currency") as string, amountCentsHoldingCurrency));
  credit.set("amount_cents", creditAmountCentsUsd);
  assignCreditMerchantAccount(credit, merchantAccount);
  assignCreditCreditingUser(credit, await findUserBang(Number(gumroadAdminId())));
  await Credits.saveBang(credit, options);

  const issuedAmount: Amount = { currency: USD, grossCents: creditAmountCentsUsd, netCents: creditAmountCentsUsd };
  const holdingAmount: Amount = {
    currency: (await creditMerchantAccount(credit))!.get("currency") as string,
    grossCents: amountCentsHoldingCurrency,
    netCents: amountCentsHoldingCurrency,
  };
  const balanceTransaction = await createBalanceTransactionBang(
    { user: (await creditUser(credit))!, merchantAccount: (await creditMerchantAccount(credit))!, credit, issuedAmount, holdingAmount },
    options,
  );

  const balance = await balanceTransactionBalance(balanceTransaction);
  assignBelongsTo(credit, { name: "balance", foreignKey: "balance_id", targetTable: "balances", targetModel: "Balance" }, balance);
  await Credits.saveBang(credit, options);
  return credit;
}

// Credit.create_for_bank_debit_on_stripe_account!
export const createForBankDebitOnStripeAccountBang = (attributes: { amountCents: number; merchantAccount: MerchantAccountRecord }, options?: SaveOptions) =>
  createForBalanceChangeOnStripeAccountBang({ amountCentsHoldingCurrency: attributes.amountCents, merchantAccount: attributes.merchantAccount }, options);
