// Port of app/sidekiq/recover_aus_backtax_from_stripe_account_job.rb with
// StripeChargeProcessor.debit_stripe_account_for_australia_backtaxes and calculate_transfer_reversal.
// Golden: __fixtures__/money-jobs.golden.json (scripts/golden/money-jobs.rb).
import { getConfig } from "../../server/infra/config.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import {
  australiaBacktaxAgreementOf,
  backtaxAgreementOfCredit,
  backtaxCollectionsAmountCentsUsd,
  backtaxCollectionsSize,
  createBacktaxCollectionBang,
  creditOfBacktaxAgreement,
  isCollected,
  markCollectedBang,
  type BacktaxAgreementRecord,
} from "../../server/models/backtax-collection.ts";
import { BACKTAX_JURISDICTIONS } from "../../server/models/backtax-agreement.ts";
import { getUsdCents, usdCentsToCurrency } from "../../server/models/concerns/currency-helper.ts";
import { creditMerchantAccount, creditUser, type CreditRecord } from "../../server/models/credit.ts";
import { HOLDER_OF_FUNDS, holderOfFunds } from "../../server/models/merchant-account.ts";
import { completedInternalTransferIds } from "../../server/models/payment.ts";
import type { SaveOptions } from "../../server/models/runtime/define-model.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { findUser } from "../../server/models/user.ts";
import { Balance, Transfer } from "../../server/stripe/resources.ts";
import { modelJob } from "./support/job-deps.ts";

const USA_ALPHA2 = "US";
const REVERSAL_LOOKBACK_SECONDS = 120 * 86_400;
const TRANSFERS_PAGE_SIZE = 100;
// A 5% buffer for currency conversion inaccuracies.
const CONVERSION_BUFFER = 5.0 / 100;

class NoMethodError extends Error {
  readonly rubyClass = "NoMethodError";
  constructor(method: string, receiver = "nil") {
    super(`undefined method '${method}' for ${receiver}`);
  }
}

type StripeAmount = { amount: number; currency: string };
type StripeTransfer = { id: string; amount: number; amount_reversed: number; currency: string };
type CurrencyData = { owed: number; transfers: [string, number][]; sum: number };

// Float#round: half away from zero.
const rubyRound = (value: number) => Math.sign(value) * Math.round(Math.abs(value));
const covered = (data: Record<string, CurrencyData>) => Object.values(data).some((entry) => entry.sum >= entry.owed);

// StripeChargeProcessor.calculate_transfer_reversal
function calculateTransferReversal(transfer: StripeTransfer | null, data: Record<string, CurrencyData>): void {
  if (!transfer) return;
  const available = transfer.amount - transfer.amount_reversed;
  if (!(available > 0)) return;
  const entry = data[transfer.currency];
  if (!entry) return;
  const amountToReverse = Math.min(available, entry.owed - entry.sum);
  entry.transfers.push([transfer.id, amountToReverse]);
  entry.sum += amountToReverse;
}

async function debitStripeAccountForAustraliaBacktaxes(credit: CreditRecord, now: () => Date): Promise<void> {
  const options: SaveOptions = { now };
  if (credit.get("amount_cents") === 0) return;
  const backtaxAgreement = await backtaxAgreementOfCredit(credit);
  if (backtaxAgreement?.get("jurisdiction") !== BACKTAX_JURISDICTIONS.AUSTRALIA) return;
  if (isCollected(backtaxAgreement)) return;

  let owedAmountCentsUsd = Math.abs(credit.get("amount_cents") as number);
  // Adjust the amount owed if only a partial amount of reversals completed (due to some Stripe failure).
  if ((await backtaxCollectionsSize(backtaxAgreement)) > 0) owedAmountCentsUsd -= await backtaxCollectionsAmountCentsUsd(backtaxAgreement);

  if (!(owedAmountCentsUsd > 0)) {
    await markCollectedBang(backtaxAgreement, options);
    return;
  }

  const merchantAccount = await creditMerchantAccount(credit);
  if (merchantAccount === null) throw new NoMethodError("holder_of_funds");
  const holder = await beforeSideEffects(() => holderOfFunds(merchantAccount));
  if (holder === HOLDER_OF_FUNDS.GUMROAD) {
    // No Stripe transfer needed. Record the backtax collection and return.
    await transaction(async () => {
      await createBacktaxCollectionBang(
        { user: (await creditUser(credit))!, backtaxAgreement, amountCents: owedAmountCentsUsd, amountCentsUsd: owedAmountCentsUsd, currency: "usd", stripeTransferId: null },
        options,
      );
      await markCollectedBang(backtaxAgreement, options);
    });
    return;
  }

  if ((await holderOfFunds(merchantAccount)) !== HOLDER_OF_FUNDS.STRIPE) return;
  if (isBlank(merchantAccount.get("charge_processor_merchant_id"))) return;

  const stripeCurrency = merchantAccount.get("currency") as string;
  const stripeAccountId = merchantAccount.get("charge_processor_merchant_id") as string;
  const stripeBalance = await Balance.retrieve({ stripeAccount: stripeAccountId });
  const available = (stripeBalance.available as StripeAmount[]).find((entry) => entry.currency === stripeCurrency);
  const pending = (stripeBalance.pending as StripeAmount[]).find((entry) => entry.currency === stripeCurrency);
  if (!available) throw new NoMethodError("amount");
  if (!pending) throw new NoMethodError("amount");
  const stripeBalanceAmount = available.amount + pending.amount;

  // A US account's currency is guaranteed to be usd (see the note in the Ruby method), so the
  // owed USD amount is compared with it directly.
  if (merchantAccount.get("country") === USA_ALPHA2) {
    // Avoid debiting the customer's bank account if they haven't accumulated enough balance.
    if (!(stripeBalanceAmount > owedAmountCentsUsd)) return;
    const transfer = await Transfer.create(
      { amount: owedAmountCentsUsd, currency: "usd", destination: getConfig("STRIPE_PLATFORM_ACCOUNT_ID") ?? null },
      { stripeAccount: stripeAccountId },
    );
    await transaction(async () => {
      await createBacktaxCollectionBang(
        { user: (await creditUser(credit))!, backtaxAgreement, amountCents: owedAmountCentsUsd, amountCentsUsd: owedAmountCentsUsd, currency: "usd", stripeTransferId: transfer.id },
        options,
      );
      await markCollectedBang(backtaxAgreement, options);
    });
    return;
  }

  await reverseHistoricalTransfers({ credit, backtaxAgreement, owedAmountCentsUsd, stripeCurrency, stripeAccountId, stripeBalanceAmount, now });
}

