// Port of ReceiptPresenter and its parts (app/presenters/receipt_presenter/*.rb) for the receipts Node renders:
// one successful USD purchase of a digital or physical product, sold outside a subscription, preorder, gift,
// bundle, rental, call or commission. Everything here is a pure function of rows the mailer has already read
// (in the statement order Rails reads them), so receipt-presenter.test.ts can call it directly.
//
// Anything outside that shape throws MailViewNotPortedError in `assertSupported`, before a statement is sent
// for it, and the delivery goes back to Rails.
import { isBlank } from "../../html/text-helper.ts";
import { formatJustPriceInCents, formattedPrice } from "../../models/concerns/money-formatter.ts";
import { LinkFlags } from "../../models/link.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { localizeTime, pluralize, truncate } from "../view-helpers.ts";
import { h, MailViewNotPortedError } from "../views.ts";

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
  shipping_cents: number;
  tax_cents: number | null;
  gumroad_tax_cents: number | null;
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

export type ReceiptCustomField = { name: string; value: string | boolean; type: string };
export type ReceiptRefundPolicy = { title: string; fine_print: string | null };

// What the receipt reads about one purchase.
export type ReceiptData = {
  purchase: ReceiptPurchaseRow;
  link: ReceiptLinkRow;
  seller: ReceiptSellerRow;
  urlRedirectToken: string | null;
  variantNames: string[] | null;
  tipValueCents: number | null;
  customFields: ReceiptCustomField[];
  refundPolicy: ReceiptRefundPolicy | null;
};

