// The controller side of the buyer pages: the before_actions that run ahead of the page (Devise's
// PasswordsController, SubscriptionsController, Purchases::InvoicesController, ...) as filters that
// halt with a redirect or a 404, or hand the props what they found. Only the GET renders are ported.
import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { deviseTokenDigest } from "../auth/devise-token.ts";
import { productReviewPolicy, purchasePolicy, wishlistPolicy } from "../policies/buyer.ts";
import { assertLibrarySupported } from "../page-props/buyer/library.ts";
import { loadSellerContext, requireUser, type AuthorizedSellerContext, type SellerContext } from "../policies/seller-context.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { type ActionOptions, type Chain, type FilterOutcome, HandBackToRails, type Redirected, RoutingError } from "./application-controller.ts";
import { requireNoAuthentication } from "./auth-pages.ts";
import { assertFlatQuery, cgiEscape, requestFormat } from "./rails-params.ts";
import { fullpath, isPresent, queryParam } from "./rails-request.ts";

const INVALID_RESET_TOKEN = "That reset password token doesn't look valid (or may have expired).";

// The pages below render HTML only: any other format makes Rails raise or negotiate, which the port
// leaves to it (an Inertia visit asks for the page whatever it accepts).
function requireHtml(chain: Chain): void {
  if (!chain.request.headers.has("x-inertia") && requestFormat(chain.request) !== "html") throw new HandBackToRails();
}

// Rails raises ActiveRecord::RecordNotFound / RoutingError for a record that is not there.
export const notFound = (): never => {
  throw new RoutingError("Not Found");
};

// `Model.find_by_external_id(id)`: ObfuscateIds.decrypt, then a lookup by primary key.
export const idFromExternalId = (externalId: string): bigint | null => {
  const id = decrypt(externalId);
  return id === null ? null : BigInt(id);
};

async function newPasswordFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  return { state: {} };
}

// User::PasswordsController#edit, after Devise's assert_reset_token_passed (which sends a request
// without a token to the sign-in page with a flash: left to Rails).
async function editPasswordFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const token = queryParam(chain.request, "reset_password_token");
  if (!isPresent(token)) throw new HandBackToRails();

  const user = await db.user.findFirst({ where: { reset_password_token: deviseTokenDigest("reset_password_token", token) }, orderBy: { id: "asc" } });
  if (!user) return { halt: { status: 302, location: "/", flash: { warning: INVALID_RESET_TOKEN } } };
  return { state: { reset_password_token: token } };
}

export const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const MAGIC_LINK_PATH = /^\/subscriptions\/([^/.]+)\/magic_link\/new$/;

// Subscriptions::MagicLinksController#fetch_subscription
async function magicLinkFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const externalId = MAGIC_LINK_PATH.exec(chain.request.path)?.[1];
  const id = externalId === undefined ? null : idFromExternalId(safeDecode(externalId));
  const subscription = id === null ? null : await db.subscription.findUnique({ where: { id }, select: { id: true } });
  if (!subscription) notFound();
  return { state: {} };
}

// Purchases::InvoicesController#confirm: only set_noindex_header applies (set_purchase is skipped).
async function invoiceConfirmFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  chain.headers.set("x-robots-tag", "noindex");
  return { state: {} };
}

export const NEW_PASSWORD_OPTIONS: ActionOptions = { prepended: requireNoAuthentication, filters: newPasswordFilters };
export const EDIT_PASSWORD_OPTIONS: ActionOptions = { prepended: requireNoAuthentication, filters: editPasswordFilters };
export const MAGIC_LINK_OPTIONS: ActionOptions = { filters: magicLinkFilters };
export const INVOICE_CONFIRM_OPTIONS: ActionOptions = { filters: invoiceConfirmFilters };

const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";

const blank = (value: string | null | undefined) => value == null || value.trim() === "";

