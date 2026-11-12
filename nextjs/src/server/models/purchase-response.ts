// Purchase#purchase_response for the free checkout (app/models/purchase.rb, Purchase::PingNotification): the
// line item `POST /orders` answers with. A pure function over rows the caller has already read, so what it
// cannot render yet is refused up front and the request hands back before anything is written. Verified against
// the 13 served shapes of spec/requests/orders_free_purchase_parity_spec.rb (purchase-response.test.ts).

import type { Link, Purchase, UrlRedirect, User } from "@prisma/client";

import { encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { cgiEscape } from "../infra/signed-urls.ts";
import { viewContentButtonText } from "../mail/mailers/customer-mail-support.ts";
import { emailDigest, raterAccountName } from "../page-props/buyer/reviews.ts";
import { domainConfig } from "../page-props/domain.ts";
import { longUrl } from "../presenters/product.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { LinkFlags } from "./link.ts";
import { UrlRedirectFlags } from "./url-redirect.ts";
import { NotPortedError } from "./user.ts";

// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "test_successful",
  "preorder_concluded_successfully",
] as const;

// Integration::ALL_NAMES, in the constant's order.
export const INTEGRATION_NAMES = ["circle", "discord", "zoom", "google_calendar"] as const;

// What the caller reads for the response, beyond the rows themselves.
export type PurchaseResponseFacts = {
  purchase: Purchase;
  link: Link;
  seller: User;
  purchaser: User | null;
  urlRedirect: UrlRedirect | null;
  // `link.has_files?` and `link.has_stampable_pdfs?`
  hasFiles: boolean;
  hasStampablePdfs: boolean;
  // Follower.active.where(email:, followed_id: seller.id).exists?
  isFollowing: boolean;
  // link.has_third_party_analytics?("receipt")
  hasThirdPartyAnalytics: boolean;
  // Integration.enabled_integrations_for(purchase)
  enabledIntegrations: Record<(typeof INTEGRATION_NAMES)[number], boolean>;
  // purchase_url_parameter&.params, parsed
  urlParameters: Record<string, unknown> | null;
};

function refuse(reason: string): never {
  throw new NotPortedError("the purchase response", reason);
}

