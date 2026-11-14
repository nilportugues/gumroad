// Replays __fixtures__/stripe-charge-facts.golden.json (scripts/golden/stripe-charge-facts.rb): the real StripeCharge.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as charge from "./stripe-charge-facts.ts";

type Amount = { currency: string; cents: number };
type Json = Record<string, unknown>;
type GoldenCase = {
  name: string;
  input: {
    charge: Json;
    balance_transaction: Json | null;
    application_fee_balance_transaction: Json | null;
    destination_payment_balance_transaction: Json | null;
    destination_transfer: Json | null;
    destination_payment: Json | null;
    merchant_account_currency: string | null;
  };
  output: Record<string, unknown> & {
    flow_of_funds: {
      issued_amount: Amount;
      settled_amount: Amount;
      gumroad_amount: Amount;
      merchant_account_gross_amount: Amount | null;
      merchant_account_net_amount: Amount | null;
    } | null;
  };
};
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "__fixtures__/stripe-charge-facts.golden.json"), "utf8"),
) as {
  constants: {
    card_number_lengths: Record<string, number>;
    now: string;
    destination_payment_settlement_grace_hours: number;
  };
  cases: GoldenCase[];
};

const snake = (result: charge.ProcessorCharge) => ({
  id: result.id,
  status: result.status,
  refunded: result.refunded,
  disputed: result.disputed,
  amount_cents: result.amountCents,
  currency: result.currency,
  amount_refunded_cents: result.amountRefundedCents,
  fee: result.fee,
  fee_currency: result.feeCurrency,
  flow_of_funds:
    result.flowOfFunds === null
      ? null
      : {
          issued_amount: result.flowOfFunds.issuedAmount,
          settled_amount: result.flowOfFunds.settledAmount,
          gumroad_amount: result.flowOfFunds.gumroadAmount,
          merchant_account_gross_amount: result.flowOfFunds.merchantAccountGrossAmount,
          merchant_account_net_amount: result.flowOfFunds.merchantAccountNetAmount,
        },
  card_fingerprint: result.cardFingerprint,
  card_instance_id: result.cardInstanceId,
  card_last4: result.cardLast4,
  card_number_length: result.cardNumberLength,
  card_expiry_month: result.cardExpiryMonth,
  card_expiry_year: result.cardExpiryYear,
  card_zip_code: result.cardZipCode,
  card_type: result.cardType,
  card_country: result.cardCountry,
  zip_check_result: result.zipCheckResult,
  risk_level: result.riskLevel,
  card_mandate: result.cardMandate,
  payment_method_type: result.paymentMethodType,
});

describe("StripeCharge", () => {
  it("uses the card number lengths and the settlement grace Ruby has", () => {
    expect(golden.constants.card_number_lengths).toEqual({
      generic_card: charge.cardNumberLength("generic_card"),
      visa: charge.cardNumberLength("visa"),
      amex: charge.cardNumberLength("amex"),
      mastercard: charge.cardNumberLength("mastercard"),
      discover: charge.cardNumberLength("discover"),
      jcb: charge.cardNumberLength("jcb"),
      diners: charge.cardNumberLength("diners"),
      unionpay: charge.cardNumberLength("unionpay"),
    });
    expect(golden.constants.destination_payment_settlement_grace_hours * 3600).toBe(
      charge.DESTINATION_PAYMENT_SETTLEMENT_GRACE_SECONDS,
    );
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))(
    "%s reads the fee, flow of funds and card as Ruby does",
    (_name, c) => {
      const result = charge.readStripeCharge({
        charge: c.input.charge,
        balanceTransaction: c.input.balance_transaction,
        applicationFeeBalanceTransaction: c.input.application_fee_balance_transaction,
        destinationPaymentBalanceTransaction: c.input.destination_payment_balance_transaction,
        destinationTransfer: c.input.destination_transfer,
        destinationPayment: c.input.destination_payment,
        merchantAccountCurrency: c.input.merchant_account_currency,
        now: new Date(golden.constants.now),
      });
      expect(snake(result)).toEqual(c.output);
    },
  );

  it("answers the fee of the recorded $5 purchase", () => {
    const recorded = golden.cases.find((c) => c.name === "recorded platform charge")!;
    expect(recorded.output.fee).toBe(45);
    expect(recorded.output.fee_currency).toBe("usd");
  });
});
