// The facts `Purchase#calculate_fees` takes as inputs (purchase-fees.ts), resolved the way Rails resolves them before a paid
// checkout's first call to the processor. Each function is pure over rows the caller has already read, so what is under test
// is the decision, not the SQL.
// Golden: __fixtures__/purchase-charge-facts.golden.json (scripts/golden/purchase-charge-facts.rb), from the real Ruby methods.
import SUBSCRIPTION_DATA from "./subscription-data.generated.json" with { type: "json" };

export const STRIPE_PROCESSOR = "stripe";
export const PAYPAL_PROCESSOR = "paypal";
export const HIGH_VOLUME_SELLER_FEE_FEATURE = "high_volume_seller_fee";

const CROSS_BORDER_PAYOUTS_COUNTRIES: ReadonlySet<string> = new Set(SUBSCRIPTION_DATA.cross_border_payouts_countries);

// User#high_volume_seller_fee?: the Flipper flag for the seller and a stored `YYYY-MM` that is the current month (UTC, as
// `Time.current.strftime("%Y-%m")` is under the app's zone).
export function highVolumeSellerFee(facts: { featureActive: boolean; month: string | null; now: Date }): boolean {
  if (!facts.featureActive) return false;
  const { now } = facts;
  return facts.month === `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type ChargeMerchantAccount = {
  id: unknown;
  // null for the shared Gumroad account
  user_id: unknown;
  charge_processor_id: string;
  country: string | null;
  json_data: unknown;
  deleted_at: unknown;
  charge_processor_alive_at: unknown;
  charge_processor_deleted_at: unknown;
};

const isStripe = (account: ChargeMerchantAccount) => account.charge_processor_id === STRIPE_PROCESSOR;

function stripeConnectMarker(jsonData: unknown): unknown {
  const data: unknown = typeof jsonData === "string" && jsonData.trim() !== "" ? JSON.parse(jsonData) : jsonData;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const meta = (data as Record<string, unknown>).meta;
  return meta != null && typeof meta === "object" ? (meta as Record<string, unknown>).stripe_connect : undefined;
}

// MerchantAccount#is_a_stripe_connect_account?
export const isStripeConnect = (account: ChargeMerchantAccount) =>
  isStripe(account) && account.user_id != null && stripeConnectMarker(account.json_data) === "true";

// MerchantAccount#is_a_brazilian_stripe_connect_account?
export const isBrazilianStripeConnect = (account: ChargeMerchantAccount) =>
  isStripeConnect(account) && account.country === "BR";

// MerchantAccount#is_managed_by_gumroad?
export const isManagedByGumroad = (account: ChargeMerchantAccount) => account.user_id == null;

// MerchantAccount#can_accept_charges?
const canAcceptCharges = (account: ChargeMerchantAccount) =>
  !isStripe(account) ||
  isStripeConnect(account) ||
  !(account.country != null && CROSS_BORDER_PAYOUTS_COUNTRIES.has(account.country));

// `merchant_accounts.alive.charge_processor_alive`
const isAlive = (account: ChargeMerchantAccount) =>
  account.deleted_at == null &&
  account.charge_processor_alive_at != null &&
  account.charge_processor_deleted_at == null;

// User#merchant_account(charge_processor_id). `accounts` are the seller's rows in id order; `merchantMigrationEnabled` is
// `seller.merchant_migration_enabled?` (SubscriptionRecord.merchantMigrationEnabled reads it).
export function sellerMerchantAccount(
  accounts: ChargeMerchantAccount[],
  processor: string,
  merchantMigrationEnabled: boolean,
): ChargeMerchantAccount | null {
  const alive = accounts.filter(isAlive);
  if (processor === STRIPE_PROCESSOR) {
    const stripeAccounts = alive.filter(isStripe);
    const connect = stripeAccounts.find(isStripeConnect) ?? null;
    // has_stripe_account_connected?
    if (merchantMigrationEnabled && connect !== null) return connect;
    return stripeAccounts.find((account) => canAcceptCharges(account) && !isStripeConnect(account)) ?? null;
  }
  return alive.find((account) => account.charge_processor_id === processor && canAcceptCharges(account)) ?? null;
}

export const BRAZILIAN_MERCHANT_ACCOUNT_WITH_AFFILIATE = "brazilian_merchant_account_with_affiliate";

export type PreparedMerchantAccount = {
  account: ChargeMerchantAccount | null;
  // Set when the chosen account is a Brazilian Connect account and the purchase has an affiliate.
  error: { code: string; message: string } | null;
};

// Purchase#prepare_merchant_account, up to the call to calculate_fees: a saved UPI Autopay method stays on Gumroad's Stripe
// account, otherwise the seller's account, otherwise the shared Gumroad account for the processor.
export function prepareMerchantAccount(facts: {
  sellerAccounts: ChargeMerchantAccount[];
  gumroadAccounts: ChargeMerchantAccount[];
  processor: string;
  merchantMigrationEnabled: boolean;
  recurringUpi: boolean;
  hasAffiliate: boolean;
}): PreparedMerchantAccount {
  const gumroad = (processor: string) =>
    facts.gumroadAccounts.find((account) => account.user_id == null && account.charge_processor_id === processor) ??
    null;
  const account = facts.recurringUpi
    ? gumroad(STRIPE_PROCESSOR)
    : (sellerMerchantAccount(facts.sellerAccounts, facts.processor, facts.merchantMigrationEnabled) ??
      gumroad(facts.processor));
  const error =
    account !== null && isBrazilianStripeConnect(account) && facts.hasAffiliate
      ? {
          code: BRAZILIAN_MERCHANT_ACCOUNT_WITH_AFFILIATE,
          message: "Affiliate sales are not currently supported for this product.",
        }
      : null;
  return { account, error };
}

// Purchase#charged_using_gumroad_merchant_account?: a Gumroad-managed account, or a Stripe charge on a non-Connect account
// (which includes a purchase with no account at all).
export function chargedUsingGumroadMerchantAccount(
  account: ChargeMerchantAccount | null,
  purchaseProcessor: string | null,
): boolean {
  if (account !== null && isManagedByGumroad(account)) return true;
  return purchaseProcessor === STRIPE_PROCESSOR && !(account !== null && isStripeConnect(account));
}

// RecommendationType.is_free_recommendation_type?
export const FREE_RECOMMENDATION_TYPES: readonly string[] = [
  "library",
  "more_like_this",
  "wishlist",
  "recently_viewed",
];

// Purchase#charge_discover_fee?
export function chargeDiscoverFee(facts: {
  productRecommendable: boolean;
  // not_is_original_subscription_purchase?
  notOriginalSubscriptionPurchase: boolean;
  // original_purchase&.was_discover_fee_charged?, nil without an original purchase
  originalDiscoverFeeCharged: boolean | null;
  wasProductRecommended: boolean;
  recommendedBy: string | null;
}): boolean {
  const eligible =
    facts.productRecommendable || (facts.notOriginalSubscriptionPurchase && facts.originalDiscoverFeeCharged === true);
  if (!eligible) return false;
  return (
    facts.wasProductRecommended &&
    !(facts.recommendedBy !== null && FREE_RECOMMENDATION_TYPES.includes(facts.recommendedBy))
  );
}

// CardType::PIX
export const CARD_TYPE_PIX = "pix";
// CardType::UNKNOWN
const CARD_TYPE_UNKNOWN = "generic_card";

// StripeCardType::CARD_TYPES (legacy token brands) and NEW_CARD_TYPES (payment method brands and method types)
const TOKEN_CARD_TYPES: Record<string, string> = {
  Visa: "visa",
  "American Express": "amex",
  MasterCard: "mastercard",
  Discover: "discover",
  JCB: "jcb",
  "Diners Club": "diners",
  UnionPay: "unionpay",
};
const NEW_CARD_TYPES: Record<string, string> = {
  visa: "visa",
  amex: "amex",
  mastercard: "mastercard",
  discover: "discover",
  jcb: "jcb",
  diners: "diners",
  unionpay: "unionpay",
  link: "link",
  upi: "upi",
  ideal: "ideal",
  pix: CARD_TYPE_PIX,
  bancontact: "bancontact",
  klarna: "klarna",
  alipay: "alipay",
};

const own = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// StripeChargeableToken#card_type: the legacy brand names, nil when the token carries no brand.
export function tokenCardType(brand: string | null): string | null {
  return present(brand) ? (own(TOKEN_CARD_TYPES, brand) ?? CARD_TYPE_UNKNOWN) : null;
}

// StripeChargeablePaymentMethod#card_type: the card brand when there is one, else the payment method's own type (this is
// where a Pix purchase's card type comes from) unless it maps to nothing, which stays nil.
export function paymentMethodCardType(facts: { brand: string | null; methodType: string | null }): string | null {
  if (present(facts.brand)) return own(NEW_CARD_TYPES, facts.brand) ?? CARD_TYPE_UNKNOWN;
  if (!present(facts.methodType)) return null;
  const mapped = own(NEW_CARD_TYPES, facts.methodType) ?? CARD_TYPE_UNKNOWN;
  return mapped === CARD_TYPE_UNKNOWN ? null : mapped;
}
