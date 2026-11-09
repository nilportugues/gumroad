// UtmLinkTrackingController#show (app/controllers/utm_link_tracking_controller.rb): the short link sellers distribute.
import { Prisma, type User } from "@prisma/client";

import { column, selectRows, table } from "../models/sql.ts";
import { targets, utmUrl, type UtmLinkRow } from "../page-props/audience/utm-links.ts";
import { RoutingError, type ActionResult } from "./application-controller.ts";

const UNAVAILABLE = "This link's destination is no longer available.";

export async function utmLinkRedirect(permalink: string): Promise<ActionResult> {
  // `UtmLink.active.find_by!(permalink:)`: MySQL's collation compares the permalink case-insensitively.
  const [link] = await selectRows<UtmLinkRow & { seller_id: bigint }>(
    Prisma.sql`SELECT * FROM ${table("utm_links")} WHERE ${column("utm_links", "deleted_at")} IS NULL AND ${column("utm_links", "disabled_at")} IS NULL AND ${column("utm_links", "permalink")} = ${permalink} LIMIT 1`,
  );
  if (!link) throw new RoutingError("Not Found");
  const [seller] = await selectRows<User>(Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${link.seller_id} LIMIT 1`);
  // A link whose seller is gone raises in Rails (belongs_to on nil).
  if (!seller) throw new RoutingError("Not Found");
  const url = utmUrl(seller, link, await targets([link]));
  if (url === null) return { status: 404, body: UNAVAILABLE, contentType: "text/plain; charset=utf-8", paramsRead: true };
  return { status: 302, location: url };
}