export type SignedInPage = {
  // Sellers::BaseController includes RequireAccountEmail.
  requireAccountEmail?: boolean;
  // The `authorize` the action runs (Pundit), or null for a page that does not authorize in a filter.
  authorize: (context: SellerContext) => boolean;
  // Filters the controller declares after authenticate_user!, before the action.
  beforeAction?: (chain: Chain, context: AuthorizedSellerContext) => Promise<Redirected | null>;
  // The page reads a nested parameter (`sort[key]`) and checks the query string itself.
  nestedQuery?: boolean;
  // The action's own redirects, after `authorize` and before it renders.
  action?: (chain: Chain, context: AuthorizedSellerContext) => Promise<Redirected | null>;
  // What the action reads from the request and hands the props (`action.state`).
  state?: (chain: Chain, context: AuthorizedSellerContext) => Promise<Record<string, unknown>>;
};

// authenticate_user!, then `authorize` and PunditAuthorization#default_user_not_authorized, for a page
// only a signed-in buyer can see. A signed-out visitor is sent to Rails by the route table
// (signedInOnly); the redirect here is the one Rails would send anyway.
export function signedInFilters(page: SignedInPage) {
  return async (chain: Chain): Promise<FilterOutcome> => {
    requireHtml(chain);
    if (!page.nestedQuery) assertFlatQuery(chain.request.queryString);

    const context = await loadSellerContext(chain.auth.context);
    if (context.user && page.requireAccountEmail && blank(context.user.email) && blank(context.user.unconfirmed_email) && chain.auth.context.impersonatedUser === null) {
      chain.session.data.flash = { discard: [], flashes: { warning: ADD_EMAIL_MESSAGE } };
      return { halt: { status: 302, location: "/settings", rescued: true } };
    }
    if (!chain.auth.context.loggedInUser) return { halt: { status: 302, location: `/login?next=${cgiEscape(fullpath(chain.request))}`, rescued: true } };

    const signedIn = requireUser(context);
    const before = await page.beforeAction?.(chain, signedIn);
    if (before) return { halt: before };

    if (!page.authorize(signedIn)) {
      const switched = new URLSearchParams(chain.request.queryString).has("account_switched");
      return { halt: { status: 302, location: "/dashboard", rescued: true, ...(switched ? {} : { flash: { alert: notAllowedMessage(context) } }) } };
    }
    const redirected = await page.action?.(chain, signedIn);
    if (redirected) return { halt: redirected };
    return { state: (await page.state?.(chain, signedIn)) ?? {} };
  };
}

// WishlistsController#index and Wishlists::FollowingController#index, ReviewsController#index
export const WISHLISTS_OPTIONS: ActionOptions = { filters: signedInFilters({ authorize: wishlistPolicy.index }) };
export const REVIEWS_OPTIONS: ActionOptions = { filters: signedInFilters({ authorize: productReviewPolicy.index }) };

// LibraryController#index: Sellers::BaseController (RequireAccountEmail, authenticate_user!), check_user_confirmed, then
// `authorize Purchase`. What the port cannot answer (an unconfirmed account, which re-sends the confirmation email; a
// request for purchase analytics) goes to Rails whole.
export const libraryParams = (request: Chain["request"]) => {
  const text = (name: string) => queryParam(request, name) ?? "";
  return { page: text("page"), sort: text("sort"), query: text("query"), creators: text("creators"), bundles: text("bundles"), showArchivedOnly: text("show_archived_only") === "true", subscriptionsOnly: text("subscriptions_only") === "true" };
};

export const LIBRARY_OPTIONS: ActionOptions = {
  filters: signedInFilters({
    requireAccountEmail: true,
    authorize: purchasePolicy.index,
    beforeAction: async (chain, context) => {
      if (context.user.confirmed_at === null) throw new HandBackToRails();
      if (queryParam(chain.request, "purchase_id") !== undefined) throw new HandBackToRails();
      await assertLibrarySupported(context.user.id, libraryParams(chain.request));
      return null;
    },
  }),
};
