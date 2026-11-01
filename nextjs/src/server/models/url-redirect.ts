// Read side of app/models/url_redirect.rb: the flags, the rental windows and `purchase.url_redirect`.
// Nothing here writes a url_redirects row.
import { Prisma, type UrlRedirect } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
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
