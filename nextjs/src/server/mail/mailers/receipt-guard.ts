// CustomerMailer#suppress_receipt_from_unproven_seller? and ContentModeration::GumroadImpersonation (gp#4366).
// Pinned by receipt-mailer.golden.json: the reads (purchase, seller, paid sales, product) and their order are recorded.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";
import { MailViewNotPortedError } from "../views.ts";

const PROVEN_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GUMROAD = /g[\W_]*u[\W_]*m[\W_]*r[\W_]*o[\W_]*a[\W_]*d/iu;
const STAFF_WORDS =
  /\b(security|payouts?|verif(y|ied|ication)|trust|safety|compliance|billing|official|admin|staff|alerts?|notices?|support\s+team|help\s*desk)\b/iu;
const GUMROAD_ADDRESS_SUFFIX = "@gumroad.com";

// NFKC folding and the removal of invisible characters only change non-ASCII text, whose Ruby and JavaScript
// Unicode tables and `\b` semantics are not recorded: that text goes back to Rails.
function impersonates(text: string | null | undefined): boolean {
  const value = text ?? "";
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/u.test(value)) throw new MailViewNotPortedError("impersonation check of non-ASCII text");
  return GUMROAD.test(value) && STAFF_WORDS.test(value);
}

const gumroadAddress = (email: string | null | undefined) =>
  (email ?? "").toLowerCase().trim().endsWith(GUMROAD_ADDRESS_SUFFIX);

export type GuardSeller = {
  id: bigint | number;
  name: string | null;
  email: string | null;
  created_at: Date | null;
  confirmed_at: Date | null;
};

// True when Rails sends nothing. `purchase` is the one-purchase chargeable the port renders.
export async function suppressReceiptFromUnprovenSeller(
  purchase: { id: bigint | number; seller_id: bigint | number; price_cents: number | null; email: string | null },
  loadSeller: () => Promise<GuardSeller>,
  loadProductName: () => Promise<string>,
  now: Date,
): Promise<boolean> {
  // A purchase that carries its own price is already known to be paid, so it costs no second read.
  if ((purchase.price_cents ?? 0) > 0) return false;
  // chargeable.successful_purchases
  await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchase.id}`,
  );
  const seller = await loadSeller();
  // unproven_seller?: gumroad_staff? first, then the account age, then the paid sales
  if (seller.confirmed_at !== null && (seller.email ?? "").toLowerCase().endsWith(GUMROAD_ADDRESS_SUFFIX)) return false;
  if (seller.created_at !== null && seller.created_at.getTime() <= now.getTime() - PROVEN_ACCOUNT_AGE_MS) return false;
  const [paid] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "purchase_state")} = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) LIMIT 1`,
  );
  if (paid) return false;
  return gumroadAddress(purchase.email) || impersonates(seller.name) || impersonates(await loadProductName());
}

// ContentModeration::SellerMailTextGuard.screen for the receipt's custom text. Text it keeps renders unchanged; text it
// drops also enqueues an admin note, which the port does not do, so held text goes back to Rails. Only plain printable
// ASCII is decided here: markup, entities and other characters change what Loofah renders and what the blocklist sees.
const PUBLIC_FILES_HOST = /public-files\.gumroad\.com/iu;
const GUMROAD_NOTICE = /\b(gumroad|your (account|payouts?|balance|funds))\b/iu;
const NOTICE_PHRASES = [
  /security (alert|notice|warning|team)/iu,
  /(verify|confirm|validate|secure|restore|reactivate) your (account|identity|payouts?|payout (method|details)|bank)/iu,
  /(payouts?|account|funds|balance)[^.]{0,40}\b(on hold|suspended|frozen|locked|limited|at risk)/iu,
  /unusual (activity|sign[- ]?in|login)/iu,
  /action (is )?required/iu,
];

export function screenSellerText(text: string | null): string | null {
  if (text === null || text.trim() === "") return null;
  if (!/^[\x20-\x7e\n\r\t]*$/u.test(text) || /[<&]/u.test(text))
    throw new MailViewNotPortedError("seller text with markup, entities or non-ASCII characters");
  // The blocklist is the YAML file (absent in this tree) plus this variable.
  if (!isEmptyEnv(process.env.CONTENT_MODERATION_BLOCKLIST))
    throw new MailViewNotPortedError("seller text screened against a configured blocklist");
  const rendered = text.replace(/\s+/gu, " ");
  if (PUBLIC_FILES_HOST.test(rendered)) throw new MailViewNotPortedError("held seller text");
  if (GUMROAD_NOTICE.test(rendered) && NOTICE_PHRASES.some((phrase) => phrase.test(rendered)))
    throw new MailViewNotPortedError("held seller text");
  return text;
}

const isEmptyEnv = (value: string | undefined) => (value ?? "").split(",").every((word) => word.trim() === "");
