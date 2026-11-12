// Port of CustomerMailer#receipt (app/mailers/customer_mailer.rb) with app/views/customer_mailer/receipt.html.erb and
// its partials, for the purchases `assertSupported` accepts. Pinned by receipt-mailer.golden.json
// (__fixtures__/generate-receipt-mailer-golden.rb), which records every statement the real mailer sends.
//
// Rails reads in the order the view asks; this reads in that order too, so the first occurrence of each distinct
// statement lands in the same place (repeats are query-cache hits in both).
import { Prisma } from "@prisma/client";
import type { Charge, Purchase } from "@prisma/client";

import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { isBlank } from "../../html/text-helper.ts";
import { domainConfig } from "../../infra/domain.ts";
import { ArgumentError, chargeOfPurchase, findChargeOrNil } from "../../models/charge.ts";
import { getUsdCents, rubyStringToF } from "../../models/concerns/currency-helper.ts";
import { LinkFlags } from "../../models/link.ts";
import { secureExternalId } from "../../models/secure-external-id.ts";
import { column, columnIn, inList, selectRows, table } from "../../models/sql.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { applicationMail, findRow, type MailerDeps, RecordNotFoundError } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { defaultRouterDeps, rubyToI } from "../mailer-info.ts";
import type { RubyValue } from "../ruby-value.ts";
import { linkTo } from "../view-helpers.ts";
import { emailLayout, h, mailerUrl, MailViewNotPortedError } from "../views.ts";

import {
  customersDeliveryOptions,
  customersNoreply,
  downloadButton,
  fromEmailAddressWithName,
  jsonDataString,
  productLongUrl,
  supportOrFormEmail,
  type UserRow,
  viewContentButtonText,
} from "./customer-mail-support.ts";
import {
  type Attribute,
  assertSupported,
  autoLinkText,
  chargeInfo,
  displayName,
  isGifterHidden,
  itemInfo,
  mailSubject,
  paymentInfo,
  type ReceiptCustomField,
  type ReceiptData,
  type ReceiptLinkRow,
  type ReceiptPurchaseRow,
  type ReceiptRefundPolicy,
  type ReceiptSellerRow,
  shippingInfo,
  simpleFormat,
} from "./receipt-presenter.ts";
import {
  cardPrice,
  floatToS,
  numberToSi,
  SAMPLED_ASSOCIATED_IDS,
  recommendedProducts,
  type RecommendedProducts,
} from "./receipt-recommended.ts";
import { taxLines } from "./receipt-tax.ts";

type Id = number | bigint;

const linkFlagSet = (link: ReceiptLinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) =>
  LinkFlags.isSet(link.flags ?? 0, name);

