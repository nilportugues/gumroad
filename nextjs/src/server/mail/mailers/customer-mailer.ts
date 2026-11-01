// Port of CustomerMailer (app/mailers/customer_mailer.rb) with app/views/customer_mailer/*.html.erb.
// Pinned by customer-mailer.golden.json (__fixtures__/generate-customer-mailer-golden.rb).
import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { isValidEmailFormat } from "../../models/user.ts";
import { applicationMail, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { randomDeliveryMethodOptions } from "../mailer-info.ts";
import type { RubyValue } from "../ruby-value.ts";
import { linkTo } from "../view-helpers.ts";
import { emailLayout, h, headerSection, MailViewNotPortedError, mailerUrl } from "../views.ts";
import { customersDeliveryOptions, customersNoreply, type LinkRow, productLongUrl, type UserRow } from "./customer-mail-support.ts";

type PurchaseRow = { id: number | bigint; link_id: number | bigint; email: string | null };

export async function paypalPurchaseFailed(purchaseId: number | bigint, args: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail> {
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

export async function subscriptionMagicLink(subscriptionId: number | bigint, email: string | null, args: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const subscription = await findRowOrRaise<SubscriptionRow>("subscriptions", "Subscription", subscriptionId);
  if (!isValidEmailFormat(email)) return null;

  // `@subscription.link` is `belongs_to :link, optional: true`; a nil link raises NoMethodError in the view.
  if (subscription.link_id === null) throw new MailViewNotPortedError("subscription without a link");
  const product = await findRowOrRaise<LinkRow>("links", "Link", subscription.link_id);
  const manageUrl = mailerUrl(`/subscriptions/${pathSegment(obfuscateId(subscription.id))}/manage.html`, { token: subscription.token ?? "" });
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
