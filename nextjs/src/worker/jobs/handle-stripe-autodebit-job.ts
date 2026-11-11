// Port of app/sidekiq/handle_stripe_autodebit_for_negative_balance.rb with
// StripePayoutProcessor.handle_stripe_negative_balance_debit_event. Golden:
// __fixtures__/money-jobs.golden.json (scripts/golden/money-jobs.rb).
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { createForBankDebitOnStripeAccountBang } from "../../server/models/credit-creation.ts";
import {
  STRIPE_CHARGE_PROCESSOR_ID,
  findMerchantAccountByProcessorMerchantId,
} from "../../server/models/merchant-account.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { Payout } from "../../server/stripe/resources.ts";

import { modelJob } from "./support/job-deps.ts";

class RuntimeError extends Error {
  readonly rubyClass = "RuntimeError";
}

class NoMethodError extends Error {
  readonly rubyClass = "NoMethodError";
  constructor(method: string, receiver: string) {
    super(`undefined method '${method}' for ${receiver}`);
  }
}

type StripePayout = { status?: unknown; amount?: unknown; balance_transaction?: unknown };

// `payout["balance_transaction"]["status"]`: a String receiver answers `[]` with a substring match.
function balanceTransactionStatus(payout: StripePayout): unknown {
  const transaction = payout.balance_transaction;
  if (transaction === null || transaction === undefined) throw new NoMethodError("[]", "nil");
  if (typeof transaction === "string") return transaction.includes("status") ? "status" : null;
  return (transaction as { status?: unknown }).status ?? null;
}

// StripePayoutProcessor.handle_stripe_negative_balance_debit_event
async function handleNegativeBalanceDebit(
  stripeConnectAccountId: string,
  stripePayoutId: string,
  now: () => Date,
): Promise<void> {
  // This is a stripe automatic debit made by stripe due to negative balance in user stripe account.
  const stripePayout = (await Payout.retrieve(stripePayoutId, {
    stripeAccount: stripeConnectAccountId,
  })) as StripePayout;
  const amountCents = stripePayout.amount;
  const merchantAccount = await findMerchantAccountByProcessorMerchantId(stripeConnectAccountId);
  if (typeof amountCents !== "number")
    throw new NoMethodError("<", amountCents == null ? "nil" : "an instance of String");
  if (!(amountCents < 0)) return;
  // Node knows the holder of funds of Stripe accounts only, and a currency to convert from.
  await beforeSideEffects(() => {
    if (merchantAccount === null) return;
    if (merchantAccount.get("charge_processor_id") !== STRIPE_CHARGE_PROCESSOR_ID)
      throw new NotPortedError("Credit for a non-Stripe merchant account", "app/models/merchant_account.rb:131");
    if (merchantAccount.get("currency") == null)
      throw new NotPortedError("Credit for a merchant account without a currency", "app/models/credit.rb:322");
  });
  if (merchantAccount === null) throw new NoMethodError("user", "nil");
  await createForBankDebitOnStripeAccountBang({ amountCents: Math.abs(amountCents), merchantAccount }, { now });
}

export const handleStripeAutodebitForNegativeBalanceWith = modelJob(
  { min: 3 },
  async ([stripeEventId, stripeConnectAccountId, stripePayoutId], deps) => {
    const payout = (await Payout.retrieve(
      { id: String(stripePayoutId), expand: ["balance_transaction"] },
      { stripeAccount: String(stripeConnectAccountId) },
    )) as StripePayout;
    if (balanceTransactionStatus(payout) === "available" && payout.status === "paid") {
      await handleNegativeBalanceDebit(String(stripeConnectAccountId), String(stripePayoutId), deps.now);
    } else if (payout.status === "failed") {
      // The debit payout that was once reported as `paid` has now transitioned to `failed`: nothing to do.
    } else {
      throw new RuntimeError(
        `Timed out waiting for payout to become finalized (to transition to \`failed\` state or its balance transaction to transition to \`available\` state). Stripe event ID: ${String(stripeEventId)}.`,
      );
    }
  },
);

export const handleStripeAutodebitForNegativeBalance = handleStripeAutodebitForNegativeBalanceWith();
