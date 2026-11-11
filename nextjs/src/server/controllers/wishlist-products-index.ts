// Wishlists::ProductsController#index (WishlistPresenter#public_items): the page of product cards a wishlist's "load more" fetches
// on its owner's host. Public; reads only. Whatever the cards cannot prove (a seller using buyer local currency) goes to Rails whole.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { publicItems, type WishlistRow } from "../presenters/wishlist.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { assertFlatQuery } from "./rails-params.ts";

// Pagy reads `page` with `to_i` (digits, an optional sign and underscore separators after leading whitespace; blank is the first
// page). A page past what a signed 32-bit offset holds is for Rails: the database's own error is not reproduced.
const RUBY_INTEGER_PREFIX = /^\s*([+-]?\d+(?:_\d+)*)/u;
const MAX_PAGE = 2 ** 31 - 1;

async function index(input: MutationInput): Promise<ActionResult> {
  assertFlatQuery(input.request.queryString);
  // `Wishlist.find_by_external_id!`
  const wishlistId = decrypt(input.routeParams.wishlist_id ?? "");
  const [wishlist] =
    wishlistId === null
      ? []
      : await selectRows<WishlistRow>(
          Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${wishlistId} LIMIT 1`,
        );
  if (!wishlist) throw new RoutingError("Not Found");

  // Without `page` Rails raises a NameError in `pagy` (the presenter has no `params`) and Pagy raises VariableError below page 1: both 500.
  const page = input.params.page;
  if (page === undefined)
    throw new Error("undefined local variable or method 'params' for an instance of WishlistPresenter");
  if (typeof page !== "string") throw new HandBackToRails("a page that is not a plain value");
  const digits = RUBY_INTEGER_PREFIX.exec(page)?.[1]?.replaceAll("_", "");
  const requested = page.trim() === "" ? 1 : Number(digits ?? 0);
  if (requested < 1) throw new Error("expected :page >= 1");
  if (requested > MAX_PAGE) throw new HandBackToRails("a page past a signed 32-bit offset");

  return jsonResponse(
    await publicItems(wishlist, {
      request: {
        host: input.request.host,
        hostWithPort: input.request.hostWithPort,
        protocol: input.request.protocol,
        remoteIp: "",
        params: {},
        cookies: new Map(),
      },
      currentSellerId: input.context.currentSeller?.id ?? null,
      page: requested,
    }),
  );
}

registerMutations({
  method: "GET",
  pattern: "/wishlists/:wishlist_id/products",
  skipForgeryProtection: true,
  run: index,
});