const purchaseFlag = (purchase: ReceiptPurchaseRow, name: Parameters<typeof PurchaseFlags.isSet>[1]) => PurchaseFlags.isSet(purchase.flags ?? 0, name);
const linkFlag = (link: ReceiptLinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(link.flags ?? 0, name);

const NOT_PORTED_PURCHASE_FLAGS = [
  "is_gift_receiver_purchase",
  "is_gift_sender_purchase",
  "is_preorder_authorization",
  "is_rental",
  "is_free_trial_purchase",
  "is_upgrade_purchase",
  "is_bundle_purchase",
  "is_bundle_product_purchase",
  "is_commission_deposit_purchase",
  "is_commission_completion_purchase",
  "is_installment_payment",
  "is_original_subscription_purchase",
  "is_part_of_combined_charge",
  "was_purchase_taxable",
  "is_multiseat_license",
] as const;

const NOT_PORTED_LINK_FLAGS = ["is_recurring_billing", "is_in_preorder_state", "is_licensed", "is_bundle", "free_trial_enabled", "is_tiered_membership", "is_multiseat_license"] as const;
// Link::NATIVE_TYPES whose thumbnail, wording and attributes are the plain product ones; a physical product is a digital one with is_physical.
const SUPPORTED_NATIVE_TYPES = ["digital", "course", "ebook"];

// The receipts below render exactly as Rails does; the rest go back to Rails.
export function assertSupported(data: ReceiptData): void {
  const { purchase, link, seller } = data;
  const refuse = (reason: string): never => {
    throw new MailViewNotPortedError(`receipt for ${reason}`);
  };
  if (purchase.purchase_state !== "successful") refuse(`a purchase in state ${String(purchase.purchase_state)}`);
  for (const flag of NOT_PORTED_PURCHASE_FLAGS) if (purchaseFlag(purchase, flag)) refuse(`a purchase with ${flag}`);
  for (const flag of NOT_PORTED_LINK_FLAGS) if (linkFlag(link, flag)) refuse(`a product with ${flag}`);
  if (purchase.subscription_id !== null || purchase.price_id !== null) refuse("a subscription purchase");
  if (purchase.preorder_id !== null) refuse("a preorder");
  // Footer: the "test purchase" warning for a seller buying their own product.
  if (purchase.purchaser_id !== null && BigInt(purchase.purchaser_id) === BigInt(link.user_id)) refuse("a test purchase");
  if (purchase.displayed_price_currency_type !== "usd" || link.price_currency_type !== "usd") refuse(`a purchase priced in ${String(purchase.displayed_price_currency_type)}`);
  if ((purchase.tax_cents ?? 0) > 0 || (purchase.gumroad_tax_cents ?? 0) > 0) refuse("a taxed purchase");
  if (!SUPPORTED_NATIVE_TYPES.includes(link.native_type ?? "")) refuse(`a ${String(link.native_type)} product`);
  if (!["no_recommendations", "own_products"].includes(seller.recommendation_type ?? "")) refuse(`a seller with recommendation type ${String(seller.recommendation_type)}`);
  if (isBlank(displayName(seller))) refuse("a seller without a display name");
}

// --- text helpers -----------------------------------------------------------------------------------

// What `auto_link(text, html: { target: "_blank" })` returns unchanged apart from sanitizing: plain ASCII with
// no markup, links, addresses or entities. Everything else (rails_autolink and the HTML sanitizer) is not ported.
const AUTO_LINK_SAFE = /^[\x20-\x7e¢]*$/u;
export function autoLinkText(text: string): string {
  if (!AUTO_LINK_SAFE.test(text) || /[<>\\@]|:\/\/|www\.|&[#A-Za-z0-9]+;/iu.test(text)) throw new MailViewNotPortedError(`auto_link of ${JSON.stringify(text)}`);
  return h(text);
}

// `simple_format` for the same plain text: paragraphs split on blank lines, single newlines followed by <br />.
export function simpleFormat(text: string): string {
  if (!/^[\x20-\x7e\n\r]*$/u.test(text) || /[<>\\@]|:\/\/|www\.|&/iu.test(text)) throw new MailViewNotPortedError(`simple_format of ${JSON.stringify(text)}`);
  const paragraphs = text.replace(/\r\n?/gu, "\n").split(/\n\n+/u).map((paragraph) => paragraph.replace(/([^\n]\n)(?=[^\n])/gu, "$1<br />"));
  if (paragraphs.length === 0 || (paragraphs.length === 1 && paragraphs[0] === "")) return "<p></p>";
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n\n");
}

// --- user ---------------------------------------------------------------------------------------------

const sellerUsername = (seller: ReceiptSellerRow) => (isBlank(seller.username) ? seller.external_id : seller.username);
const formEmail = (seller: ReceiptSellerRow) => (!isBlank(seller.unconfirmed_email) ? seller.unconfirmed_email : !isBlank(seller.email) ? seller.email : null);

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
  if (purchase.price_cents === 0) return `You got ${link.name}!`;
  return `You bought ${link.name}!`;
}

// --- ChargeInfo ----------------------------------------------------------------------------------------

// Time#to_fs(:formatted_date_abbrev_month), in UTC like the app's time zone.
export const formattedDateAbbrevMonth = (time: Date) => localizeTime(time, "%b %-d, %Y");

export const formattedDollarAmount = (cents: number | bigint | null) => formattedPrice("usd", cents === null ? 0 : Number(cents));

export function chargeInfo(data: ReceiptData, orderId: string) {
  const { purchase, seller } = data;
  return {
    orderId,
    formattedCreatedAt: formattedDateAbbrevMonth(purchase.created_at),
    // A free trial still counts as paid, but trials are not ported.
    free: purchase.price_cents === 0 && purchase.shipping_cents === 0,
    formattedTotalTransactionAmount: formattedDollarAmount(purchase.total_transaction_cents),
    // for_email: true
    productQuestionsNote: `Questions about your ${pluralize(1, "product", "products").slice(2)}? Contact ${h(displayName(seller))} by replying to this email.`,
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
  const parts = [purchase.street_address ?? "", `${purchase.city ?? ""}, ${purchase.state ?? ""} ${purchase.zip_code ?? ""}`, purchase.country ?? ""];
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
  const { purchase, link } = data;
  const free = purchase.price_cents === 0 && purchase.shipping_cents === 0;
  const productLabel = purchase.quantity <= 1 ? link.name : `${link.name} × ${purchase.quantity}`;

  const today: Attribute[] = [];
  if (!free) today.push({ label: productLabel, text: formattedDollarAmount(purchase.displayed_price_cents) });
  if (purchase.shipping_cents > 0) today.push({ label: "Shipping", text: formattedDollarAmount((purchase.total_transaction_cents ?? 0) === 0 ? 0 : purchase.shipping_cents) });
  // A single item with no shipping or tax shows no total.
  if (purchase.shipping_cents > 0) today.push({ label: "Amount paid", text: formattedDollarAmount(purchase.total_transaction_cents ?? 0) });
  if (!free) today.push({ label: null, html: invoiceLink });

  const notes: string[] = [];
  notes.push("All charges are processed in United States Dollars. Your bank or financial institution may apply their own fees for currency conversion.");
  if (!isBlank(purchase.card_type) && !NO_CARD_STATEMENT_TYPES.includes(purchase.card_type!)) {
    notes.push("The charge will be listed as GUMRD.COM* on your credit card statement.");
  }

  let paymentMethod: Attribute | null = null;
  if (!(isBlank(purchase.card_type) && isBlank(purchase.card_visual))) {
    const visual = isBlank(purchase.card_visual) ? null : purchase.card_visual!.replaceAll("*", "").replaceAll(" ", "");
    paymentMethod = { label: "Payment method", text: visual === null ? purchase.card_type!.toUpperCase() : `${purchase.card_type!.toUpperCase()} *${visual}` };
  }

  return { present: today.length > 0, title: "Payment info", notes, todayPaymentAttributes: today, upcomingPaymentAttributes: [] as Attribute[], paymentMethodAttribute: paymentMethod };
}

// --- ItemInfo ------------------------------------------------------------------------------------------

export function itemInfo(data: ReceiptData, customReceiptText: string | null) {
  const { purchase, link } = data;
  const notes: string[] = [];
  if (linkFlag(link, "is_physical")) notes.push("Your order will ship shortly. The creator will notify you when your package is on its way.");

  const general: Attribute[] = [];
  if (data.variantNames !== null && data.variantNames.length > 0) {
    const names = data.variantNames;
    // variant_names_displayable
    general.push({ label: "Variant", text: names.length === 1 && names[0] === "Untitled" ? "" : names.join(", ") });
  }
  if (purchase.price_cents !== 0 || purchase.shipping_cents !== 0) {
    general.push({ label: "Product price", text: formatJustPriceInCents(Math.trunc(purchase.displayed_price_cents / purchase.quantity) - (data.tipValueCents ?? 0), "usd") });
  }
  if (data.tipValueCents !== null) general.push({ label: "Tip", text: formatJustPriceInCents(data.tipValueCents, "usd") });
  if (purchase.quantity > 1) general.push({ label: "Quantity", text: String(purchase.quantity) });
  for (const field of data.customFields) {
    if (field.type === "checkbox") general.push({ label: field.name, text: field.value ? "Yes" : "No" });
    else if (field.type === "text") general.push({ label: field.name, text: String(field.value) });
    else throw new MailViewNotPortedError(`custom field of type ${field.type}`);
  }
  if (data.refundPolicy) general.push({ label: data.refundPolicy.title, text: data.refundPolicy.fine_print ?? "" });

  return {
    notes,
    customReceiptNote: customReceiptText,
    showDownloadButton: data.urlRedirectToken !== null,
    generalAttributes: general,
  };
}

// --- FooterInfo ----------------------------------------------------------------------------------------

// can_manage_subscription? is false for everything ported: the product is not recurring.
export const canManageSubscription = () => false;

export { truncate };
