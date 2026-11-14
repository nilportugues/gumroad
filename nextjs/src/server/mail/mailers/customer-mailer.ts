// Port of CustomerMailer (app/mailers/customer_mailer.rb) with app/views/customer_mailer/*.html.erb.
// Pinned by customer-mailer.golden.json (__fixtures__/generate-customer-mailer-golden.rb).
import { Prisma } from "@prisma/client";

import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { isBlank } from "../../html/text-helper.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { isValidEmailFormat } from "../../models/user.ts";
import { applicationMail, findRow, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { randomDeliveryMethodOptions } from "../mailer-info.ts";
import { displayableReleaseAtDateAndTime } from "../preorder-helper.ts";
import type { RubyValue } from "../ruby-value.ts";
import { linkTo } from "../view-helpers.ts";
import { emailLayout, h, headerSection, MailViewNotPortedError, mailerUrl } from "../views.ts";

import {
  customersDeliveryOptions,
  customersNoreply,
  downloadButton,
  formatJustUsdPriceInCents,
  formattedUsdPrice,
  fromEmailAddressWithName,
  type LinkRow,
  productLongUrl,
  supportEmailOrDefault,
  supportOrFormEmail,
  type UserRow,
  viewContentButtonText,
} from "./customer-mail-support.ts";

type PurchaseRow = { id: number | bigint; link_id: number | bigint; email: string | null };

export async function paypalPurchaseFailed(
  purchaseId: number | bigint,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail> {
  const purchase = await findRowOrRaise<PurchaseRow>("purchases", "Purchase", purchaseId);
  const product = await findRowOrRaise<LinkRow>("links", "Link", purchase.link_id);
  const seller = await findRowOrRaise<UserRow>("users", "User", product.user_id);
  const subject = "Your purchase with PayPal failed.";
  const content = `${headerSection(subject)}
<div>
  <p>Hi there,</p>
  <p>My name is Sahil. I'm part of the Gumroad team, and we power the payment process you tried to complete recently.</p>
  <p>I got a notification that you attempted to purchase ${h(product.name)} using PayPal, but it looks like the transaction ultimately did not go through.</p>
  <p>Sometimes your PayPal statement will say 'pending' even in this scenario — rest assured, this will go away in a few days' time.</p>
  <p>Please try again by clicking here (if it still doesn't go through, please try with another credit card):</p>
  <p>${linkTo("Try purchasing again", productLongUrl(product, seller), { class: "button primary" })}</p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "paypal_purchase_failed",
      args,
      to: purchase.email,
      from: customersNoreply(),
      subject,
      // The layout shows the mailer's @subject, which this one never sets.
      html: emailLayout(content),
      deliveryMethodOptions: await customersDeliveryOptions(seller, purchase.email, deps),
    },
    deps,
  );
}

type SubscriptionRow = { id: number | bigint; link_id: number | bigint | null; token: string | null };

// Subscription::TOKEN_VALIDITY (24.hours), in hours.
const SUBSCRIPTION_TOKEN_VALIDITY_HOURS = 24;

// ObfuscateIds ids are url-safe base64; a path segment Rails would percent-escape is refused.
function pathSegment(value: string): string {
  if (!/^[A-Za-z0-9_=-]+$/u.test(value)) throw new MailViewNotPortedError("external id that needs URL escaping");
  return value;
}

export async function subscriptionMagicLink(
  subscriptionId: number | bigint,
  email: string | null,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail | null> {
  const subscription = await findRowOrRaise<SubscriptionRow>("subscriptions", "Subscription", subscriptionId);
  if (!isValidEmailFormat(email)) return null;

  // `@subscription.link` is `belongs_to :link, optional: true`; a nil link raises NoMethodError in the view.
  if (subscription.link_id === null) throw new MailViewNotPortedError("subscription without a link");
  const product = await findRowOrRaise<LinkRow>("links", "Link", subscription.link_id);
  const manageUrl = mailerUrl(`/subscriptions/${pathSegment(obfuscateId(subscription.id))}/manage.html`, {
    token: subscription.token ?? "",
  });
  if (subscription.token === null) throw new MailViewNotPortedError("subscription without a token");
  const content = `<div>
  ${headerSection("Here's your magic link")}
  <p>You requested a magic link to manage your membership for "${h(product.name)}". Note that this link expires in ${SUBSCRIPTION_TOKEN_VALIDITY_HOURS} hours.</p>
  ${linkTo("Open magic link", manageUrl, { class: "button primary" })}
</div>
If you didn't request a magic link, you can safely ignore this message.
`;
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "subscription_magic_link",
      args,
      to: email,
      subject: "Magic Link",
      html: emailLayout(content),
      deliveryMethodOptions: await randomDeliveryMethodOptions("gumroad", { to: email }, deps.router),
    },
    deps,
  );
}

type RefundPurchaseRow = PurchaseRow & {
  total_transaction_cents: number | bigint | null;
  displayed_price_currency_type: string | null;
};
type RefundLinkRow = LinkRow & { price_currency_type: string | null };

// Purchase#format_price_in_cents(total_in_purchase_currency) for a purchase that is neither recurring
// (`price || subscription&.price` is nil) nor priced in another currency.
function formattedTotalTransactionAmount(
  purchase: RefundPurchaseRow & { price_id: number | bigint | null; subscription_id: number | bigint | null },
): string {
  if (purchase.displayed_price_currency_type !== "usd")
    throw new MailViewNotPortedError(`purchase priced in ${String(purchase.displayed_price_currency_type)}`);
  if (purchase.price_id !== null || purchase.subscription_id !== null)
    throw new MailViewNotPortedError("price of a recurring purchase");
  return formatJustUsdPriceInCents(purchase.total_transaction_cents);
}

type FullRefundPurchase = RefundPurchaseRow & {
  price_id: number | bigint | null;
  subscription_id: number | bigint | null;
};

async function loadRefundRecords(linkId: number | bigint, purchaseId: number | bigint | null) {
  const product = await findRowOrRaise<RefundLinkRow>("links", "Link", linkId);
  const purchase =
    purchaseId === null ? null : await findRowOrRaise<FullRefundPurchase>("purchases", "Purchase", purchaseId);
  return { product, purchase };
}

export async function refund(
  email: string | null,
  linkId: number | bigint,
  purchaseId: number | bigint | null,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail> {
  const { product, purchase } = await loadRefundRecords(linkId, purchaseId);
  if (purchase) {
    // `@purchase&.buyer_presentment?` reads the charge-time presentment row; its wording needs Stripe currency formatting.
    const [presentment] = await selectRows(
      Prisma.sql`SELECT \`purchase_presentments\`.* FROM \`purchase_presentments\` WHERE \`purchase_presentments\`.\`purchase_id\` = ${purchase.id} LIMIT 1`,
    );
    if (presentment) throw new MailViewNotPortedError("refund of a buyer-currency purchase");
  }
  const seller = await findRowOrRaise<UserRow>("users", "User", product.user_id);
  const subject = "You have been refunded.";
  // The template reads `@purchase.link_name`, which loads the purchase's link again.
  if (!purchase) throw new TypeError("undefined method 'link_name' for nil");
  const purchasedProduct = await findRowOrRaise<LinkRow>("links", "Link", purchase.link_id);
  const content = `${headerSection(subject)}
<div>
    <p>Your purchase of ${h(purchasedProduct.name)} for ${formattedTotalTransactionAmount(purchase)} on Gumroad has been fully refunded. It may take up to 3-7 days to show up in your account.</p>
</div>
`;
  // After the content, so a refusal above has not yet counted against the Router's day.
  const options = await customersDeliveryOptions(seller, email, deps);
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "refund",
      args,
      to: email,
      from: fromEmailAddressWithName(seller.name, customersNoreply()),
      ...optionalReplyTo(supportOrFormEmail(seller)),
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: options,
    },
    deps,
  );
}

