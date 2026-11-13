// Purchases::InvoicesController#new (GET /purchases/:purchase_id/invoice/new): the invoice form, built from InvoicePresenter.
//
// Served for one plain USD purchase seen by a signed-out visitor: a successful single purchase with no tax, shipping, refund, charge,
// subscription, gift, partial refund or presentment row, and a buyer in a country where Gumroad prints no tax registration other
// than the EU one. Everything else goes to
// Rails before the page renders. set_purchase (404), the noindex header and require_email_confirmation run ahead, as in
// controllers/purchase-invoices.ts.
import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { parseQuery } from "../../controllers/rails-query.ts";
import { getConfig } from "../../infra/config.ts";
import { noreplyEmail } from "../../mail/application-mailer.ts";
import { supportOrFormEmail } from "../../mail/mailers/customer-mail-support.ts";
import { formattedDateAbbrevMonth, formattedDollarAmount } from "../../mail/mailers/receipt-presenter.ts";
import { alpha2ByName, countryByAlpha2, COUNTRIES, isBlockedCountry } from "../../models/compliance-countries.ts";
import { Users, subdomainWithProtocol } from "../../models/user.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { domainConfig } from "../domain.ts";
import type { PageSpec } from "../pages.ts";

const STATE_KEY = "invoiceFormProps";
const NEW_PATH = /^\/purchases\/([^/.]+)\/invoice\/new$/u;
const SYRIA = "SY";
const WARNING = "Please enter the purchase's email address to generate the invoice.";
const INCORRECT_EMAIL = "Incorrect email address. Please try again.";

// BusinessIdLabels::COUNTRY_CODES and LABELS
const BUSINESS_ID_COUNTRY_CODES = [
  ..."AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "),
  ...["GB", "NO", "CH", "IS", "CA", "AU", "NZ", "ZA", "JP", "KR", "IN", "BR", "MX"],
];
const BUSINESS_ID_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE"
      .split(" ")
      .map((code) => [code, "VAT ID"]),
  ),
  GB: "GB VAT",
  NO: "MVA",
  CH: "MWST/TVA",
  IS: "VSK",
  CA: "GST/HST",
  AU: "ABN",
  NZ: "GST",
  ZA: "VAT vendor",
  JP: "Consumption tax",
  KR: "VAT registration",
  IN: "GST",
  BR: "CNPJ",
  MX: "RFC",
};

// The countries SupplierInfo prints a Gumroad tax registration for (the EU, the UK, Canada and the ones in TAX_REGISTRATIONS_BY_COUNTRY).
const EU_COUNTRY_CODES = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "),
);
const SUPPLIER_TAX_COUNTRIES = new Set([
  ...EU_COUNTRY_CODES,
  ...["GB", "AU", "NO", "IN", "JP", "NZ", "NG", "SG", "KR", "CH", "TH", "CA"],
]);

// flag_shih_tzu bit n is 1 << (n - 1): was_product_recommended, was_zipcode_check_performed, was_discover_fee_charged.
// Any other flag (gift, preorder, bundle, rental, ...) changes what InvoicePresenter prints.
const INVOICE_NEUTRAL_FLAGS = [9, 11, 16].reduce((mask, bit) => mask | (1n << BigInt(bit - 1)), 0n);

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Compliance::Countries.for_select.to_h
function countriesForSelect(): Record<string, string> {
  const pairs = COUNTRIES.filter((country) => !isBlockedCountry(country.alpha2) && country.alpha2 !== SYRIA)
    .map((country) => [country.alpha2, country.common_name] as const)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return Object.fromEntries(pairs);
}

// SupplierInfo#determine_gumroad_tax_labels_and_numbers for an EU country (the UK is checked ahead of the EU list and stays with Rails)
function supplierAttributes(alpha2: string | null) {
  const country = countryByAlpha2(getConfig("ADDRESS_COUNTRY", "US"));
  if (country === null) throw new HandBackToRails("an ADDRESS_COUNTRY that is not a country code");
  const zipPlusFour = `${getConfig("ADDRESS_ZIP", "94104")}-${getConfig("ADDRESS_ZIP_PLUS_FOUR", "5401")}`;
  return [
    { label: null, value: "Gumroad, Inc." },
    {
      label: "Office address",
      value: [
        getConfig("ADDRESS_STREET", "548 Market St"),
        `${getConfig("ADDRESS_CITY", "San Francisco")}, ${getConfig("ADDRESS_STATE", "CA")} ${zipPlusFour}`,
        country.common_name,
      ].join("\n"),
    },
    ...(alpha2 !== null && EU_COUNTRY_CODES.has(alpha2)
      ? [{ label: "VAT Registration Number", value: getConfig("VAT_REGISTRATION_NUMBER", "EU372030009") }]
      : []),
    { label: "Email", value: noreplyEmail() },
    { label: "Web", value: domainConfig(process.env).rootDomain },
    { label: null, value: "Products supplied by Gumroad." },
  ];
}