// RedisKey.recommended_products_associated_product_ids_limit
const ASSOCIATED_PRODUCT_IDS_LIMIT_KEY = "recommended_products_associated_product_ids_limit";

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);
const byPurchase = (tableName: string, purchaseId: Id, limit1: boolean, extra: Prisma.Sql = Prisma.empty) =>
  selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star(tableName)} FROM ${table(tableName)} WHERE ${column(tableName, "purchase_id")} = ${purchaseId}${extra}${limit1 ? Prisma.raw(" LIMIT 1") : Prisma.empty}`,
  );

// Everything below the first `Purchase.find_by`, in the order Rails sends it. A refusal before the last read is
// fine: the delivery goes back to Rails, nothing has been written.
async function loadReceiptData(
  purchase: ReceiptPurchaseRow & Record<string, unknown>,
): Promise<{ data: ReceiptData; supportEmails: (string | null)[] }> {
  const seller = (await findRow<ReceiptSellerRow>("users", purchase.seller_id))!;
  // `@chargeable.support_email`, ahead of the subject
  const supportEmails = await selectRows<{ support_email: string | null }>(
    Prisma.sql`SELECT ${column("links", "support_email")} FROM ${table("purchases")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("purchases", "link_id")} WHERE ${column("purchases", "id")} = ${purchase.id}`,
  );
  // MailSubject: `purchases.one?`, `purchases.first`, then `link_name`
  await selectRows(
    Prisma.sql`SELECT COUNT(*) FROM (SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id} LIMIT 2) subquery_for_count`,
  );
  await selectRows(
    Prisma.sql`SELECT ${star("purchases")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id} ORDER BY ${column("purchases", "id")} ASC LIMIT 1`,
  );
  const link = await findRow<ReceiptLinkRow>("links", purchase.link_id);
  if (!link) throw new TypeError("undefined method 'name' for nil");

  const data: ReceiptData = {
    purchase,
    link,
    seller,
    displayedPriceUsdCents: 0,
    presentment: null,
    taxLines: null,
    urlRedirectToken: null,
    urlRedirectIsRental: false,
    linkStreamable: null,
    licenseKey: null,
    variantNames: null,
    tipValueCents: null,
    customFields: [],
    refundPolicy: null,
    gift: null,
  };
  // MailSubject: `purchase.giftee_name_or_email` reads `gift_given` for a gift the buyer sent, and `gifter_email` reads
  // `gift_received` for one the buyer got.
  const giftSent = PurchaseFlags.isSet(purchase.flags ?? 0, "is_gift_sender_purchase");
  if (giftSent || PurchaseFlags.isSet(purchase.flags ?? 0, "is_gift_receiver_purchase")) {
    const [gift] = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT ${star("gifts")} FROM ${table("gifts")} WHERE ${column("gifts", giftSent ? "gifter_purchase_id" : "giftee_purchase_id")} = ${purchase.id} LIMIT 1`,
    );
    if (gift)
      data.gift = {
        giftee_email: (gift.giftee_email as string | null) ?? null,
        gift_note: (gift.gift_note as string | null) ?? null,
        flags: (gift.flags as number | bigint | null) ?? 0,
        gifter_email: (gift.gifter_email as string | null) ?? null,
        gifter_purchase_id: (gift.gifter_purchase_id as Id | null) ?? null,
      };
  }
  return { data, supportEmails: supportEmails.map((row) => row.support_email) };
}

// Chargeable#support_email
function supportEmail(data: ReceiptData, supportEmails: (string | null)[]): string | null {
  const unique = [...new Set(supportEmails)];
  if (unique.length === 1 && !isBlank(unique[0])) return unique[0]!;
  return supportOrFormEmail(data.seller as unknown as UserRow);
}

const rows = (statements: Prisma.Sql) => selectRows<Record<string, unknown>>(statements);