const optionalReplyTo = (address: string | null) => (address === null ? {} : { replyTo: address });

export type PartialRefundArguments = {
  email: string | null;
  linkId: number | bigint;
  purchaseId: number | bigint | null;
  refundAmountCentsUsd: number | bigint;
  refundType: string;
  presentmentRefundAmountCents: number | bigint | null;
  presentmentRefundCurrency: string | null;
};

export async function partialRefund(
  a: PartialRefundArguments,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail> {
  const { product, purchase } = await loadRefundRecords(a.linkId, a.purchaseId);
  if (!purchase) throw new TypeError("undefined method 'rate_converted_to_usd' for nil");
  // usd_cents_to_currency converts through the product's currency; formatting it needs CURRENCY_CHOICES' symbols.
  if (product.price_currency_type !== "usd")
    throw new MailViewNotPortedError(`refund of a product priced in ${String(product.price_currency_type)}`);
  if (!isBlank(a.presentmentRefundCurrency) && Number(a.presentmentRefundAmountCents ?? 0) > 0)
    throw new MailViewNotPortedError("partial refund in the buyer's currency");
  const formattedRefundAmount = formattedUsdPrice(a.refundAmountCentsUsd);
  const seller = await findRowOrRaise<UserRow>("users", "User", product.user_id);
  const subject = `You have been ${a.refundType} refunded.`;
  const purchasedProduct = await findRowOrRaise<LinkRow>("links", "Link", purchase.link_id);
  const content = `${headerSection(subject)}
<div>
    <p>You received a partial refund of ${formattedRefundAmount} for your ${formattedTotalTransactionAmount(purchase)} purchase of ${h(purchasedProduct.name)}. It may take up to 3-7 days to show up in your account.</p>
</div>
`;
  const options = await customersDeliveryOptions(seller, a.email, deps);
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "partial_refund",
      args,
      to: a.email,
      from: fromEmailAddressWithName(seller.name, customersNoreply()),
      ...(seller.email === null ? {} : { replyTo: fromEmailAddressWithName(seller.name, seller.email) }),
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: options,
    },
    deps,
  );
}