// For non-US Gumroad-controlled Stripe accounts there are no new debit transfers: enough historical
// transfers to the account, all of one currency, are reversed to cover the amount owed.
async function reverseHistoricalTransfers(args: {
  credit: CreditRecord;
  backtaxAgreement: BacktaxAgreementRecord;
  owedAmountCentsUsd: number;
  stripeCurrency: string;
  stripeAccountId: string;
  stripeBalanceAmount: number;
  now: () => Date;
}): Promise<void> {
  const { credit, backtaxAgreement, owedAmountCentsUsd, stripeCurrency, stripeAccountId, stripeBalanceAmount, now } = args;
  const options: SaveOptions = { now };
  const owedAmountInCurrency = await usdCentsToCurrency(stripeCurrency, owedAmountCentsUsd);
  if (!(stripeBalanceAmount > owedAmountInCurrency)) return;

  // stripe_balance_amount is in the merchant account's currency, so it is converted from that.
  const stripeBalanceAmountCentsUsd = await getUsdCents(stripeCurrency, stripeBalanceAmount);
  const reducedByFivePercent = rubyRound(stripeBalanceAmountCentsUsd - CONVERSION_BUFFER * stripeBalanceAmountCentsUsd);
  if (!(reducedByFivePercent > owedAmountCentsUsd)) return;

  // `{ usd:, stripe_currency.to_sym => }`: a usd account's second entry replaces the first.
  const data: Record<string, CurrencyData> = {
    usd: { owed: owedAmountCentsUsd, transfers: [], sum: 0 },
    [stripeCurrency]: { owed: owedAmountInCurrency, transfers: [], sum: 0 },
  };

  // First, internal transfers made from Gumroad's Stripe account to the creator's account.
  const user = await creditUser(credit);
  const transferIds = await completedInternalTransferIds(user!.get("id"), stripeAccountId);
  for (const transferId of transferIds.filter((id): id is string => !isBlank(id))) {
    if (covered(data)) break;
    const transfer = await Transfer.retrieve(transferId).catch(() => null);
    calculateTransferReversal(transfer as StripeTransfer | null, data);
  }

  // Next, transfers of an old purchase: older than 120 days, which disputes and refunds can no
  // longer reach.
  let startingAfter: string | null = null;
  while (!covered(data)) {
    const transfers = await Transfer.list({
      destination: stripeAccountId,
      created: { lt: Math.trunc(now().getTime() / 1000) - REVERSAL_LOOKBACK_SECONDS },
      limit: TRANSFERS_PAGE_SIZE,
      starting_after: startingAfter,
    });
    const page = transfers.data as StripeTransfer[];
    if (!(page.length > 0)) break;
    for (const transfer of page) {
      if (covered(data)) break;
      startingAfter = transfer.id;
      calculateTransferReversal(transfer, data);
    }
  }

  const found = Object.entries(data).find(([, entry]) => entry.sum >= entry.owed);
  // Only perform transfers if the total amount owed can be transferred in full.
  if (!found) return;
  const [reversalCurrency, reversalData] = found;

  for (const [transferId, amountToReverse] of reversalData.transfers) {
    const transferReversal = await Transfer.createReversal(transferId, { amount: amountToReverse });
    await createBacktaxCollectionBang(
      {
        user: user!,
        backtaxAgreement,
        amountCents: amountToReverse,
        amountCentsUsd: await getUsdCents(reversalCurrency, amountToReverse),
        currency: reversalCurrency,
        stripeTransferId: transferReversal.id,
      },
      options,
    );
  }
  await markCollectedBang(backtaxAgreement, options);
}

export const recoverAusBacktaxFromStripeAccountJobWith = modelJob({ min: 1 }, async ([creatorId], deps) => {
  const creator = await findUser(creatorId);
  if (creator === null) return;
  const backtaxAgreement = await australiaBacktaxAgreementOf(creator);
  if (backtaxAgreement === null) return;
  if (isCollected(backtaxAgreement)) return;
  const credit = await creditOfBacktaxAgreement(backtaxAgreement);
  if (credit === null) return;
  await debitStripeAccountForAustraliaBacktaxes(credit, deps.now);
});

export const recoverAusBacktaxFromStripeAccountJob = recoverAusBacktaxFromStripeAccountJobWith();