// The per-item reads of ReceiptPresenter::ItemInfo#props, in the order its hash is built.
async function loadItemData(data: ReceiptData): Promise<void> {
  const { purchase } = data;
  // ChargeInfo's presentment decision reads the buyer-currency row of every purchase that moved money.
  // show_download_button short-circuits on `!is_gift_sender_purchase`, so a gift the buyer sent never reads the redirect.
  const [redirect] = PurchaseFlags.isSet(purchase.flags ?? 0, "is_gift_sender_purchase")
    ? []
    : await byPurchase("url_redirects", purchase.id, true);
  // show_download_button
  if (redirect) {
    data.urlRedirectToken = String(redirect.token);
    data.urlRedirectIsRental = UrlRedirectFlags.isSet(Number(redirect.flags ?? 0), "is_rental");
  }
  if (linkFlagSet(data.link, "is_licensed")) {
    // Purchase#uses_license_key?: a licensed product with versions keeps its key only when the versions' content has a
    // license-key block, which is read from rich content the port does not.
    if (!linkFlagSet(data.link, "is_physical")) {
      const [version] = await rows(
        Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${data.link.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL LIMIT 1`,
      );
      if (version) throw new MailViewNotPortedError("license key of a product with versions");
    }
    const [license] = await byPurchase("licenses", purchase.id, true);
    data.licenseKey = isBlank(license?.serial as string | null | undefined) ? null : String(license!.serial);
  }
  const [call] = await byPurchase("calls", purchase.id, true);
  if (call) throw new MailViewNotPortedError("receipt for a call");
  // variant_names: not_is_default_sku, then without "Untitled"
  const variants = await rows(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id} AND ((${column("base_variants", "flags")} & 1 = 0))`,
  );
  if (variants.length > 0) {
    const named = await rows(
      Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id} AND ${column("base_variants", "name")} != ${"Untitled"}`,
    );
    data.variantNames = named.map((row) => String(row.name));
  }
  const [tip] = await byPurchase("tips", purchase.id, true);
  if (tip) data.tipValueCents = Number(tip.value_cents);
  data.customFields = (await byPurchase("purchase_custom_fields", purchase.id, false)).map(
    (row): ReceiptCustomField => {
      const type = String(row.field_type);
      // PurchaseCustomField#value: a boolean for terms and checkboxes, else the string
      const raw = row.value === null || row.value === undefined ? null : String(row.value);
      const value =
        type === "checkbox" || type === "terms"
          ? raw !== null && !["0", "f", "false", "off", "no", ""].includes(raw.toLowerCase())
          : (raw ?? "");
      return { name: String(row.name), value, type };
    },
  );
  // A gift's refund policy is on the gifter's purchase, not the receiver's.
  let policyPurchaseId = purchase.id;
  if (PurchaseFlags.isSet(purchase.flags ?? 0, "is_gift_receiver_purchase")) {
    const gifterPurchase = await findRow<{ id: Id }>("purchases", data.gift!.gifter_purchase_id!);
    if (!gifterPurchase) throw new MailViewNotPortedError("gift whose gifter purchase is missing");
    policyPurchaseId = gifterPurchase.id;
  }
  const [policy] = await byPurchase("purchase_refund_policies", policyPurchaseId, true);
  if (policy)
    data.refundPolicy = {
      title: String(policy.title),
      fine_print: policy.fine_print === null ? null : String(policy.fine_print),
    } satisfies ReceiptRefundPolicy;
  // card_for_email: the thumbnail, then the avatar
  const [thumbnail] = await rows(
    Prisma.sql`SELECT ${star("thumbnails")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} = ${data.link.id} AND ${column("thumbnails", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (thumbnail) throw new MailViewNotPortedError("product with a thumbnail");
}

// ---- views --------------------------------------------------------------------------------------------

function attributesPartial(attributes: Attribute[]): string {
  if (attributes.length === 0) return "";
  const body = attributes
    .map((attribute) => {
      const label = isBlank(attribute.label)
        ? ""
        : `              <span class="attribute-label">${h(attribute.label)}</span>\n              <br>\n`;
      const value = "html" in attribute ? attribute.html : autoLinkText(attribute.text);
      return `        <tr>\n          <td>\n${label}              ${value}\n          </td>\n        </tr>\n`;
    })
    .join("");
  return `  <table class="table-stack">\n    <tbody>\n${body}    </tbody>\n  </table>\n`;
}

function headerSection(info: ReturnType<typeof chargeInfo>): string {
  const total = info.free
    ? ""
    : `    <div class="info-row with-top-margin">\n      <span class="info-label">Total:</span>\n      <span class="info-value">${h(info.formattedTotalTransactionAmount)}</span>\n    </div>\n`;
  return `<div class="receipt">
  <div class="info-row">
    <span class="info-label">Order ID:</span>
    <span class="info-value">${h(info.orderId)}</span>
  </div>
  <div class="info-row with-top-margin">
    <span class="info-label">Order date:</span>
    <span class="info-value">${h(info.formattedCreatedAt)}</span>
  </div>
${total}</div>
`;
}

type Card = {
  name: string;
  thumbnailUrl: string;
  url: string;
  sellerName: string;
  sellerProfileUrl: string;
  sellerAvatarUrl: string;
};

function itemSection(item: ReturnType<typeof itemInfo>, card: Card, data: ReceiptData): string {
  const sellerLinks = `\n  <div class="section">
    <div class="footer" title="${h(card.sellerName)}">
      ${linkTo("", card.sellerProfileUrl, { target: "_blank" }).replace(/>[^<]*<\/a>$/u, `><img alt="${h(`Avatar of ${card.sellerName}`)}" class="user-avatar" src="${h(card.sellerAvatarUrl)}" /></a>`)}
      <span>
        ${linkTo(card.sellerName, card.sellerProfileUrl, { target: "_blank" })}
      </span>
    </div>
  </div>
`;
  const cell = `<div class="product-checkout-cell">
  <div class="figure">
      ${linkTo("", card.url, { target: "_blank" }).replace(/>[^<]*<\/a>$/u, `><img alt="${h(card.name)}" src="${h(card.thumbnailUrl)}" /></a>`)}
  </div>
  <div class="section">
    <div class="content">
      <div class="section" title="${h(card.name)}">
        <h4>
          ${linkTo(card.name, card.url, { target: "_blank" })}
        </h4>
      </div>
      <div class="section">
        ${sellerLinks}
      </div>
    </div>
  </div>
</div>
`;
  const notes = item.notes.map((note) => `    <p style="font-weight: bold">\n      ${h(note)}\n    </p>\n`).join("");
  const customNote = item.customReceiptNote === null ? "" : `    ${simpleFormat(item.customReceiptNote)}\n`;
  const cta = item.showDownloadButton ? item.downloadCta : null;
  const download = item.showDownloadButton
    ? `    ${cta ? downloadButton(cta.label ?? viewContentButtonText(data.link), mailerUrl(cta.path)) : "\n"}\n`
    : "";
  return `${cell}
<div class="details">
${notes}
${customNote}
${item.licenseKey === null ? "" : `    <h4>License key</h4>\n    <pre style="text-align: center; white-space: pre-wrap;">\n      <code>${h(item.licenseKey)}</code>\n    </pre>\n`}
${download}
  ${attributesPartial(item.giftAttributes)}
  ${attributesPartial(item.generalAttributes)}
</div>
`;
}

// customer_mailer/gift_receiver_receipt. The gift's receiver is a free, non-physical purchase, so the shipping partial is empty.
function giftReceiverBody(
  data: ReceiptData,
  info: ReturnType<typeof chargeInfo>,
  item: ReturnType<typeof itemInfo>,
  card: Card,
): string {
  const gift = data.gift!;
  const gifter = isGifterHidden(gift)
    ? "Someone"
    : `<a href="mailto:${h(gift.gifter_email)}">${h(gift.gifter_email)}</a>`;
  // gift_note.present?
  const note = isBlank(gift.gift_note)
    ? ""
    : `    <div>
      <div class="promo" role="status">
        <div>
          <table class="reset">
            <tr>
              <td>
                <img alt="Gift" src="${h(`${domainConfig().assetHost ?? ""}/images/illustrations/gift.png`)}" />
              </td>
              <td>
                ${h(gift.gift_note)}
              </td>
            </tr>
          </table>
        </div>
      </div>
    </div>
`;
  const questions =
    info.productQuestionsNote === null ? "" : `    <div>\n      ${info.productQuestionsNote}\n    </div>\n`;
  return `<div class="receipt">
  <div class="info-row">
    <span class="info-label">Order ID:</span>
    <span class="info-value">${h(info.orderId)}</span>
  </div>
  <div class="info-row with-top-margin">
    <span class="info-label">Order date:</span>
    <span class="info-value">${h(info.formattedCreatedAt)}</span>
  </div>
</div>

<div>
  <h2>You've received a gift!</h2>

  <p>Hi! ${gifter} bought this as a gift for you. We hope you like it!</p>

${note}
    <div class="item">
      ${itemSection(item, card, data)}
    </div>


${questions}</div>

\n`;
}

// customer_mailer/receipt/sections/_recommended_products and _product_card
function productCardPartial(card: RecommendedProducts["cards"][number]): string {
  const image = linkTo("", card.url, { target: "_blank" }).replace(
    />[^<]*<\/a>$/u,
    `><img alt="${h(card.name)}" src="${h(card.thumbnailUrl)}" /></a>`,
  );
  const rating =
    card.ratings && card.ratings.count > 0
      ? `      <div class="rating">\n        ★\n        <span class="rating-average">${h(floatToS(card.ratings.average))}</span>\n        ${h(`(${numberToSi(card.ratings.count)})`)}\n      </div>\n`
      : "";
  return `<div class="product-card">
  <div class="carousel">
    <div class="items">
      ${image}
    </div>
  </div>
  <div class="header">
    <h4>
      ${linkTo(card.name, card.url, { target: "_blank" })}
    </h4>
${rating}  </div>
  <div class="footer">
    <div>
      <div class="price">
        ${h(cardPrice(card))}
      </div>
    </div>
  </div>
</div>
`;
}

function recommendedSection(recommended: RecommendedProducts | null): string {
  if (recommended === null) return "";
  const { cards } = recommended;
  const productRows = Array.from({ length: Math.ceil(cards.length / 2) }, (_, index) =>
    cards.slice(index * 2, index * 2 + 2),
  );
  const body = productRows
    .map((row, rowIndex) => {
      const cells = row
        .map((card, columnIndex) => {
          const withGap = rowIndex * 2 + columnIndex < cards.length - 1 ? "product-card-cell-with-gap" : "";
          return `              <td class="${withGap}">
                <table class="reset product-card-table" align="center" role="presentation">
                  <tbody>
                    <tr>
                      <td>
                        ${productCardPartial(card)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
`;
        })
        .join("");
      return `          <tr class="${rowIndex < productRows.length - 1 ? "product-card-row-with-gap" : ""}">\n${cells}          </tr>\n`;
    })
    .join("");
  return `  <div>
    <h3>${h(recommended.title)}</h3>
    <table class="reset two-product-card-table">
      <tbody>
${body}      </tbody>
    </table>
  </div>
`;
}

// ---- the mailer ---------------------------------------------------------------------------------------

export async function receipt(args: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const [purchaseIdArgument] = args;
  const purchaseId = purchaseIdArgument === null || purchaseIdArgument === undefined ? null : purchaseIdArgument;
  if (args.length !== 1 || (purchaseId !== null && typeof purchaseId !== "number" && typeof purchaseId !== "bigint"))
    throw new MailViewNotPortedError("receipt arguments other than a purchase id");

  const found =
    purchaseId === null ? null : await findRow<ReceiptPurchaseRow & Record<string, unknown>>("purchases", purchaseId);
  // `purchase&.split_charge_receipt_sent?` reads the purchase's charge, then `Charge.find_by(id: nil)`
  if (found && (await chargeOfPurchase(found as unknown as Purchase)) !== null)
    throw new MailViewNotPortedError("receipt of a purchase that belongs to a charge");
  const noCharge: Charge | null = await findChargeOrNil(null);
  if (!found)
    throw new ArgumentError(
      noCharge === null
        ? "Either purchase or charge must be present"
        : "Only one of purchase or charge must be present",
    );
  const purchase = found;

  // successful_purchases.none?
  await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id} LIMIT 1`,
  );

  const { data, supportEmails } = await loadReceiptData(purchase);
  assertSupported(data);
  data.displayedPriceUsdCents = await getUsdCents(
    purchase.displayed_price_currency_type!,
    purchase.displayed_price_cents,
    purchase.displayed_price_currency_type === "usd" ? undefined : rubyStringToF(purchase.rate_converted_to_usd!),
  );
  const seller = data.seller;
  const subject = mailSubject(data);
  const from = fromEmailAddressWithName(seller.name, customersNoreply());
  const replyTo = supportEmail(data, supportEmails);

  // ---- render
  // unbundled_purchases
  await selectRows(
    Prisma.sql`SELECT ${star("purchases")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id}`,
  );
  if ((purchase.total_transaction_cents ?? 0) !== 0) {
    const [presentment] = await byPurchase("purchase_presentments", purchase.id, true);
    if (presentment) {
      // buyer_presentment_display? reads the refunds that moved money: each one needs a buyer-currency snapshot to keep the
      // receipt in the buyer's currency, which the port does not read.
      const refunds = await rows(
        Prisma.sql`SELECT ${star("refunds")} FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchase.id} AND (refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')`,
      );
      if (refunds.length > 0) throw new MailViewNotPortedError("receipt of a buyer-currency purchase with refunds");
      data.presentment = {
        currency: String(presentment.presentment_currency),
        priceCents: Number(presentment.presentment_price_cents),
        tipCents: Number(presentment.presentment_tip_cents),
        sellerTaxCents: Number(presentment.presentment_seller_tax_cents),
        gumroadTaxCents: Number(presentment.presentment_gumroad_tax_cents),
        shippingCents: Number(presentment.presentment_shipping_cents),
        totalCents: Number(presentment.presentment_total_cents),
      };
    }
  }
  const externalId = obfuscateId(purchase.id);
  if (!/^[A-Za-z0-9_=-]+$/u.test(externalId)) throw new MailViewNotPortedError("external id that needs URL escaping");
  const info = chargeInfo(data, externalId);

  await loadItemData(data);
  const customReceiptText = jsonDataString(data.link.json_data, "custom_receipt_text");
  // User#avatar_url: `avatar.attached?`. An uploaded avatar goes through Active Storage variants and their cache.
  const [attachment] = await rows(
    Prisma.sql`SELECT ${star("active_storage_attachments")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_id")} = ${seller.id} AND ${column("active_storage_attachments", "record_type")} = ${"User"} AND ${column("active_storage_attachments", "name")} = ${"avatar"} LIMIT 1`,
  );
  if (attachment) throw new MailViewNotPortedError("seller with an uploaded avatar");
  // shared/_download_button for a rental redirect: `link.streamable?` is `alive_product_files.map(&:filegroup).include?("video")`.
  // Position recorded by receipt_rental_watch.
  if (data.urlRedirectIsRental && data.urlRedirectToken !== null && data.link.native_type !== "coffee") {
    const files = await rows(
      Prisma.sql`SELECT ${star("product_files")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${data.link.id} AND ${column("product_files", "deleted_at")} IS NULL ORDER BY ${column("product_files", "position")} ASC`,
    );
    data.linkStreamable = files.some((file) => file.filegroup === "video");
  }
  const item = itemInfo(data, customReceiptText);
  const avatar = `${domainConfig().assetHost ?? ""}/images/gumroad-default-avatar-5.png`;
  const name = displayName(seller)!;
  const assetHost = domainConfig().assetHost ?? "";
  const card: Card = {
    name: data.link.name,
    thumbnailUrl: `${assetHost}/images/native_types/thumbnails/${data.link.native_type}.png`,
    url: productLongUrl(data.link as never, seller as unknown as UserRow),
    sellerName: name,
    sellerProfileUrl: sellerProfileUrl(seller),
    sellerAvatarUrl: avatar,
  };

  if (PurchaseFlags.isSet(purchase.flags ?? 0, "is_gift_receiver_purchase")) {
    // gift_receiver_receipt renders no payment section, recommendations or footer, so none of their reads happen.
    const html = emailLayout(giftReceiverBody(data, info, item, card), {});
    const options = await customersDeliveryOptions(seller as unknown as UserRow, purchase.email, deps);
    return applicationMail(
      {
        mailerClass: "CustomerMailer",
        mailerMethod: "receipt",
        args,
        to: purchase.email,
        from,
        ...(replyTo === null ? {} : { replyTo }),
        subject,
        html,
        deliveryMethodOptions: options,
        recordIds: { purchaseId: purchase.id, emailName: "receipt" },
      },
      deps,
    );
  }

  const shipping = shippingInfo(data);
  const invoiceLink = linkTo(
    "Generate invoice",
    mailerUrl(`/purchases/${externalId}/invoice/new`, { email: purchase.email ?? "" }),
  );
  data.taxLines = await taxLines(purchase, data.presentment);
  const payment = paymentInfo(data, invoiceLink);

  // recommended_products_info: the buyer's account, cart_seller_ids, then the products Rails excludes (the cart's,
  // the buyer's own purchases and their bundle members). A seller who opted out has no cart sellers, so nothing is
  // recommended; one who recommends their own products goes on to the related products and the search.
  const purchaser = purchase.purchaser_id === null ? null : await findRow<{ id: Id }>("users", purchase.purchaser_id);
  const cartSellers = await selectRows<{ user_id: Id }>(
    Prisma.sql`SELECT DISTINCT ${column("links", "user_id")} FROM ${table("links")} INNER JOIN ${table("users")} \`user\` ON \`user\`.\`id\` = ${column("links", "user_id")} WHERE \`user\`.\`recommendation_type\` != ${"no_recommendations"} AND ${column("links", "id")} = ${data.link.id}`,
  );
  const sellerIds = cartSellers.map((row) => row.user_id);
  if (sellerIds.length > 0) {
    // affiliated_users.present?: the affiliate recommendation types read affiliates and global affiliate products
    const [affiliated] = await selectRows(
      Prisma.sql`SELECT ${star("users")} FROM ${table("users")} WHERE ${columnIn("users", "id", sellerIds)} AND ${column("users", "recommendation_type")} IN ${inList(["gumroad_affiliates_products", "directly_affiliated_products"])}`,
    );
    if (affiliated) throw new MailViewNotPortedError("receipt of a seller recommending affiliate products");
  }
  const purchasedProductIds = async (limit: number | null) =>
    (
      await selectRows<{ id: Id }>(
        Prisma.sql`SELECT DISTINCT ${column("links", "id")} FROM ${table("links")} INNER JOIN ${table("purchases")} ON ${column("links", "id")} = ${column("purchases", "link_id")} WHERE ${column("purchases", "purchaser_id")} = ${purchaser!.id} ORDER BY \`succeeded_at\` DESC${limit === null ? Prisma.empty : Prisma.sql` LIMIT ${Prisma.raw(String(limit))}`}`,
      )
    ).map((row) => row.id);
  let associatedIds: Id[] = [data.link.id];
  let limitedAssociatedIds: Id[] = [data.link.id];
  if (purchaser) {
    // BaseService#associated_product_ids_limit: `($redis.get(...) || 100).to_i`
    const configured = await (deps.router ?? defaultRouterDeps()).redisGet(ASSOCIATED_PRODUCT_IDS_LIMIT_KEY);
    const limited = await purchasedProductIds(rubyToI(configured ?? "100"));
    limitedAssociatedIds = [...new Set([data.link.id, ...limited].map(BigInt))];
    const purchased = await purchasedProductIds(null);
    // `cart_product_ids | purchased_products.ids`
    associatedIds = [...new Set([...associatedIds, ...purchased].map(BigInt))];
  }
  const bundleProducts = await selectRows<{ product_id: Id }>(
    Prisma.sql`SELECT DISTINCT ${column("bundle_products", "product_id")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "deleted_at")} IS NULL AND ${columnIn("bundle_products", "bundle_id", associatedIds)}`,
  );
  let recommended: RecommendedProducts | null = null;
  if (sellerIds.length > 0) {
    // Half of four or more associated ids are sampled at random.
    if (limitedAssociatedIds.length >= SAMPLED_ASSOCIATED_IDS)
      throw new MailViewNotPortedError("receipt whose recommendations sample associated products at random");
    if (bundleProducts.length > 0) throw new MailViewNotPortedError("receipt whose buyer owns bundles");
    recommended = await recommendedProducts({
      cartProductIds: [data.link.id],
      associatedIds: limitedAssociatedIds,
      excludeIds: associatedIds,
      sellerIds,
      seller,
    });
  }

  const paymentSection = payment.present
    ? `  <div>
    <h3>${h(payment.title)}</h3>
${payment.notes.map((note) => `      <div>\n        ${h(note)}\n      </div>\n`).join("")}    ${attributesPartial(payment.todayPaymentAttributes)}
    ${attributesPartial(payment.upcomingPaymentAttributes)}
    ${attributesPartial(payment.paymentMethodAttribute ? [payment.paymentMethodAttribute] : [])}
  </div>
`
    : "";
  const shippingSection =
    shipping.attributes.length > 0
      ? `  <div>\n    <h3>${h(shipping.title)}</h3>\n    ${attributesPartial(shipping.attributes)}\n  </div>\n`
      : "";
  const itemsSection = `<div>
    <div class="item">
      ${itemSection(item, card, data)}
    </div>

${info.productQuestionsNote === null ? "" : `    <div>\n      ${info.productQuestionsNote}\n    </div>\n`}</div>
`;
  const receiptPartial = `  ${headerSection(info)}
  ${itemsSection}
  ${shippingSection}
  ${paymentSection}
  ${recommendedSection(recommended)}
`;

  // The footer renders last: the unsubscribe link encrypts the purchase id with a fresh IV.
  const unsubscribeToken = secureExternalId(
    "Purchase",
    purchase.id as bigint | number,
    "unsubscribe",
    deps.randomIv ? { randomIv: deps.randomIv } : {},
  );
  const footer = `<p>\n    ${linkTo("Unsubscribe", mailerUrl(`/purchases/${unsubscribeToken}/unsubscribe`))}\n</p>\n`;

  const html = emailLayout(`${receiptPartial}\n`, { footer });
  const options = await customersDeliveryOptions(seller as unknown as UserRow, purchase.email, deps);
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "receipt",
      args,
      to: purchase.email,
      from,
      ...(replyTo === null ? {} : { replyTo }),
      subject,
      html,
      deliveryMethodOptions: options,
      recordIds: { purchaseId: purchase.id, emailName: "receipt" },
    },
    deps,
  );
}

// User#profile_url: the seller's subdomain.
function sellerProfileUrl(seller: ReceiptSellerRow): string {
  const username = isBlank(seller.username) ? seller.external_id : seller.username;
  if (isBlank(username)) throw new MailViewNotPortedError("seller without a username");
  const { protocol, rootDomain } = domainConfig();
  return `${protocol}://${username!.replaceAll("_", "-")}.${rootDomain}`;
}

export { RecordNotFoundError };