async function invoiceFormFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const externalId = NEW_PATH.exec(chain.request.path)?.[1];
  const id = externalId === undefined ? null : decrypt(safeDecode(externalId));
  const purchase = id === null ? null : await db.purchase.findUnique({ where: { id: BigInt(id) } });
  if (!purchase) throw new RoutingError("Not Found");
  chain.headers.set("x-robots-tag", "noindex");

  // require_email_confirmation
  const query = parseQuery(chain.request.queryString);
  if (query.email !== undefined && typeof query.email !== "string")
    throw new HandBackToRails("an email that is not text");
  if (!present(purchase.email)) throw new HandBackToRails("a purchase without an email");
  const submitted = typeof query.email === "string" ? query.email : "";
  if (!Buffer.from(purchase.email).equals(Buffer.from(submitted))) {
    return {
      halt: {
        status: 302,
        location: `/purchases/${externalId}/invoice/confirm`,
        flash: present(submitted) ? { alert: INCORRECT_EMAIL } : { warning: WARNING },
        headers: { "x-robots-tag": "noindex" },
        rescued: true,
      },
    };
  }

  if (railsLoggedInUser(chain.auth.context) !== null)
    throw new HandBackToRails("a signed-in visitor, whose billing details prefill the form");
  const link = await findLink(purchase.link_id!);
  if (link === null) throw new HandBackToRails("a purchase whose product row is missing");
  const seller = (await findUserById(link.user_id!))!;

  if (
    purchase.purchase_state !== "successful" ||
    (BigInt(purchase.flags) & ~INVOICE_NEUTRAL_FLAGS) !== 0n ||
    purchase.subscription_id !== null ||
    purchase.preorder_id !== null ||
    purchase.stripe_partially_refunded ||
    (purchase.price_cents ?? 0) <= 0 ||
    (purchase.shipping_cents ?? 0) !== 0 ||
    (purchase.gumroad_tax_cents ?? 0) !== 0 ||
    purchase.displayed_price_currency_type !== "usd" ||
    purchase.displayed_price_cents !== purchase.price_cents ||
    !present(purchase.state) ||
    link.native_type === "physical"
  )
    throw new HandBackToRails("a purchase whose invoice needs receipt amounts the port does not prove");
  const related =
    (await db.purchasePresentment.count({ where: { purchase_id: purchase.id } })) +
    (await db.purchaseSalesTaxInfo.count({ where: { purchase_id: Number(purchase.id) } })) +
    (await db.orderPurchase.count({ where: { purchase_id: purchase.id } })) +
    (await db.refund.count({ where: { purchase_id: purchase.id } }));
  if (related > 0) throw new HandBackToRails("a purchase with a presentment, sales tax info, order or refund row");
  const countryName = present(purchase.country) ? purchase.country : purchase.ip_country;
  const alpha2 = alpha2ByName(countryName);
  if (alpha2 !== null && SUPPLIER_TAX_COUNTRIES.has(alpha2) && !EU_COUNTRY_CODES.has(alpha2))
    throw new HandBackToRails("a buyer in a country with a Gumroad tax registration outside the EU");

  const purchaser =
    purchase.purchaser_id === null ? null : await db.user.findUnique({ where: { id: purchase.purchaser_id } });
  const fullName = present(purchase.full_name?.trim()) ? purchase.full_name.trim() : (purchaser?.name ?? "");
  const sellerRecord = Users.load(seller as never);
  const productLabel = purchase.quantity <= 1 ? link.name : `${link.name} × ${purchase.quantity}`;
  const cardType = purchase.card_type;
  const cardVisual = purchase.card_visual;
  const paymentMethod =
    present(cardType) || present(cardVisual)
      ? {
          label: "Payment method",
          value: present(cardVisual)
            ? `${cardType!.toUpperCase()} *${cardVisual.replaceAll("*", "").replaceAll(" ", "")}`
            : cardType!.toUpperCase(),
        }
      : null;
  const sellerName = present(seller.name)
    ? seller.name
    : present(seller.username)
      ? seller.username
      : seller.external_id;

  const props = {
    form_data: {
      address_fields: {
        full_name: fullName,
        street_address: purchase.street_address ?? "",
        city: purchase.city ?? "",
        state: purchase.state,
        zip_code: purchase.zip_code ?? "",
        country_code: alpha2 === null ? "" : (alpha2ByName(purchase.country) ?? ""),
      },
      email: purchase.email,
      business_name: "",
      vat_id: "",
      additional_notes: "",
      purchase_id: encrypt(purchase.id),
    },
    form_metadata: {
      heading: "Generate invoice",
      display_vat_id: false,
      vat_id_label: "Business VAT ID (Optional)",
      business_id_country_codes: BUSINESS_ID_COUNTRY_CODES,
      business_id_labels: BUSINESS_ID_LABELS,
      supplier_info: { heading: "Supplier", attributes: supplierAttributes(alpha2) },
      seller_info: {
        heading: "Creator",
        attributes: [
          { label: null, value: sellerName, link: subdomainWithProtocol(sellerRecord) },
          { label: "Email", value: supportOrFormEmail(seller as never) },
        ],
      },
      order_info: {
        heading: "Invoice",
        form_attributes: [
          { label: "Email", value: purchase.email },
          { label: "Item purchased", value: null },
          { label: productLabel, value: formattedDollarAmount(purchase.price_cents) },
          { label: "Payment Total", value: formattedDollarAmount(purchase.total_transaction_cents) },
          // no refund rows (guarded above), so no "on <date>" suffix
          ...(purchase.stripe_refunded ? [{ label: "Refund status", value: "Fully refunded" }] : []),
          ...(paymentMethod ? [paymentMethod] : []),
        ],
        invoice_date_attribute: { label: "Date", value: formattedDateAbbrevMonth(purchase.created_at!) },
      },
      countries: countriesForSelect(),
    },
    payment_id: encrypt(purchase.id),
    payments: [],
  };
  return { state: { [STATE_KEY]: props, title: "Generate invoice" } };
}

export const invoiceFormPage: PageSpec = {
  component: "Purchases/Invoices/New",
  options: { filters: invoiceFormFilters },
  props: (_params, action) => {
    const built = action.state[STATE_KEY] as Record<string, unknown> | undefined;
    if (built === undefined) throw new HandBackToRails("the invoice form without its filter chain");
    action.meta.set({ title: action.state.title as string });
    return built;
  },
};
