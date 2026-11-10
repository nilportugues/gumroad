// What Audience::PurchasePolicy#revoke_access? and #undo_revoke_access? read off a purchase, shared by the customers page and the mobile app.
import { Prisma, type Link, type Purchase } from "@prisma/client";

import type { AccessRecord } from "../policies/audience-purchase.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { LinkFlags } from "./link.ts";
import { column, selectRows, table } from "./sql.ts";

export async function accessRecord(purchase: Purchase): Promise<AccessRecord> {
  const [link] = await selectRows<Link>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${purchase.link_id} LIMIT 1`,
  );
  const [subscription] =
    purchase.subscription_id == null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${column("subscriptions", "id")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${purchase.subscription_id} LIMIT 1`,
        );
  return {
    accessRevoked: PurchaseFlags.isSet(purchase.flags, "is_access_revoked"),
    refunded: purchase.stripe_refunded === true || (purchase.stripe_refunded as unknown) === 1,
    hasSubscription: subscription !== undefined,
    linkIsPhysical() {
      if (!link) throw new TypeError("undefined method 'is_physical' for nil");
      return LinkFlags.isSet(link.flags, "is_physical");
    },
  };
}