const isSet = (purchase: Purchase, flag: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(purchase.flags, flag);
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// Rails' Time#as_json: ISO 8601 with milliseconds.
const asJson = (time: Date) => time.toISOString();

// Everything the free path can reach but the response below does not render: the purchase is handed back.
function assertPlainFreePurchase({ purchase, link, seller, purchaser, urlRedirect }: PurchaseResponseFacts): void {
  const checks: [boolean, string][] = [
    [purchase.price_cents !== 0 || purchase.displayed_price_cents !== 0, "a priced purchase"],
    [
      link.price_currency_type !== "usd" || purchase.displayed_price_currency_type !== "usd",
      "a product in another currency",
    ],
    [purchase.offer_code_id !== null, "a discount code"],
    [purchase.subscription_id !== null || LinkFlags.isSet(link.flags, "is_recurring_billing"), "a membership"],
    [purchase.preorder_id !== null || LinkFlags.isSet(link.flags, "is_in_preorder_state"), "a pre-order"],
    [LinkFlags.isSet(link.flags, "is_physical") || LinkFlags.isSet(link.flags, "skus_enabled"), "a physical product"],
    [LinkFlags.isSet(link.flags, "is_licensed"), "a licensed product"],
    [LinkFlags.isSet(link.flags, "is_bundle") || isSet(purchase, "is_bundle_purchase"), "a bundle"],
    [isSet(purchase, "is_gift_receiver_purchase") || isSet(purchase, "is_gift_sender_purchase"), "a gift"],
    [purchase.affiliate_id !== null || purchase.affiliate_credit_cents !== 0, "an affiliate sale"],
    [
      purchase.tax_cents !== 0 || (purchase.gumroad_tax_cents ?? 0) !== 0 || isSet(purchase, "was_purchase_taxable"),
      "sales tax",
    ],
    [purchase.shipping_cents !== 0, "shipping"],
    [purchase.variants !== null, "variants"],
    [link.max_purchase_count !== null, "a purchase limit"],
    [present(purchase.custom_fields), "custom fields"],
    [purchaser?.id === seller.id, "a test purchase"],
    [urlRedirect === null, "a purchase without a url redirect"],
  ];
  for (const [refused, reason] of checks) if (refused) refuse(reason);
}

// Link#social_share_text (not in pre-order state)
export const socialShareText = (link: Pick<Link, "name">, seller: Pick<User, "twitter_handle">): string =>
  present(seller.twitter_handle)
    ? `I got ${link.name} from @${seller.twitter_handle} on @Gumroad`
    : `I got ${link.name} on @Gumroad`;

// SocialShareUrlHelper#twitter_url
export const twitterUrl = (url: string, text: string) =>
  `https://twitter.com/intent/tweet?text=${cgiEscape(text)}:%20${url}`;

// Purchase#purchase_response
export function purchaseResponse(facts: PurchaseResponseFacts): Record<string, unknown> {
  assertPlainFreePurchase(facts);
  const { purchase, link, seller, purchaser, urlRedirect } = facts;
  const config = domainConfig(process.env);
  const domain = config.domain;

  const hasContent =
    urlRedirect !== null &&
    !purchase.webhook_failed &&
    !(facts.hasStampablePdfs && !UrlRedirectFlags.isSet(urlRedirect.flags, "is_done_pdf_stamping"));
  const successfulAndNotReversed =
    !purchase.stripe_refunded &&
    purchase.chargeback_date === null &&
    (ALL_SUCCESS_STATES as readonly string[]).includes(purchase.purchase_state ?? "");
  const shareText = socialShareText(link, seller);
  const productUrl = longUrl(link as never, seller as never);
  const externalId = encrypt(purchase.id);
  const sellerExternalId = encrypt(seller.id);

  const purchaseInfo: Record<string, unknown> = {
    created_at: asJson(purchase.created_at ?? refuse("a purchase without created_at")),
    should_show_receipt: successfulAndNotReversed,
    was_paid: false,
    show_view_content_button_on_product_page: hasContent,
    is_recurring_billing: false,
    is_physical: false,
    has_files: facts.hasFiles,
    product_id: encrypt(link.id),
    is_gift_receiver_purchase: false,
    gift_receiver_text: " bought this for you.",
    is_gift_sender_purchase: false,
    gift_sender_text: "You bought this for .",
    content_url: hasContent ? `${config.protocol}://${domain}/d/${urlRedirect.token}` : null,
    redirect_token: urlRedirect?.token ?? null,
    url_redirect_external_id: urlRedirect ? encrypt(urlRedirect.id) : null,
    price: "$0",
    id: externalId,
    email: purchase.email,
    email_digest: emailDigest(purchase),
    full_name: purchase.full_name,
    view_content_button_text: viewContentButtonText(link),
    is_following: facts.isFollowing,
    currency_type: link.price_currency_type,
    has_third_party_analytics: facts.hasThirdPartyAnalytics,
    non_formatted_price: 0,
    subscription_has_lapsed: false,
    domain,
    protocol: config.protocol,
    native_type: link.native_type,
    account_by_this_email_exists: purchase.purchaser_id !== null,
    display_product_reviews: LinkFlags.isSet(link.flags, "display_product_reviews"),
    review_account_name: raterAccountName(purchase, purchaser),
    has_shipping_to_show: false,
    shipping_amount: "$0",
    has_sales_tax_to_show: false,
    sales_tax_amount: "$0",
    non_formatted_seller_tax_amount: "0",
    was_tax_excluded_from_price: isSet(purchase, "was_tax_excluded_from_price"),
    sales_tax_label: null,
    has_sales_tax_or_shipping_to_show: false,
    total_price_including_tax_and_shipping: "$0",
    quantity: purchase.quantity,
    show_quantity: purchase.quantity > 1,
    enabled_integrations: facts.enabledIntegrations,
    variants_displayable: "",
  };

  const payload: Record<string, unknown> = {
    seller_id: sellerExternalId,
    product_id: encrypt(link.id),
    product_name: link.name,
    permalink: present(link.custom_permalink) ? link.custom_permalink : link.unique_permalink,
    product_permalink: productUrl,
    short_product_id: link.unique_permalink,
    email: purchase.email,
    price: purchase.price_cents,
    gumroad_fee: purchase.fee_cents,
    currency: link.price_currency_type,
    quantity: purchase.quantity,
    discover_fee_charged: isSet(purchase, "was_discover_fee_charged"),
    can_contact: Boolean(purchase.can_contact),
    referrer: purchase.referrer,
    card: { visual: purchase.card_visual, type: purchase.card_type, bin: null, expiry_month: null, expiry_year: null },
    order_number: encryptNumeric(Number(purchase.id)),
    sale_id: externalId,
    sale_timestamp: asJson(purchase.created_at ?? refuse("a purchase without created_at")),
  };
  if (present(purchase.full_name)) payload.full_name = purchase.full_name;
  if (purchaser) payload.purchaser_id = purchaser.external_id;
  if (facts.urlParameters && Object.keys(facts.urlParameters).length > 0) payload.url_params = facts.urlParameters;
  if (present(purchase.ip_country)) payload.ip_country = purchase.ip_country;
  payload.is_gift_receiver_purchase = false;
  payload.refunded = Boolean(purchase.stripe_refunded);
  payload.resource_name = "sale";
  payload.disputed = purchase.chargeback_date !== null;
  payload.dispute_won = isSet(purchase, "chargeback_reversed");

  // `ping_notification_payload.merge(response)`: the response's values win where the keys overlap.
  return {
    ...payload,
    ...purchaseInfo,
    success: true,
    permalink: link.unique_permalink,
    remaining: null,
    name: link.name,
    variants: { categories: [], skus: [], skus_enabled: false },
    extra_purchase_notice: null,
    twitter_share_url: twitterUrl(productUrl, shareText),
    twitter_share_text: shareText,
  };
}
