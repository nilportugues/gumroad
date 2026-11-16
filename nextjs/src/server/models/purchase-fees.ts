// Purchase#calculate_fees (app/models/purchase.rb) for a one-time purchase: not a subscription charge, not a preorder release.
// The facts it reads from other records (the seller's fee flags, the merchant account, whether the product counts as recommended)
// are resolved by the caller, so this is the arithmetic only. A paid checkout runs it before the first call to the processor,
// and the amount it yields is the charge's `gumroad_amount_cents`.
// Golden: __fixtures__/purchase-fees.golden.json (scripts/golden/purchase-fees.rb), 2,233 cases from the real method.
import { rubyRound } from "./concerns/ruby-numeric.ts";

export const GUMROAD_FLAT_FEE_PER_THOUSAND = 100;
export const GUMROAD_DISCOVER_FEE_PER_THOUSAND = 300;
export const GUMROAD_DISCOVER_EXTRA_FEE_PER_THOUSAND = 100;
export const GUMROAD_FIXED_FEE_CENTS = 50;
export const PROCESSOR_FEE_PER_THOUSAND = 29;
export const PROCESSOR_FIXED_FEE_CENTS = 30;
export const PIX_IOF_FEE_PER_THOUSAND = 35;
// User::HIGH_VOLUME_FEE_PER_THOUSAND
export const HIGH_VOLUME_FEE_PER_THOUSAND = 50;

export type FeeFacts = {
  priceCents: number;
  // seller.waive_gumroad_fee_on_new_sales?
  waiveGumroadFee: boolean;
  // seller.high_volume_seller_fee?
  highVolumeSeller: boolean;
  // purchase.charged_using_gumroad_merchant_account?
  chargedUsingGumroadMerchantAccount: boolean;
  // purchase.charge_discover_fee?
  chargeDiscoverFee: boolean;
  // The purchase's own custom_fee_per_thousand, then the seller's (the second applies only when the first is unset).
  customFeePerThousand: number | null;
  sellerCustomFeePerThousand: number | null;
  // merchant_account.is_a_brazilian_stripe_connect_account?
  brazilianStripeConnectAccount: boolean;
  // card_type == CardType::PIX
  pix: boolean;
};

export type FeeResult = { feeCents: number; wasDiscoverFeeCharged: boolean };

export function calculateFees(facts: FeeFacts): FeeResult {
  if (facts.priceCents === 0 || facts.brazilianStripeConnectAccount)
    return { feeCents: 0, wasDiscoverFeeCharged: false };

  // calculate_custom_fee_per_thousand, one-time branch
  const custom = facts.customFeePerThousand ?? (facts.chargeDiscoverFee ? null : facts.sellerCustomFeePerThousand);
  const gumroadAccount = facts.chargedUsingGumroadMerchantAccount;

  // gumroad_flat_fee_per_thousand
  let flat = GUMROAD_FLAT_FEE_PER_THOUSAND;
  if (facts.waiveGumroadFee) flat = 0;
  else if (facts.highVolumeSeller && !facts.chargeDiscoverFee) flat = HIGH_VOLUME_FEE_PER_THOUSAND;

  let feePerThousand =
    (custom ?? flat) +
    (gumroadAccount ? PROCESSOR_FEE_PER_THOUSAND : 0) +
    (facts.pix && gumroadAccount ? PIX_IOF_FEE_PER_THOUSAND : 0);

  let wasDiscoverFeeCharged = false;
  if (facts.chargeDiscoverFee) {
    const discover =
      GUMROAD_DISCOVER_FEE_PER_THOUSAND -
      (custom ?? GUMROAD_DISCOVER_EXTRA_FEE_PER_THOUSAND) -
      (gumroadAccount ? PROCESSOR_FEE_PER_THOUSAND : 0);
    if (discover > 0) {
      feePerThousand += discover;
      wasDiscoverFeeCharged = true;
    }
  }

  const variable = rubyRound((facts.priceCents * feePerThousand) / 1000);
  const fixed = wasDiscoverFeeCharged ? 0 : GUMROAD_FIXED_FEE_CENTS + (gumroadAccount ? PROCESSOR_FIXED_FEE_CENTS : 0);
  return { feeCents: variable + fixed, wasDiscoverFeeCharged };
}
