// Wishlists::FollowersController#unsubscribe: the link in a wishlist update email.
import { Prisma, type User, type Wishlist, type WishlistFollower } from "@prisma/client";

import { decrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { subdomainWithProtocol, Users } from "../models/user.ts";
import { WishlistFollowerDeletable, WishlistFollowers } from "../models/wishlist-follower.ts";
import { parameterize } from "../page-props/meta-tags.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { assertFlatQuery } from "./rails-params.ts";
import { queryParam, type RailsRequest } from "./rails-request.ts";

export async function wishlistUnsubscribe(request: RailsRequest): Promise<ActionResult> {
  assertFlatQuery(request.queryString);
  const externalId = queryParam(request, "follower_id");
  // `find_by_external_id!(nil)` raises RecordNotFound like an unknown id does.
  const id = typeof externalId === "string" ? decrypt(externalId) : null;
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`wishlist_followers`.*")} FROM ${table("wishlist_followers")} WHERE ${column("wishlist_followers", "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  const follower = WishlistFollowers.load(castRow<WishlistFollower>("WishlistFollower", row));
  await WishlistFollowerDeletable.markDeletedBang(follower);
  const [wishlist] = await selectRows<Wishlist>(
    Prisma.sql`SELECT * FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${follower.get("wishlist_id")} LIMIT 1`,
  );
  const [owner] = await selectRows<User>(
    Prisma.sql`SELECT * FROM ${table("users")} WHERE ${column("users", "id")} = ${wishlist!.user_id} LIMIT 1`,
  );
  const host = subdomainWithProtocol(Users.load(owner!));
  if (host === null || host === undefined) throw new HandBackToRails("a wishlist whose seller has no subdomain");
  const slug = `${parameterize(wishlist!.name)}-${encryptNumeric(Number(wishlist!.id))}`;
  return {
    status: 302,
    location: `${host}/wishlists/${slug}`,
    flash: { notice: `You are no longer following ${wishlist!.name}.` },
  };
}
