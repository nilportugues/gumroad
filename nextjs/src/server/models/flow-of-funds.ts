// Port of app/business/payments/charging/flow_of_funds.rb: the amounts at each point money moved, in the currency each was in.
// Cents are plain numbers: a Stripe amount is far below 2^53.
export type FlowAmount = { currency: string; cents: number };

export type FlowOfFunds = {
  issuedAmount: FlowAmount;
  settledAmount: FlowAmount;
  gumroadAmount: FlowAmount | null;
  merchantAccountGrossAmount: FlowAmount | null;
  merchantAccountNetAmount: FlowAmount | null;
};

// FlowOfFunds.build_simple_flow_of_funds
export function buildSimpleFlowOfFunds(currency: string, amountCents: number): FlowOfFunds {
  const amount = { currency, cents: amountCents };
  return {
    issuedAmount: amount,
    settledAmount: amount,
    gumroadAmount: amount,
    merchantAccountGrossAmount: null,
    merchantAccountNetAmount: null,
  };
}

// FlowOfFunds#to_h: a missing amount is `nil.to_h`, an empty hash.
export function flowOfFundsToH(flow: FlowOfFunds): Record<string, Partial<FlowAmount>> {
  const amount = (value: FlowAmount | null): Partial<FlowAmount> =>
    value === null ? {} : { currency: value.currency, cents: value.cents };
  return {
    issued_amount: amount(flow.issuedAmount),
    settled_amount: amount(flow.settledAmount),
    gumroad_amount: amount(flow.gumroadAmount),
    merchant_account_gross_amount: amount(flow.merchantAccountGrossAmount),
    merchant_account_net_amount: amount(flow.merchantAccountNetAmount),
  };
}
