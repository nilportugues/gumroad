// Port of ReceiptPresenter and its parts (app/presenters/receipt_presenter/*.rb) for the receipts Node renders:
// one successful purchase of a digital or physical product, sold outside a subscription, preorder, gift,
// bundle, call or commission. Everything here is a pure function of rows the mailer has already read
// (in the statement order Rails reads them), so receipt-presenter.test.ts can call it directly.
//
// Anything outside that shape throws MailViewNotPortedError in `assertSupported`, before a statement is sent
// for it, and the delivery goes back to Rails.
import { isBlank } from "../../html/text-helper.ts";
import { rubyStringToF } from "../../models/concerns/currency-helper.ts";
import {
  formatChargePresentmentAmount,
  formatJustPriceInCents,
  formattedPrice,
  knownCurrency,
} from "../../models/concerns/money-formatter.ts";
import { LinkFlags } from "../../models/link.ts";
import { RECURRENCE_LONG_INDICATOR } from "../../models/purchase-json.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { linkTo, localizeTime, pluralize, truncate } from "../view-helpers.ts";
import { h, mailerUrl, MailViewNotPortedError } from "../views.ts";

import type { TaxLine } from "./receipt-tax.ts";

type Id = number | bigint;

export type ReceiptPurchaseRow = {
  id: Id;
  link_id: Id;
  seller_id: Id;
  purchaser_id: Id | null;
  email: string | null;
  flags: Id | null;
  purchase_state: string | null;
  price_cents: number;
  total_transaction_cents: number | null;
  displayed_price_cents: number;
  displayed_price_currency_type: string | null;
  rate_converted_to_usd: string | null;
  shipping_cents: number;
  tax_cents: number | null;
  gumroad_tax_cents: number | null;
  zip_tax_rate_id: Id | null;
  quantity: number;
  created_at: Date;
  subscription_id: Id | null;
  preorder_id: Id | null;
  price_id: Id | null;
  card_type: string | null;
  card_visual: string | null;
  full_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  offer_code_id: Id | null;
};

export type ReceiptLinkRow = {
  id: Id;
  user_id: Id;
  name: string;
  unique_permalink: string | null;
  custom_permalink: string | null;
  support_email: string | null;
  json_data: string | null;
  flags: Id | null;
  native_type: string | null;
  price_currency_type: string | null;
  require_shipping: boolean | number | null;
};

export type ReceiptSellerRow = {
  id: Id;
  name: string | null;
  username: string | null;
  email: string | null;
  unconfirmed_email: string | null;
  support_email: string | null;
  external_id: string | null;
  recommendation_type: string | null;
};

// The purchase's buyer-currency amounts (PurchasePresentment), in the currency the buyer was charged in.
export type Presentment = {
  currency: string;
  priceCents: number;
  tipCents: number;
  sellerTaxCents: number;
  gumroadTaxCents: number;
  shippingCents: number;
  totalCents: number;
};

export type ReceiptCustomField = { name: string; value: string | boolean; type: string };
export type ReceiptRefundPolicy = { title: string; fine_print: string | null };

// What the receipt reads about one purchase.
export type ReceiptData = {
  purchase: ReceiptPurchaseRow;
  link: ReceiptLinkRow;
  seller: ReceiptSellerRow;
  // get_usd_cents(displayed_price_currency_type, displayed_price_cents, rate: rate_converted_to_usd)
  displayedPriceUsdCents: number;
  // BuyerPresentmentDisplay: set when the receipt is stated in the buyer's currency
  presentment: Presentment | null;
  // PaymentInfo#today_tax_price_attributes: null when the purchase is not taxable
  taxLines: TaxLine[] | null;
  urlRedirectToken: string | null;
  // UrlRedirect#is_rental, and Link#streamable? (a live video file), read only for a rental redirect
  urlRedirectIsRental: boolean;
  linkStreamable: boolean | null;
  // Purchase#license_key
  licenseKey: string | null;
  variantNames: string[] | null;
  tipValueCents: number | null;
  customFields: ReceiptCustomField[];
  refundPolicy: ReceiptRefundPolicy | null;
  // Purchase#gift_given for a gift the buyer sent, Purchase#gift_received for one the buyer got
  gift: ReceiptGift | null;
  // Purchase#subscription, read for a membership
  subscription: ReceiptSubscription | null;
  // Purchase#price_for_recurrence: the recurrence of the purchase's price row, which suffixes the product price
  priceRecurrence: string | null;
};

