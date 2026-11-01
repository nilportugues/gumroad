// The controller side of the seller's product pages: LinksController (index, new, edit), Products::ArchivedController,
// Products::AffiliatedController and Products::CollabsController. Their before_actions and the start of each action run
// as filters, so a request the port cannot answer exactly goes to Rails whole (HandBackToRails) before anything renders.
import type { User } from "@prisma/client";

import { getRedis } from "../infra/redis.ts";
import { assertListingSupported } from "../page-props/seller-products/dashboard-products.ts";
import { listingParams } from "../page-props/seller-products/listing.ts";
import { linkPolicy, productsAffiliatedPolicy, productsArchivedLinkPolicy, productsCollabsPolicy } from "../policies/link.ts";
import { type ActionOptions, type Chain, HandBackToRails } from "./application-controller.ts";
import { signedInFilters } from "./buyer-pages.ts";
import { assertFlatQuery } from "./rails-params.ts";

// RedisKey.user_ids_with_payment_requirements_key
const PAYMENT_REQUIREMENTS_KEY = "user_ids_with_payment_requirements_key";

// ApplicationController#check_payment_details: a seller flagged as owing compliance information may be sent to the
// payments settings after a Stripe call, which the port leaves to Rails. A Redis failure reads as "no requirements".
export async function assertNoPaymentRequirements(seller: User | null): Promise<void> {
  if (!seller) return;
  let flagged = false;
  try {
    flagged = (await getRedis("main").sismember(PAYMENT_REQUIREMENTS_KEY, String(seller.id))) === 1;
  } catch {
    flagged = false;
  }
  if (flagged) throw new HandBackToRails();
}

const productsBase = (chain: Chain) => ({ queryString: chain.request.queryString });

// LinksController#index: the HTML page only (`before_action :check_payment_details`, then `authorize Link`).
export const PRODUCTS_INDEX_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: linkPolicy.index,
    beforeAction: async (chain, context) => {
      await assertNoPaymentRequirements(context.seller);
      return null;
    },
    state: async (chain, context) => {
      await assertListingSupported(context.seller!, false, listingParams(productsBase(chain)));
      return {};
    },
  }),
};

// Products::ArchivedController#index: with nothing archived at all (and no search) the seller goes back to /products.
export const PRODUCTS_ARCHIVED_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: productsArchivedLinkPolicy.index,
    action: async (chain, context) => {
      const params = listingParams(productsBase(chain));
      const { products, memberships } = await assertListingSupported(context.seller!, true, params);
      const blank = params.query === null || params.query.trim() === "";
      if (blank && products.length === 0 && memberships.length === 0) {
        return { status: 302, location: `${chain.request.protocol}${chain.request.hostWithPort}/products` };
      }
      return null;
    },
  }),
};

// Products::AffiliatedController#index and Products::CollabsController#index
export const PRODUCTS_AFFILIATED_OPTIONS = (assertSupported: (seller: User, chain: Chain) => Promise<void>): ActionOptions => ({
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: productsAffiliatedPolicy.index,
    state: async (chain, context) => {
      assertFlatQuery(chain.request.queryString);
      await assertSupported(context.seller!, chain);
      return {};
    },
  }),
});

export const PRODUCTS_COLLABS_OPTIONS = (assertSupported: (seller: User, chain: Chain) => Promise<void>): ActionOptions => ({
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: productsCollabsPolicy.index,
    state: async (chain, context) => {
      await assertSupported(context.seller!, chain);
      return {};
    },
  }),
});
