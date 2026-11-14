// app/models/url_redirect.rb: the flags, the rental windows, `purchase.url_redirect`, and the one
// write Node needs, `Purchase#create_url_redirect!` (golden: __fixtures__/url-redirect-writes.golden.json).
import { randomBytes } from "node:crypto";

import { Prisma, type UrlRedirect } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export const URL_REDIRECTS = "url_redirects";

export const UrlRedirectFlags = defineFlags(
  URL_REDIRECTS,
  {
    1: "has_been_seen",
    2: "admin_generated",
    3: "is_rental",
    4: "is_done_pdf_stamping",
    5: "files_ready_notification_requested",
    6: "files_ready_notification_enqueued",
  },
  { queryMode: "bit_operator" },
);

// UrlRedirect::TIME_TO_WATCH_RENTED_PRODUCT_AFTER_PURCHASE / _AFTER_FIRST_PLAY
export const TIME_TO_WATCH_RENTED_PRODUCT_AFTER_PURCHASE = { days: 30 };
export const TIME_TO_WATCH_RENTED_PRODUCT_AFTER_FIRST_PLAY = { hours: 72 };

// `purchase.url_redirect` (has_one, no ORDER BY).
export async function findUrlRedirectForPurchase(purchaseId: bigint | number): Promise<UrlRedirect | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${URL_REDIRECTS}\`.*`)} FROM ${table(URL_REDIRECTS)} WHERE ${column(URL_REDIRECTS, "purchase_id")} = ${purchaseId} LIMIT 1`,
  );
  return row ? castRow<UrlRedirect>("UrlRedirect", row) : null;
}

export const isRental = (redirect: UrlRedirect) => UrlRedirectFlags.isSet(redirect.flags, "is_rental");

const randomToken = () => randomBytes(16).toString("hex");
// UrlRedirect.generate_new_token (SecureRandom.hex); tests pin it.
let generateNewToken = randomToken;

export function setUrlRedirectTokenGenerator(next: (() => string) | null): void {
  generateNewToken = next ?? randomToken;
}

export const UrlRedirects = defineModel<UrlRedirect>({
  rubyClass: "UrlRedirect",
  prismaModel: "UrlRedirect",
  delegate: (tx) => tx.urlRedirect as never,
  beforeValidation: [
    {
      name: "set_token",
      run(record) {
        if (record.get("token") == null) record.set("token", generateNewToken());
      },
    },
  ],
  validations: [
    // validates :token, uniqueness: { case_sensitive: true }: ActiveRecord 8.1 compares with CAST(? AS BINARY).
    {
      name: "validates_uniqueness_of token",
      async run(record, { tx }) {
        const token = record.get("token");
        if (token == null) return;
        const where = [Prisma.sql`${column(URL_REDIRECTS, "token")} = CAST(${token} AS BINARY)`];
        if (record.persisted) where.push(Prisma.sql`${column(URL_REDIRECTS, "id")} != ${record.get("id")}`);
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table(URL_REDIRECTS)} WHERE ${Prisma.join(where, " AND ")} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("token", "taken", { value: token });
      },
    },
    validatesPresenceOf<UrlRedirect>(["token"]),
  ],
});

// Purchase#create_url_redirect! for a loaded purchase: the existing redirect, a new one, or null where
// Ruby returns without creating one.
export async function createUrlRedirectForPurchase(
  purchase: { id: bigint; link_id: bigint | null; flags: bigint | number },
  options?: { now?: () => Date },
): Promise<UrlRedirect | ModelRecord<UrlRedirect> | null> {
  const existing = await findUrlRedirectForPurchase(purchase.id);
  if (existing) return existing;
  if (
    PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase") ||
    PurchaseFlags.isSet(purchase.flags, "is_commission_completion_purchase")
  )
    return null;

  // `UrlRedirect.create!(purchase: self, link:, ...)` evaluates `link` first.
  if (purchase.link_id !== null)
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${purchase.link_id} LIMIT 1`,
    );
  return UrlRedirects.createBang(
    {
      uses: 0,
      expires_at: null,
      purchase_id: purchase.id,
      link_id: purchase.link_id,
      flags: Number(UrlRedirectFlags.set(0, "is_rental", PurchaseFlags.isSet(purchase.flags, "is_rental"))),
      installment_id: null,
      subscription_id: null,
      preorder_id: null,
      imported_customer_id: null,
      rental_first_viewed_at: null,
    },
    options,
  );
}
