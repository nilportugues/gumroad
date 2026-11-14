// Credit.create_for_balance_change_on_stripe_account! and create_for_bank_debit_on_stripe_account!
// (app/models/credit.rb): a credit, its balance transaction, and the balance it lands on. The
// other create_for_* methods need models that are not ported (Purchase, Refund, Dispute, Payment)
// or mail (notify_user), and are not here.
import { assignBelongsTo } from "./concerns/belongs-to-record.ts";
import { getUsdCents } from "./concerns/currency-helper.ts";
import { balanceTransactionBalance, createBalanceTransactionBang, type Amount } from "./balance-transaction.ts";
import { assignCreditCreditingUser, assignCreditMerchantAccount, assignCreditReturnedPayment, assignCreditUser, creditMerchantAccount, creditUser, Credits, type CreditRecord } from "./credit.ts";
import { merchantAccountUser, type MerchantAccountRecord } from "./merchant-account.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import type { PaymentRecord } from "./payment.ts";
import { findUserBang, type UserRecord } from "./user.ts";

const USD = "usd";

export { gumroadAdminId } from "./gumroad-admin-id.ts";
import { gumroadAdminId } from "./gumroad-admin-id.ts";

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

// Credit.create_for_returned_payment_difference!: the currency-conversion difference of a returned payout, as a zero-dollar credit whose
// balance transaction moves only the holding currency.
export async function createForReturnedPaymentDifferenceBang(
  attributes: { user: UserRecord; merchantAccount: MerchantAccountRecord; returnedPayment: PaymentRecord; differenceAmountCents: number },
  options: SaveOptions = {},
): Promise<CreditRecord> {
  const { user, merchantAccount, returnedPayment, differenceAmountCents } = attributes;
  const credit = Credits.build({});
  assignCreditUser(credit, user);
  assignCreditMerchantAccount(credit, merchantAccount);
  credit.set("amount_cents", 0);
  assignCreditReturnedPayment(credit, returnedPayment);
  await Credits.saveBang(credit, options);

  const issuedAmount: Amount = { currency: USD, grossCents: 0, netCents: 0 };
  const holdingAmount: Amount = {
    currency: returnedPayment.get("currency") as string,
    grossCents: differenceAmountCents,
    netCents: differenceAmountCents,
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
