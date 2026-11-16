import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildSimpleFlowOfFunds, flowOfFundsToH } from "../models/flow-of-funds.ts";

import { stripeChargeRefund, type StripeChargeRefundInput } from "./stripe-charge-refund.ts";

type Case = {
  name: string;
  input: StripeChargeRefundInput;
  output: { id: string; charge_id: string; flow_of_funds: unknown } | { error: { class: string; message: string } };
};

const { cases } = JSON.parse(
  readFileSync(new URL("./__fixtures__/flow-of-funds.golden.json", import.meta.url), "utf8"),
) as { cases: Case[] };

describe("stripeChargeRefund against the Ruby FlowOfFunds goldens", () => {
  for (const { name, input, output } of cases) {
    it(`builds the flow of funds of ${name}`, () => {
      if ("error" in output) {
        expect(() => stripeChargeRefund(input)).toThrow(output.error.message);
        return;
      }
      const refund = stripeChargeRefund(input);
      expect({ id: refund.id, charge_id: refund.chargeId, flow_of_funds: flowOfFundsToH(refund.flowOfFunds) }).toEqual(
        output,
      );
    });
  }

  it("covers every branch the goldens were written for", () => {
    expect(cases.filter((entry) => "error" in entry.output).map((entry) => entry.output)).toHaveLength(2);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe("buildSimpleFlowOfFunds", () => {
  it("repeats one amount for the issued, settled and Gumroad legs", () => {
    expect(flowOfFundsToH(buildSimpleFlowOfFunds("usd", -250))).toEqual({
      issued_amount: { currency: "usd", cents: -250 },
      settled_amount: { currency: "usd", cents: -250 },
      gumroad_amount: { currency: "usd", cents: -250 },
      merchant_account_gross_amount: {},
      merchant_account_net_amount: {},
    });
  });
});