type UrlRedirectRow = { id: number | bigint; token: string; flags: number | bigint | null };

export async function filesReadyForDownload(
  purchaseId: number | bigint,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail> {
  const purchase = await findRowOrRaise<PurchaseRow>("purchases", "Purchase", purchaseId);
  // `includes(:url_redirect)` preloads in a second statement, ahead of the product.
  const [redirect] = await selectRows<UrlRedirectRow>(
    Prisma.sql`SELECT \`url_redirects\`.* FROM \`url_redirects\` WHERE \`url_redirects\`.\`purchase_id\` = ${purchase.id}`,
  );
  const product = await findRowOrRaise<LinkRow>("links", "Link", purchase.link_id);
  const seller = await findRowOrRaise<UserRow>("users", "User", product.user_id);
  // The partial calls `url_redirect.token` for anything but a rental, and a purchase without a redirect raises there.
  if (!redirect) throw new TypeError("undefined method 'token' for nil");
  if (UrlRedirectFlags.isSet(redirect.flags ?? 0, "is_rental"))
    throw new MailViewNotPortedError("download button for a rental");

  const subject = "Your files are ready for download!";
  const content = `${headerSection(subject)}

<div>
  <p>Your files for <strong>${h(product.name)}</strong> are now ready for download.</p>

  <p>Click the button below to access your files:</p>

  ${downloadButton(viewContentButtonText(product), mailerUrl(`/d/${redirect.token}`))}

  <p>Questions about your product? Contact Seller by replying to this email.</p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "files_ready_for_download",
      args,
      to: purchase.email,
      from: fromEmailAddressWithName(seller.name, customersNoreply()),
      ...optionalReplyTo(supportEmailOrDefault(product, seller)),
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: await customersDeliveryOptions(seller, purchase.email, deps),
    },
    deps,
  );
}

type PreorderRow = { id: number | bigint; preorder_link_id: number | bigint };
type AuthorizationPurchaseRow = {
  id: number | bigint;
  email: string | null;
  full_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
};
type PreorderLinkRow = { id: number | bigint; link_id: number | bigint | null; release_at: Date | null };
type SellerRow = UserRow & { timezone: string | null };

// `Preorder#authorization_purchase`: `purchases.first`, which is ordered by id.
const authorizationPurchase = async (preorderId: number | bigint) => {
  const [purchase] = await selectRows<AuthorizationPurchaseRow>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "preorder_id")} = ${preorderId} ORDER BY ${column("purchases", "id")} ASC LIMIT 1`,
  );
  return purchase ?? null;
};

export async function preorderReceipt(
  preorderId: number | bigint | null,
  args: RubyValue[],
  deps: MailerDeps = {},
): Promise<RenderedMail> {
  // Without a preorder id Rails takes the link and address from its arguments, but the header builder then calls
  // `Preorder.find(nil)` and no message is ever delivered.
  if (preorderId === null) throw new MailViewNotPortedError("preorder receipt without a preorder");
  const preorder = await findRow<PreorderRow>("preorders", preorderId);
  const authorization = preorder === null ? null : await authorizationPurchase(preorder.id);
  if (preorder === null) throw new TypeError("undefined method 'authorization_purchase' for nil");
  if (authorization === null) throw new MailViewNotPortedError("preorder without an authorization purchase");
  const preorderLink = await findRowOrRaise<PreorderLinkRow>(
    "preorder_links",
    "PreorderLink",
    preorder.preorder_link_id,
  );
  if (preorderLink.link_id === null) throw new MailViewNotPortedError("preorder link without a product");
  const product = await findRowOrRaise<LinkRow & { flags: number | bigint | null }>(
    "links",
    "Link",
    preorderLink.link_id,
  );
  const physical = LinkFlags.isSet(product.flags ?? 0, "is_physical");
  // The physical branch builds its shipping hash from a second `authorization_purchase`.
  const shipped = physical ? await authorizationPurchase(preorder.id) : null;
  const seller = await findRowOrRaise<SellerRow>("users", "User", product.user_id);
  if (preorderLink.release_at === null) throw new MailViewNotPortedError("preorder link without a release date");
  const releaseAt = displayableReleaseAtDateAndTime(preorderLink.release_at, seller.timezone);

  const subject = `You pre-ordered ${product.name}!`;
  const body =
    physical && shipped
      ? `    <p>You have successfully pre-ordered ${h(product.name)}. You'll be charged on ${h(releaseAt)}, and shipment will occur soon after.</p>
    <p>If you need to update your address, contact the creator immediately with your updated address by replying to this email.</p>
    <p>
      <strong>Shipping address</strong>
    </p>
    <p>
      ${h(shipped.full_name)}
      <br>
      ${h(shipped.street_address)}
      <br>
      ${h(shipped.city)}, ${h(shipped.state)} ${h(shipped.zip_code)}
      <br>
      ${h(shipped.country)}
    </p>
`
      : `    <p>You have successfully pre-ordered ${h(product.name)}. The product is set to release on ${h(releaseAt)}.</p>
`;
  const content = `${headerSection(subject)}
<div>
${body}</div>
`;
  const options = await customersDeliveryOptions(seller, authorization.email, deps);
  // HeaderBuilder#determine_receipt_record_ids: `Preorder.find(...).authorization_purchase.id`
  await findRow<PreorderRow>("preorders", preorder.id);
  const headerPurchase = await authorizationPurchase(preorder.id);
  return applicationMail(
    {
      mailerClass: "CustomerMailer",
      mailerMethod: "preorder_receipt",
      args,
      to: authorization.email,
      from: fromEmailAddressWithName(seller.name, customersNoreply()),
      ...optionalReplyTo(supportEmailOrDefault(product, seller)),
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: options,
      recordIds: { purchaseId: headerPurchase!.id, emailName: "preorder_receipt" },
    },
    deps,
  );
}