export type ReceiptSubscriptionRow = {
  id: Id;
  flags: Id | null;
  charge_occurrence_count: number | null;
  free_trial_ends_at: Date | null;
};

export type ReceiptSubscription = {
  row: ReceiptSubscriptionRow;
  externalId: string;
  // Subscription#recurrence
  recurrence: string | null;
  // The first charge after this receipt: PaymentInfo#upcoming_price_attribute
  nextPayment: { cents: number; date: Date } | null;
  // Whether the membership's original purchase was a gift the buyer sent
  gift: boolean;
};

export type ReceiptGift = {
  giftee_email: string | null;
  gift_note: string | null;
  flags: number | bigint | null;
  gifter_email?: string | null;
  gifter_purchase_id?: Id | null;
};
const GIFT_IS_RECIPIENT_HIDDEN = 1;
const GIFT_IS_GIFTER_HIDDEN = 2;

const purchaseFlag = (purchase: ReceiptPurchaseRow, name: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(purchase.flags ?? 0, name);
const linkFlag = (link: ReceiptLinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) =>
  LinkFlags.isSet(link.flags ?? 0, name);

const NOT_PORTED_PURCHASE_FLAGS = [
  "is_preorder_authorization",
  "is_upgrade_purchase",
  "is_bundle_purchase",
  "is_bundle_product_purchase",
  "is_commission_deposit_purchase",
  "is_commission_completion_purchase",
  "is_installment_payment",
  "is_part_of_combined_charge",
  "is_multiseat_license",
] as const;

const NOT_PORTED_LINK_FLAGS = ["is_in_preorder_state", "is_bundle", "is_multiseat_license"] as const;
// Link::NATIVE_TYPES whose thumbnail, wording and attributes are the plain product ones; a physical product is a digital one with is_physical.
const SUPPORTED_NATIVE_TYPES = [
  "digital",
  "course",
  "ebook",
  "newsletter",
  "podcast",
  "audiobook",
  "physical",
  "coffee",
  "membership",
];

// The first receipt of a membership, or of its free trial. A renewal, an upgrade, a fixed-length membership, an
// installment plan and a gifted membership render other sections.
function assertSupportedMembership(data: ReceiptData): void {
  const { purchase, link, subscription } = data;
  const refuse = (reason: string): never => {
    throw new MailViewNotPortedError(`receipt for ${reason}`);
  };
  if (subscription === null) return refuse("a membership without a subscription");
  if (!purchaseFlag(purchase, "is_original_subscription_purchase")) refuse("a renewal of a membership");
  if (purchase.price_id === null) refuse("a membership purchase without a price");
  if (purchaseFlag(purchase, "is_gift_sender_purchase") || purchaseFlag(purchase, "is_gift_receiver_purchase"))
    refuse("a gifted membership");
  const { row } = subscription;
  if (row.charge_occurrence_count !== null) refuse("a fixed-length membership");
  const subscriptionFlags = row.flags ?? 0;
  if (
    SubscriptionFlags.isSet(subscriptionFlags, "is_installment_plan") ||
    SubscriptionFlags.isSet(subscriptionFlags, "is_test_subscription")
  )
    refuse("an installment plan or a test subscription");
  if (purchaseFlag(purchase, "is_free_trial_purchase") && row.free_trial_ends_at === null)
    refuse("a trial without an end");
  // The next charge is priced in the purchase's currency, which only a dollar product leaves unconverted.
  if (link.price_currency_type !== "usd" || purchase.displayed_price_currency_type !== "usd")
    refuse("a membership priced in another currency");
}

// The receipts below render exactly as Rails does; the rest go back to Rails.
export function assertSupported(data: ReceiptData): void {
  const { purchase, link, seller } = data;
  const refuse = (reason: string): never => {
    throw new MailViewNotPortedError(`receipt for ${reason}`);
  };
  const giftReceived = purchaseFlag(purchase, "is_gift_receiver_purchase");
  const membership = linkFlag(link, "is_recurring_billing");
  const trial = purchaseFlag(purchase, "is_free_trial_purchase");
  // A trial is recorded without a charge: the one receipt of a purchase that is not successful.
  const expectedState = giftReceived ? "gift_receiver_purchase_successful" : trial ? "not_charged" : "successful";
  if (purchase.purchase_state !== expectedState) refuse(`a purchase in state ${String(purchase.purchase_state)}`);
  if (membership !== (link.native_type === "membership")) refuse("a recurring product that is not a membership");
  if (
    !membership &&
    (trial ||
      purchaseFlag(purchase, "is_original_subscription_purchase") ||
      linkFlag(link, "is_tiered_membership") ||
      linkFlag(link, "free_trial_enabled"))
  )
    refuse("a subscription purchase");
  if (membership) assertSupportedMembership(data);
  for (const flag of NOT_PORTED_PURCHASE_FLAGS) if (purchaseFlag(purchase, flag)) refuse(`a purchase with ${flag}`);
  for (const flag of NOT_PORTED_LINK_FLAGS) if (linkFlag(link, flag)) refuse(`a product with ${flag}`);
  if (purchaseFlag(purchase, "is_gift_sender_purchase")) {
    // A hidden recipient is named from their account; a physical gift adds shipping wording; a licensed one its key rules.
    const { gift } = data;
    if (gift === null || (Number(gift.flags ?? 0) & GIFT_IS_RECIPIENT_HIDDEN) !== 0)
      refuse("a gift the buyer sent to a hidden recipient");
    if (gift?.giftee_email === null || gift?.gift_note === null) refuse("a gift without a recipient or note");
    if (linkFlag(link, "is_physical") || linkFlag(link, "is_licensed")) refuse("a physical or licensed gift");
  }
  if (giftReceived) {
    // The receiver's own purchase is free; a priced, shipped or rented one renders sections that are not recorded.
    const { gift } = data;
    if (purchaseFlag(purchase, "is_gift_sender_purchase")) refuse("a purchase that is both sent and received");
    if (
      gift === null ||
      isBlank(gift.gifter_email) ||
      gift.gifter_purchase_id === null ||
      gift.gifter_purchase_id === undefined
    )
      refuse("a gift without a gifter");
    if ((Number(gift!.flags ?? 0) & GIFT_IS_RECIPIENT_HIDDEN) !== 0) refuse("a gift to a hidden recipient");
    if (!PLAIN_EMAIL.test(gift!.gifter_email!)) refuse("a gifter address that needs escaping");
    if (purchase.price_cents !== 0 || purchase.shipping_cents !== 0 || (purchase.total_transaction_cents ?? 0) !== 0)
      refuse("a gift receiver with a price");
    if (linkFlag(link, "is_physical") || purchaseFlag(purchase, "is_rental")) refuse("a physical or rented gift");
  }
  if (!membership && (purchase.subscription_id !== null || purchase.price_id !== null))
    refuse("a subscription purchase");
  if (purchase.preorder_id !== null) refuse("a preorder");
  // Footer: the "test purchase" warning for a seller buying their own product.
  if (purchase.purchaser_id !== null && BigInt(purchase.purchaser_id) === BigInt(link.user_id))
    refuse("a test purchase");
  const currency = purchase.displayed_price_currency_type;
  // A purchase without a stored rate looks the rate up in Redis; a currency the money gem does not know fails in Rails.
  if (isBlank(currency) || !knownCurrency(currency!)) refuse(`a purchase priced in ${String(currency)}`);
  if (
    currency !== "usd" &&
    (isBlank(purchase.rate_converted_to_usd) || rubyStringToF(purchase.rate_converted_to_usd!) === 0)
  )
    refuse(`a ${currency} purchase without a usable exchange rate`);
  if (!SUPPORTED_NATIVE_TYPES.includes(link.native_type ?? "")) refuse(`a ${String(link.native_type)} product`);
  if (!["no_recommendations", "own_products"].includes(seller.recommendation_type ?? ""))
    refuse(`a seller with recommendation type ${String(seller.recommendation_type)}`);
  if (isBlank(displayName(seller))) refuse("a seller without a display name");
}

// --- text helpers -----------------------------------------------------------------------------------

// What `auto_link(text, html: { target: "_blank" })` returns unchanged apart from sanitizing: plain ASCII with
// no markup, links, addresses or entities. Everything else (rails_autolink and the HTML sanitizer) is not ported.
// A text that is one plain address, which rails_autolink wraps whole in a mailto link.
export const PLAIN_EMAIL =
  /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*@[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*\.[A-Za-z]{2,}$/u;
const AUTO_LINK_SAFE = /^[\x20-\x7e¢€£¥₩]*$/u;
export const isGifterHidden = (gift: ReceiptGift) => (Number(gift.flags ?? 0) & GIFT_IS_GIFTER_HIDDEN) !== 0;
export function autoLinkText(text: string): string {
  if (PLAIN_EMAIL.test(text)) return `<a href="mailto:${text}" target="_blank">${text}</a>`;
  if (!AUTO_LINK_SAFE.test(text) || /[<>\\@]|:\/\/|www\.|&[#A-Za-z0-9]+;/iu.test(text))
    throw new MailViewNotPortedError(`auto_link of ${JSON.stringify(text)}`);
  return h(text);
}

// `simple_format` for the same plain text: paragraphs split on blank lines, single newlines followed by <br />.
export function simpleFormat(text: string): string {
  if (!/^[\x20-\x7e\n\r]*$/u.test(text) || /[<>\\@]|:\/\/|www\.|&/iu.test(text))
    throw new MailViewNotPortedError(`simple_format of ${JSON.stringify(text)}`);
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n\n+/u)
    .map((paragraph) => paragraph.replace(/([^\n]\n)(?=[^\n])/gu, "$1<br />"));
  if (paragraphs.length === 0 || (paragraphs.length === 1 && paragraphs[0] === "")) return "<p></p>";
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n\n");
}

// --- user ---------------------------------------------------------------------------------------------

const sellerUsername = (seller: ReceiptSellerRow) => (isBlank(seller.username) ? seller.external_id : seller.username);
const formEmail = (seller: ReceiptSellerRow) =>
  !isBlank(seller.unconfirmed_email) ? seller.unconfirmed_email : !isBlank(seller.email) ? seller.email : null;

// User#display_name
export function displayName(seller: ReceiptSellerRow): string | null {
  if (!isBlank(seller.name)) return seller.name;
  const username = sellerUsername(seller);
  return isBlank(username) ? formEmail(seller) : username;
}

// --- MailSubject ---------------------------------------------------------------------------------------

// ReceiptPresenter::MailSubject for one purchase, which is all `assertSupported` lets through.
export function mailSubject(data: ReceiptData): string {
  const { purchase, link } = data;
  if (purchaseFlag(purchase, "is_gift_receiver_purchase")) {
    const { gifter_email: gifterEmail, flags } = data.gift!;
    if ((Number(flags ?? 0) & GIFT_IS_GIFTER_HIDDEN) !== 0) return `Someone bought ${link.name} for you!`;
    // Purchase#gifter_full_name: with shipping info the full name is the giftee's, not the gifter's
    const named = !isBlank(purchase.full_name) && !(link.require_shipping === true || link.require_shipping === 1);
    return named
      ? `${purchase.full_name} (${gifterEmail}) bought ${link.name} for you!`
      : `${gifterEmail} bought ${link.name} for you!`;
  }
  if (purchaseFlag(purchase, "is_gift_sender_purchase")) return `You bought ${data.gift!.giftee_email} ${link.name}!`;
  // Only a membership's first charge gets here, so it is never "Recurring charge".
  if (linkFlag(link, "is_recurring_billing")) return `You've subscribed to ${link.name}!`;
  if (purchaseFlag(purchase, "is_rental")) return `You rented ${link.name}!`;
  if (purchase.price_cents === 0) return `You got ${link.name}!`;
  return `You bought ${link.name}!`;
}

// Purchase#buyer_presentment_price_cents: tips are part of the price, seller tax too unless it was excluded from it.
export function presentmentPriceCents(data: ReceiptData): number {
  const presentment = data.presentment!;
  return (
    presentment.priceCents +
    presentment.tipCents +
    (purchaseFlag(data.purchase, "was_tax_excluded_from_price") ? 0 : presentment.sellerTaxCents)
  );
}

// format_today_amount
const todayAmount = (data: ReceiptData, cents: number) =>
  data.presentment ? formatChargePresentmentAmount(cents, data.presentment.currency) : formattedDollarAmount(cents);

// --- ChargeInfo ----------------------------------------------------------------------------------------

// Time#to_fs(:formatted_date_abbrev_month), in UTC like the app's time zone.
export const formattedDateAbbrevMonth = (time: Date) => localizeTime(time, "%b %-d, %Y");

export const formattedDollarAmount = (cents: number | bigint | null) =>
  formattedPrice("usd", cents === null ? 0 : Number(cents));

export function chargeInfo(data: ReceiptData, orderId: string) {
  const { purchase, seller } = data;
  return {
    orderId,
    formattedCreatedAt: formattedDateAbbrevMonth(purchase.created_at),
    // A free trial still counts as paid: the buyer gave a card and the total explains the later charge.
    free:
      purchase.price_cents === 0 && purchase.shipping_cents === 0 && !purchaseFlag(purchase, "is_free_trial_purchase"),
    formattedTotalTransactionAmount: data.presentment
      ? formatChargePresentmentAmount(data.presentment.totalCents, data.presentment.currency)
      : formattedDollarAmount(purchase.total_transaction_cents),
    // for_email: true; none for the gift sender
    productQuestionsNote: purchaseFlag(purchase, "is_gift_sender_purchase")
      ? null
      : `Questions about your ${pluralize(1, "product", "products").slice(2)}? Contact ${h(displayName(seller))} by replying to this email.`,
  };
}

// --- attributes ----------------------------------------------------------------------------------------

// A line of an attributes table: a label and either text (auto_link'ed) or HTML the presenter built.
export type Attribute = { label: string | null; text: string } | { label: string | null; html: string };

// --- ShippingInfo --------------------------------------------------------------------------------------

export function shippingInfo(data: ReceiptData): { title: string; attributes: Attribute[] } {
  const { purchase, link } = data;
  const requiresShipping = link.require_shipping === true || link.require_shipping === 1;
  if (!requiresShipping) return { title: "Shipping info", attributes: [] };
  const parts = [
    purchase.street_address ?? "",
    `${purchase.city ?? ""}, ${purchase.state ?? ""} ${purchase.zip_code ?? ""}`,
    purchase.country ?? "",
  ];
  return {
    title: "Shipping info",
    attributes: [
      { label: "Shipping to", text: purchase.full_name ?? "" },
      // safe_join escapes each part; auto_link's sanitizer then writes the <br /> as <br>.
      { label: "Shipping address", html: parts.map(autoLinkText).join("<br>") },
    ],
  };
}

// --- PaymentInfo ---------------------------------------------------------------------------------------

const NO_CARD_STATEMENT_TYPES = ["paypal", "link", "upi", "ideal", "bancontact", "pix", "klarna", "alipay"];

export function paymentInfo(data: ReceiptData, invoiceLink: string) {
  const { purchase, link, subscription } = data;
  const trial = purchaseFlag(purchase, "is_free_trial_purchase");
  // Purchase#free_purchase?
  const free = purchase.price_cents === 0 && purchase.shipping_cents === 0;
  const productLabel = purchase.quantity <= 1 ? link.name : `${link.name} × ${purchase.quantity}`;

  const upcoming: Attribute[] = [];
  if (subscription?.nextPayment)
    upcoming.push(
      { label: "Upcoming payment", text: "" },
      {
        label: productLabel,
        text: `${formattedPrice("usd", subscription.nextPayment.cents)} on ${formattedDateAbbrevMonth(subscription.nextPayment.date)}`,
      },
    );
  const today: Attribute[] = [];
  if (upcoming.length > 0) today.push({ label: "Today's payment", text: "" });
  if (!free || trial)
    today.push({
      label: productLabel,
      text: todayAmount(data, trial ? 0 : data.presentment ? presentmentPriceCents(data) : data.displayedPriceUsdCents),
    });
  const moved = (purchase.total_transaction_cents ?? 0) !== 0;
  if (purchase.shipping_cents > 0)
    today.push({
      label: "Shipping",
      text: todayAmount(data, !moved ? 0 : data.presentment ? data.presentment.shippingCents : purchase.shipping_cents),
    });
  for (const line of data.taxLines ?? []) today.push({ label: line.label, text: todayAmount(data, line.cents) });
  // A single item with no shipping or tax shows no total.
  if (purchase.shipping_cents > 0 || data.taxLines !== null)
    today.push({
      label: "Amount paid",
      text: todayAmount(
        data,
        !moved ? 0 : data.presentment ? data.presentment.totalCents : purchase.total_transaction_cents!,
      ),
    });
  // Purchase#has_invoice?
  if (subscription ? !trial : !free) today.push({ label: null, html: invoiceLink });

  const notes: string[] = [];
  if (!data.presentment)
    notes.push(
      "All charges are processed in United States Dollars. Your bank or financial institution may apply their own fees for currency conversion.",
    );
  if (!isBlank(purchase.card_type) && !NO_CARD_STATEMENT_TYPES.includes(purchase.card_type!)) {
    notes.push("The charge will be listed as GUMRD.COM* on your credit card statement.");
  }

  let paymentMethod: Attribute | null = null;
  if (!trial && !(isBlank(purchase.card_type) && isBlank(purchase.card_visual))) {
    const visual = isBlank(purchase.card_visual) ? null : purchase.card_visual!.replaceAll("*", "").replaceAll(" ", "");
    paymentMethod = {
      label: "Payment method",
      text: visual === null ? purchase.card_type!.toUpperCase() : `${purchase.card_type!.toUpperCase()} *${visual}`,
    };
  }

  return {
    present: today.length > 0 || upcoming.length > 0,
    title: "Payment info",
    notes,
    todayPaymentAttributes: today,
    upcomingPaymentAttributes: upcoming,
    paymentMethodAttribute: paymentMethod,
  };
}

// --- ItemInfo ------------------------------------------------------------------------------------------

export function itemInfo(data: ReceiptData, customReceiptText: string | null) {
  const { purchase, link } = data;
  const coffee = link.native_type === "coffee";
  const notes: string[] = [];
  if (purchaseFlag(purchase, "is_free_trial_purchase")) notes.push("Your free trial has begun!");
  if (linkFlag(link, "is_physical"))
    notes.push("Your order will ship shortly. The creator will notify you when your package is on its way.");
  if (purchaseFlag(purchase, "is_rental"))
    notes.push(`Your rental of ${link.name} will expire in 30 days or 72 hours after you begin viewing it.`);

  const general: Attribute[] = [];
  if (data.variantNames !== null && data.variantNames.length > 0 && !coffee) {
    const names = data.variantNames;
    // variant_names_displayable
    general.push({ label: "Variant", text: names.length === 1 && names[0] === "Untitled" ? "" : names.join(", ") });
  }
  if (purchase.price_cents !== 0 || purchase.shipping_cents !== 0) {
    const perUnit = data.presentment
      ? formatChargePresentmentAmount(
          Math.trunc((presentmentPriceCents(data) - data.presentment.tipCents) / purchase.quantity),
          data.presentment.currency,
        )
      : formatJustPriceInCents(
          Math.trunc(purchase.displayed_price_cents / purchase.quantity) - (data.tipValueCents ?? 0),
          purchase.displayed_price_currency_type!,
        );
    // Purchase#format_price_in_cents appends the cadence of a membership's price.
    const cadence = data.priceRecurrence === null ? "" : ` ${recurrenceLongIndicator(data.priceRecurrence)}`;
    general.push({ label: coffee ? "Donation" : "Product price", text: `${perUnit}${cadence}` });
  }
  if (data.tipValueCents !== null) {
    general.push({
      label: "Tip",
      text: data.presentment
        ? formatChargePresentmentAmount(data.presentment.tipCents, data.presentment.currency)
        : formatJustPriceInCents(data.tipValueCents, purchase.displayed_price_currency_type!),
    });
  }
  if (purchase.quantity > 1 && !coffee && !purchaseFlag(purchase, "is_gift_sender_purchase"))
    general.push({ label: "Quantity", text: String(purchase.quantity) });
  for (const field of data.customFields) {
    if (field.type === "checkbox") general.push({ label: field.name, text: field.value ? "Yes" : "No" });
    else if (field.type === "text") general.push({ label: field.name, text: String(field.value) });
    else throw new MailViewNotPortedError(`custom field of type ${field.type}`);
  }
  if (data.refundPolicy) general.push({ label: data.refundPolicy.title, text: data.refundPolicy.fine_print ?? "" });

  const giftAttributes: Attribute[] = [];
  const giftSent = purchaseFlag(purchase, "is_gift_sender_purchase");
  if (giftSent) {
    giftAttributes.push({ label: "Gift sent to", text: data.gift!.giftee_email! });
    const note = data.gift!.gift_note!.trim();
    if (note !== "") giftAttributes.push({ label: "Message", text: note });
  }

  return {
    notes,
    customReceiptNote: customReceiptText,
    licenseKey: data.licenseKey,
    giftAttributes,
    showDownloadButton: data.urlRedirectToken !== null && !coffee && !giftSent,
    downloadCta: downloadCta(data),
    generalAttributes: general,
    manageSubscriptionNote: data.subscription === null ? null : manageMembershipNote(data.subscription),
  };
}

// ItemInfo#manage_membership_note for a membership that renews until cancelled.
function manageMembershipNote(subscription: ReceiptSubscription): string {
  const href = mailerUrl(`/subscriptions/${subscription.externalId}/manage`);
  return `You will be charged once ${recurrenceLongIndicator(subscription.recurrence)}. If you would like to manage your membership you can visit ${linkTo("subscription settings", href, { target: "_blank" })}.`;
}

function recurrenceLongIndicator(recurrence: string | null): string {
  const indicator = recurrence === null ? undefined : RECURRENCE_LONG_INDICATOR[recurrence];
  if (indicator === undefined) throw new MailViewNotPortedError(`recurrence ${String(recurrence)}`);
  return indicator;
}

// FooterInfo: the cadence and the link that replace the unsubscribe link of a membership's receipt.
export function manageSubscriptionFooter(subscription: ReceiptSubscription): string {
  const href = mailerUrl(`/subscriptions/${subscription.externalId}/manage`);
  return `${h(`You'll be charged once ${recurrenceLongIndicator(subscription.recurrence)}.`)}\n    ${linkTo("Manage membership", href)}`;
}

// shared/_download_button: a rental redirect gets "Watch" when the product has a video file and no button at all otherwise.
function downloadCta(data: ReceiptData): { label: string | null; path: string } | null {
  if (!data.urlRedirectIsRental) return { label: null, path: `/d/${data.urlRedirectToken}` };
  return data.linkStreamable ? { label: "Watch", path: `/s/${data.urlRedirectToken}` } : null;
}

export { truncate };
