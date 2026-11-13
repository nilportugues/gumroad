// WishlistsController#show on seller subdomains and custom domains (`seller:/wishlists/:id`), for a signed-out or signed-in visitor
// and the `profile` and `discover` layouts. A discover layout seeded by 4 or more curated-product ids goes to Rails.
import { Prisma } from "@prisma/client";

import { decryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
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
import { loadSellerContext } from "../../policies/seller-context.ts";
import { settingsProfilePolicy } from "../../policies/settings/profile.ts";
import { guidOf } from "../../presenters/product-page.ts";
import { findUserById } from "../../presenters/product-reads.ts";
import { publicProps, setWishlistPageMeta, type WishlistRow } from "../../presenters/wishlist.ts";
import { curatedTaxonomyIds } from "../discover/curated-products.ts";
import { taxonomiesForNav } from "../discover/taxonomies.ts";
import { NotPortedError } from "../not-ported.ts";
import type { PageSpec } from "../pages.ts";
import { creatorProfile } from "../settings/profile.ts";

import { requireHtmlPage } from "./post-pages.ts";
import { setFaviconMetaTags } from "./post.ts";
import { userByDomain } from "./seller-host.ts";

const WISHLIST_PATH = /^\/wishlists\/([^/.?]+)$/u;
// ObfuscateIds::MAX_NUMERIC_ID
const MAX_NUMERIC_ID = 2 ** 30 - 1;

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
  const { wishlist, ownerId } = await wishlistOf(chain);
  // `curated_products` (RecommendedProducts::DiscoverService) orders the discover navigation. Resolved here so a visitor
  // seeded by 4 or more products (random sample in Rails) is handed back before the page is built.
  let curatedTaxonomies: bigint[] = [];
  if (queryParam(chain.request, "layout") === "discover") {
    try {
      curatedTaxonomies = await curatedTaxonomyIds(
        railsLoggedInUser(chain.auth.context),
        guidOf(chain.request.headers.get("cookie")),
      );
    } catch (error) {
      if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
      throw error;
    }
  }
  return {
    state: {
      wishlist_id: String(wishlist.id),
      owner_id: String(ownerId),
      curated_taxonomy_ids: curatedTaxonomies.map(String),
    },
  };
}

export const WISHLIST_PAGES: Record<string, PageSpec> = {
  "seller:/wishlists/:id": {
    component: "Wishlists/Show",
    buyerCurrencyFooter: true,
    options: { filters: wishlistFilters },
    props: async (_params, action) => {
      const context = await loadSellerContext(action.context);
      const layout = action.url.searchParams.get("layout");
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
        pundit: { userId: context.user?.id ?? null, sellerId: context.seller?.id ?? null },
        layout,
        // ProfilePresenter#can_edit_profile?
        creatorProfile: () =>
          creatorProfile(
            owner as unknown as Parameters<typeof creatorProfile>[0],
            !!context.user && context.seller?.id === owner.id && settingsProfilePolicy.update(context),
          ),
        taxonomiesForNav: () =>
          taxonomiesForNav((action.state.curated_taxonomy_ids as string[]).map((id) => BigInt(id))),
      });
    },
  },
};
