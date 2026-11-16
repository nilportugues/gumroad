// `purchase.reload` drops the associations the instance had loaded, so the first read of each afterwards is a query again. A purchase built from
// a PurchaseContext (its link and seller rows) is marked here by refund_purchase!'s reload, and these readers then make the query once.
import { Prisma } from "@prisma/client";

import { loadBelongsTo, type BelongsTo } from "./concerns/rails-validations.ts";
import type { PurchaseContext, PurchaseRecord } from "./purchase-create.ts";
import { column, connection, selectRows, table } from "./sql.ts";
import { Users, type UserRecord } from "./user.ts";

const STALE = "staleAssociations";
type Name = "seller" | "link" | "link.user";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const LINK: BelongsTo = { name: "link", foreignKey: "link_id", targetTable: "links", targetModel: "Link" };

export function markAssociationsReloaded(purchase: PurchaseRecord): void {
  purchase.ivars[STALE] = new Set<Name>(["seller", "link", "link.user"]);
}

const takeStale = (purchase: PurchaseRecord, name: Name) =>
  (purchase.ivars[STALE] as Set<Name> | undefined)?.delete(name) === true;

// `purchase.seller`
export async function sellerOf(purchase: PurchaseRecord): Promise<UserRecord> {
  if (takeStale(purchase, "seller")) await loadBelongsTo(purchase, SELLER, { tx: (await connection()) as never });
  return Users.load((purchase.ivars.context as PurchaseContext).seller);
}

// What the purchase's validations read on a save: `seller`, `link`, then `link.user` (seller_is_link_user)
export async function loadLinkAssociations(purchase: PurchaseRecord): Promise<void> {
  const tx = { tx: (await connection()) as never };
  if (takeStale(purchase, "seller")) await loadBelongsTo(purchase, SELLER, tx);
  if (takeStale(purchase, "link")) await loadBelongsTo(purchase, LINK, tx);
  if (takeStale(purchase, "link.user")) {
    const userId = (purchase.ivars.context as PurchaseContext).link.user_id;
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`,
    );
  }
}
