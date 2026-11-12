import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { refundFeeRetention } from "./refund-fee-retention.ts";
import { usdCentsToCurrency } from "./concerns/currency-helper.ts";

type Golden = {
  rates: Record<string, string>;
  retention: {
    name: string;
    input: {
      sale: Record<string, number | string>;
      refund_amount_cents: number;
      charged_using_gumroad_merchant_account: boolean;
      holder_of_funds: string;
      merchant_currency: string;
    };
    credit_amount_cents: number | null;
    credit_merchant_account: string | null;
    retained_fee_cents: number | null;
    fee_retention_pending: boolean | null;
    balance_transaction: Record<string, string | number> | null;
  }[];
};

const golden = JSON.parse(readFileSync(new URL("../stripe/__fixtures__/refund-fee-retention.golden.json", import.meta.url), "utf8")) as Golden;

describe("refundFeeRetention against the Ruby golden of Credit.create_for_refund_fee_retention!", () => {
  for (const entry of golden.retention) {
    it(`books the credit of ${entry.name}`, async () => {
      const { sale } = entry.input;
      const result = await refundFeeRetention({
        sale: {
          priceCents: sale.price_cents as number,
          processorFeeCents: (sale.processor_fee_cents as number | undefined) ?? null,
          processorFeeCentsCurrency: (sale.processor_fee_cents_currency as string | undefined) ?? null,
          gumroadTaxCents: (sale.gumroad_tax_cents as number | undefined) ?? 0,
          affiliateCreditCents: (sale.affiliate_credit_cents as number | undefined) ?? 0,
        },
        refundAmountCents: entry.input.refund_amount_cents,
        chargedUsingGumroadMerchantAccount: entry.input.charged_using_gumroad_merchant_account,
        holderOfFunds: entry.input.holder_of_funds,
        merchantCurrency: entry.input.merchant_currency,
        usdCentsToCurrency: (currency, cents) =>
          usdCentsToCurrency(currency, cents, currency === "usd" ? undefined : Number(golden.rates[currency.toUpperCase()])),
      });
      if (entry.credit_amount_cents === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      expect(result!.creditAmountCents).toBe(entry.credit_amount_cents);
      expect(result!.creditMerchantAccount).toBe(entry.credit_merchant_account === "gumroad" ? "gumroad" : "sale");
      expect(result!.retainedFeeCents).toBe(entry.retained_fee_cents);
      // The Ruby reader answers nil for a false flag.
      expect(result!.feeRetentionPending === true ? true : null).toBe(entry.fee_retention_pending);
      const bt = entry.balance_transaction!;
      expect(result!.issuedAmount).toEqual({ currency: bt.issued_amount_currency, grossCents: bt.issued_amount_gross_cents, netCents: bt.issued_amount_net_cents });
      expect(result!.holdingAmount).toEqual({ currency: bt.holding_amount_currency, grossCents: bt.holding_amount_gross_cents, netCents: bt.holding_amount_net_cents });
    });
  }

  it("covers a Canadian account, the processor fee recorded and not, and both Connect branches", () => {
    expect(golden.retention.length).toBeGreaterThanOrEqual(8);
    expect(new Set(golden.retention.map((entry) => entry.credit_merchant_account))).toEqual(new Set(["seller", "gumroad", null]));
  });
});
