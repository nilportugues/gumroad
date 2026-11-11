// WishlistsController#show on seller subdomains and custom domains (`seller:/wishlists/:id`). Rendered for a visitor who is not
// signed in (routes.json: signedOutOnly) with no `layout` param; the signed-in page (`following`, `can_edit`) and the profile and
// discover layouts go to Rails.
import { Prisma } from "@prisma/client";

import { decryptNumeric } from "../../../lib/obfuscate-ids.ts";
import {
  type Chain,
  type FilterOutcome,
  HandBackToRails,
  RoutingError,
} from "../../controllers/application-controller.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { rubyToI } from "../../models/concerns/ruby-numeric.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { findUserById } from "../../presenters/product-reads.ts";
import { publicProps, setWishlistPageMeta, type WishlistRow } from "../../presenters/wishlist.ts";
import type { PageSpec } from "../pages.ts";

import { requireHtmlPage } from "./post-pages.ts";
import { setFaviconMetaTags } from "./post.ts";
import { userByDomain } from "./seller-host.ts";

const WISHLIST_PATH = /^\/wishlists\/([^/.?]+)$/u;
// ObfuscateIds::MAX_NUMERIC_ID
const MAX_NUMERIC_ID = 2 ** 30 - 1;

const blank = (value: string | null | undefined) => value == null || value.trim() === "";

// `user_by_domain(request.host).wishlists.alive.find_by_url_slug(params[:id])`
async function wishlistOf(chain: Chain): Promise<{ wishlist: WishlistRow; ownerId: bigint }> {
  const url = new URL(`${chain.request.protocol}${chain.request.hostWithPort}`);
  const owner = await userByDomain(url.hostname);
  // Rails calls `.wishlists` on nil: a 500 the port does not reproduce.
  if (owner === null) throw new HandBackToRails("a host with no seller");

  const slug = decodeURIComponent(WISHLIST_PATH.exec(chain.request.path)?.[1] ?? "");
  const id = rubyToI(slug.split("-").at(-1) ?? "");
  if (id < 0 || id > MAX_NUMERIC_ID) throw new HandBackToRails("a wishlist id outside the obfuscated range");
  const [wishlist] = await selectRows<WishlistRow>(
    Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "user_id")} = ${owner.id} AND ${column("wishlists", "deleted_at")} IS NULL AND ${column("wishlists", "id")} = ${decryptNumeric(id)} LIMIT 1`,
  );
  if (!wishlist) throw new RoutingError("Not Found");
  return { wishlist, ownerId: owner.id };
}

async function wishlistFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtmlPage(chain);
  assertFlatQuery(chain.request.queryString);
  // A layout adds the profile or the discover navigation; a blank one adds nothing.
  if (!blank(queryParam(chain.request, "layout"))) throw new HandBackToRails("a wishlist with a layout");
  if (queryParam(chain.request, "recommended_by") === "") throw new HandBackToRails("a blank recommender");
  const { wishlist, ownerId } = await wishlistOf(chain);
  return { state: { wishlist_id: String(wishlist.id), owner_id: String(ownerId) } };
}

export const WISHLIST_PAGES: Record<string, PageSpec> = {
  "seller:/wishlists/:id": {
    component: "Wishlists/Show",
    buyerCurrencyFooter: true,
    options: { filters: wishlistFilters },
    props: async (_params, action) => {
      const [wishlist] = await selectRows<WishlistRow>(
        Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${BigInt(action.state.wishlist_id as string)} LIMIT 1`,
      );
      const owner = (await findUserById(BigInt(action.state.owner_id as string)))!;
      await setWishlistPageMeta(action.meta, wishlist!, owner);
      await setFaviconMetaTags(action.meta, owner as never);
      const recommendedBy = action.url.searchParams.get("recommended_by");
      return publicProps(wishlist!, owner, {
        request: {
          host: action.url.hostname,
          hostWithPort: action.url.host,
          protocol: `${action.url.protocol}//`,
          remoteIp: "",
          params: {},
          cookies: new Map(),
        },
        recommendedBy,
      });
    },
  },
};
