// Subscriptions::MagicLinkPresenter and the Subscription lookups the buyer pages share.
import { Prisma, type Purchase, type Subscription, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";

const PURCHASES = "purchases";

const presentOrNull = (value: string | null | undefined) => (value != null && value.trim() !== "" ? value : null);

// EmailRedactorService.redact. Ruby raises (a 500) on an address this cannot split, so does this.
export function redactEmail(email: string): string {
  const [username, domain] = email.split("@");
  if (username === undefined || domain === undefined) throw new TypeError(`undefined method for nil: cannot redact ${JSON.stringify(email)}`);
  const dot = domain.lastIndexOf(".");
  const domainName = dot === -1 ? "" : domain.slice(0, dot);
  const tld = dot === -1 ? domain : domain.slice(dot + 1);
  if (domainName === "") throw new RangeError("negative argument");

  const characters = Array.from(username);
  const redactedUsername = characters.length > 1 ? `${characters[0]}${"*".repeat(characters.length - 2)}${characters.at(-1)}` : username;
  return `${redactedUsername}@${Array.from(domainName)[0]}${"*".repeat(Array.from(domainName).length - 1)}.${tld}`;
}

const purchaseOf = async (subscriptionId: bigint, extra: Prisma.Sql, order: Prisma.Sql = Prisma.empty): Promise<Purchase | null> => {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "subscription_id")} = ${subscriptionId} AND ${extra} ${order} LIMIT 1`,
  );
  return row ? castRow<Purchase>("Purchase", row) : null;
};

const isOriginal = PurchaseFlags.condition("is_original_subscription_purchase", true);

// `has_one :original_purchase`
export const originalPurchaseOf = (subscriptionId: bigint) =>
  purchaseOf(subscriptionId, Prisma.sql`${isOriginal} AND ${PurchaseFlags.condition("is_archived_original_subscription_purchase", false)}`);

// `has_one :true_original_purchase`
export const trueOriginalPurchaseOf = (subscriptionId: bigint) =>
  purchaseOf(subscriptionId, isOriginal, Prisma.sql`ORDER BY ${column(PURCHASES, "id")} ASC`);

// Purchase#giftee_email: `gift&.giftee_email`, the gift this purchase sent.
async function gifteeEmailOf(purchase: Purchase): Promise<string | null> {
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")) {
    const gift = await db.gift.findFirst({ where: { gifter_purchase_id: purchase.id } });
    return gift?.giftee_email ?? null;
  }
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")) {
    const gift = await db.gift.findFirst({ where: { giftee_purchase_id: purchase.id } });
    return gift?.giftee_email ?? null;
  }
  return null;
}

const noPurchase = () => new TypeError("undefined method for nil: the subscription has no purchase");

// `Subscription#emails`
export async function subscriptionEmails(subscription: Subscription, user: User | null): Promise<{ subscription: string | null; purchase: string | null; user: string | null }> {
  const trueOriginal = await trueOriginalPurchaseOf(subscription.id);
  if (!trueOriginal) throw noPurchase();
  const gift = PurchaseFlags.isSet(trueOriginal.flags, "is_gift_sender_purchase");

  let purchaseEmail: string | null;
  if (gift) {
    purchaseEmail = await gifteeEmailOf(trueOriginal);
  } else {
    const original = await originalPurchaseOf(subscription.id);
    if (!original) throw noPurchase();
    purchaseEmail = original.email;
  }
  const formEmail = user ? (presentOrNull(user.unconfirmed_email) ?? presentOrNull(user.email)) : null;
  // `user&.form_email.presence || (...)`: the fallback is the purchase side again.
  return { subscription: formEmail ?? purchaseEmail, purchase: purchaseEmail, user: user ? user.email : null };
}

export async function magicLinkProps(subscriptionId: bigint, emailSent: string | null) {
  const subscription = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const [user, link] = await Promise.all([
    subscription.user_id === null ? null : db.user.findUnique({ where: { id: subscription.user_id } }),
    subscription.link_id === null ? null : db.link.findUnique({ where: { id: subscription.link_id } }),
  ]);
  const emails = await subscriptionEmails(subscription, user);

  const seen = new Set<string>();
  const userEmails: { email: string; source: string }[] = [];
  for (const [source, email] of Object.entries(emails)) {
    if (email === null) continue;
    const redacted = redactEmail(email);
    if (seen.has(redacted)) continue;
    seen.add(redacted);
    userEmails.push({ email: redacted, source });
  }

  return {
    subscription_id: encrypt(subscription.id),
    is_installment_plan: SubscriptionFlags.isSet(subscription.flags, "is_installment_plan"),
    user_emails: userEmails,
    product_name: link?.name ?? null,
    email_sent: emailSent,
  };
}
