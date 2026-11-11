// The buyer-facing Inertia pages (forgot password, subscription magic link, invoices, library,
// wishlists, reviews). Registered in ../pages.ts. Not ported, and so not in routes.json: see the
// report in nextjs/src/app/(app)/CONVERTING.md ("Buyer pages").
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { teamInvitationEmail } from "../../controllers/auth-pages.ts";
import {
  EDIT_PASSWORD_OPTIONS,
  idFromExternalId,
  INVOICE_CONFIRM_OPTIONS,
  LIBRARY_OPTIONS,
  libraryParams,
  MAGIC_LINK_OPTIONS,
  NEW_PASSWORD_OPTIONS,
  notFound,
  REVIEWS_OPTIONS,
  safeDecode,
  WISHLISTS_OPTIONS,
} from "../../controllers/buyer-pages.ts";
import { queryParam, type RailsRequest } from "../../controllers/rails-request.ts";
import type { ActionContext } from "../load-page.ts";
import type { PageSpec } from "../pages.ts";

import { libraryProps, purchaseAnalyticsProps, receiptPurchases } from "./library.ts";
import { reviewsProps } from "./reviews.ts";
import { magicLinkProps } from "./subscriptions.ts";
import { aliveFollowingWishlistsOf, aliveWishlistsOf, wishlistsLibraryProps } from "./wishlists.ts";

// params[name] for a flat query key; a bracketed one was handed back to Rails by the filters.
export const queryValue = (action: ActionContext, name: string) =>
  queryParam({ queryString: action.url.search.replace(/^\?/, "") } as RailsRequest, name);

// The tags PageMeta::Analytics sets stay where ApplicationController declares them while the
// controller's re-declared callbacks (title, CSRF, defaults) move to the end of the chain.
const ANALYTICS_META_KEYS = [
  "meta-property-gr-google_analytics-enabled",
  "meta-property-gr-fb_pixel-enabled",
  "meta-property-gr-tiktok_pixel-enabled",
  "meta-property-gr-logged_in_user-id",
  "meta-property-gr-page-type",
];

// User::PasswordsController re-declares set_default_page_title, set_csrf_meta_tags and
// set_default_meta_tags.
function passwordsMeta({ meta }: ActionContext, title: string) {
  meta.moveToEnd(meta.keys().filter((key) => !ANALYTICS_META_KEYS.includes(key)));
  meta.set({ title });
}

// `current_seller`: the account being acted on. The page's filters have already sent anyone else away.
function currentSeller(action: ActionContext) {
  const seller = action.context.currentSeller;
  if (seller === null) throw new TypeError("undefined method for nil: current_seller");
  return seller;
}

async function libraryPage(action: ActionContext) {
  action.meta.set({ title: "Library" });
  const user = railsLoggedInUser(action.context);
  if (!user) throw new TypeError("undefined method for nil: logged_in_user");
  const params = libraryParams({ queryString: action.url.search.replace(/^\?/, "") } as RailsRequest);
  return {
    ...(await libraryProps(user, params)),
    purchase_analytics: await purchaseAnalyticsProps(user.id, params.purchaseIds ?? []),
    receipt_purchases: await receiptPurchases(user.id, params.purchaseIds ?? []),
  };
}

export const BUYER_PAGES: Record<string, PageSpec> = {
  // User::PasswordsController#new: AuthPresenter#login_props with no OAuth application.
  "/users/forgot_password/new": {
    component: "User/Passwords/New",
    options: NEW_PASSWORD_OPTIONS,
    props: (_, action) => {
      passwordsMeta(action, "Forgot password");
      return {
        email: queryValue(action, "email") ?? teamInvitationEmail(queryValue(action, "next") ?? null),
        application_name: null,
      };
    },
  },
  "/users/forgot_password/edit": {
    component: "User/Passwords/Edit",
    options: EDIT_PASSWORD_OPTIONS,
    props: (_, action) => {
      passwordsMeta(action, "Reset your password");
      return { reset_password_token: action.state.reset_password_token };
    },
  },
  "/subscriptions/:subscription_id/magic_link/new": {
    component: "Subscriptions/MagicLinks/New",
    options: MAGIC_LINK_OPTIONS,
    props: ({ subscription_id }, action) => {
      // App Router hands dynamic segments over still percent-encoded ("==" arrives as %3D%3D).
      const id = idFromExternalId(safeDecode(subscription_id!));
      if (id === null) notFound();
      return magicLinkProps(id!, queryValue(action, "email_sent") ?? null);
    },
  },
  // WishlistsController#index (the HTML variant; JSON goes to Rails)
  "/wishlists": {
    component: "Wishlists/Index",
    options: WISHLISTS_OPTIONS,
    props: async (_, action) => {
      action.meta.set({ title: "Saved" });
      return { wishlists: await wishlistsLibraryProps(await aliveWishlistsOf(currentSeller(action).id)) };
    },
  },
  // Wishlists::FollowingController#index
  "/wishlists/following": {
    component: "Wishlists/Following/Index",
    options: WISHLISTS_OPTIONS,
    props: async (_, action) => {
      action.meta.set({ title: "Following" });
      return {
        wishlists: await wishlistsLibraryProps(await aliveFollowingWishlistsOf(currentSeller(action).id), {
          isWishlistCreator: false,
        }),
      };
    },
  },
  // LibraryController#index. `purchase_id` (post-checkout analytics) in a non-USD or buyer-local currency goes to Rails in the filters.
  "/library": { component: "Library/Index", options: LIBRARY_OPTIONS, props: (_, action) => libraryPage(action) },
  // `get "/read", to: "library#index"`: the same action under another path.
  "/read": { component: "Library/Index", options: LIBRARY_OPTIONS, props: (_, action) => libraryPage(action) },
  "/library/purchase/:id": {
    component: "Library/Index",
    options: LIBRARY_OPTIONS,
    props: (_, action) => libraryPage(action),
  },
  // ReviewsController#index: ReviewsPresenter.new(current_seller)
  "/reviews": {
    component: "Reviews/Index",
    options: REVIEWS_OPTIONS,
    props: async (_, action) => reviewsProps(currentSeller(action)),
  },
  // Purchases::InvoicesController#confirm
  "/purchases/:purchase_id/invoice/confirm": {
    component: "Purchases/Invoices/Confirm",
    options: INVOICE_CONFIRM_OPTIONS,
    props: () => ({}),
  },
};
