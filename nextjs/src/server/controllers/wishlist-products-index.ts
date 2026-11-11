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

const POSITIVE_INTEGER = /^[1-9]\d*$/u;

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

  // Without `page` Rails raises in `pagy` (the presenter has no `params`), and Pagy refuses a page below 1.
  const page = input.params.page;
  if (typeof page !== "string" || !POSITIVE_INTEGER.test(page)) throw new HandBackToRails("a page Pagy would not read");

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
      page: Number(page),
    }),
  );
}

registerMutations({
  method: "GET",
  pattern: "/wishlists/:wishlist_id/products",
  skipForgeryProtection: true,
  run: index,
});
