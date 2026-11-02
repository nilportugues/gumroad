// UrlRedirectsController's access rules: #fetch_url_redirect, #check_permissions and the after_actions every delivery
// action shares. A redirect that hangs off an installment (a post's attachments) is Rails', like the unavailable pages.
import type { Link, Purchase, Subscription, UrlRedirect, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { readEncryptedCookie, writeEncryptedCookie } from "../../auth/rails-cookies.ts";
import { railsCookieSecrets } from "../../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { cgiEscape } from "../../infra/signed-urls.ts";
import { createEventBang } from "../../models/consumption-event.ts";
import { LinkFlags } from "../../models/link.ts";
import { SubscriptionFlags } from "../../models/subscription.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { UserFlags } from "../../models/user.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { domainConfig } from "../../page-props/domain.ts";
import { remoteIp } from "../../page-props/audience/events.ts";
import { HandBackToRails, RoutingError, type ActionContext, type ActionResult, type Redirected } from "../application-controller.ts";
import { setCookieHeader } from "../rack-cookies.ts";
import { isPresent, queryParam, type RailsRequest } from "../rails-request.ts";

export const CONFIRMED_REDIRECT_COOKIE = "confirmed_redirect";
const LOCAL_ADDRESS = "127.0.0.1";

export type Viewer = { loggedInUser: User | null; currentUser: User | null };

export type Loaded = {
  redirect: UrlRedirect;
  purchase: Purchase | null;
  purchaser: User | null;
  subscription: Subscription | null;
  // UrlRedirect#referenced_link
  product: Link | null;
  seller: User | null;
};

export type ActionLike = Pick<ActionContext, "request" | "context">;

export const viewerOf = (action: ActionLike): Viewer => ({ loggedInUser: railsLoggedInUser(action.context), currentUser: action.context.loggedInUser });

export const requestIp = (request: RailsRequest) => remoteIp(request.headers) ?? LOCAL_ADDRESS;

const isTeamMember = (user: User) => UserFlags.isSet(user.flags, "is_team_member");

export const appDomainUrl = (path: string): string => {
  const config = domainConfig(process.env);
  return `${config.protocol}://${config.domain}${path}`;
};

// Hash#to_query: sorted keys, nil values dropped, values CGI-escaped.
export function toQuery(params: Record<string, string | null | undefined>): string {
  return Object.keys(params)
    .sort()
    .filter((key) => params[key] != null)
    .map((key) => `${cgiEscape(key)}=${cgiEscape(params[key]!)}`)
    .join("&");
}

export const withQuery = (path: string, params: Record<string, string | null | undefined>): string => {
  const query = toQuery(params);
  return query === "" ? path : `${path}?${query}`;
};

export const redirectPaths = {
  checkPurchaser: (token: string, next?: string | null) => withQuery(`/r/${token}/check_purchaser`, { next }),
  expired: (token: string) => `/r/${token}/expired`,
  rentalExpired: (token: string) => `/r/${token}/rental_expired`,
  membershipInactive: (token: string) => `/r/${token}/membership_inactive`,
  confirm: (params: Record<string, string | null | undefined>) => withQuery("/confirm", params),
  download: (token: string, params: Record<string, string | null | undefined> = {}) => withQuery(`/r/${token}`, params),
  downloadPage: (token: string, params: Record<string, string | null | undefined> = {}) => withQuery(`/d/${token}`, params),
  stream: (token: string, params: Record<string, string | null | undefined> = {}) => withQuery(`/s/${token}`, params),
  play: (token: string) => `/d/${token}/play`,
};

// redirect_to without allow_other_host, from a before_action: the chain halts, so no after_action runs.
export const halt = (location: string, status = 302): Redirected => ({ status, location, rescued: true });

// redirect_to_app_login: /login on the app domain, wherever the request arrived. From an action, so the after_actions still run.
export const appLoginRedirect = (nextPath: string): Redirected => ({ status: 302, location: appDomainUrl(withQuery("/login", { next: nextPath })) });

async function referencedProduct(redirect: UrlRedirect, purchase: Purchase | null): Promise<Link | null> {
  const find = (id: bigint | number | null) => (id === null ? null : db.link.findUnique({ where: { id: BigInt(id) } }));
  if (purchase) return find(purchase.link_id);
  if (redirect.imported_customer_id !== null) {
    const customer = await db.importedCustomer.findUnique({ where: { id: Number(redirect.imported_customer_id) } });
    return find(customer?.link_id ?? null);
  }
  return find(redirect.link_id);
}

// UrlRedirect.find_by(token:) and what the filters read from it. The token compares case-insensitively, as MySQL's collation does.
export async function loadRedirect(token: string): Promise<Loaded> {
  const redirect = await db.urlRedirect.findUnique({ where: { token } });
  if (!redirect) throw new RoutingError("Not Found");
  if (redirect.installment_id !== null) throw new HandBackToRails("a url redirect of an installment");
  const purchase = redirect.purchase_id === null ? null : await db.purchase.findUnique({ where: { id: redirect.purchase_id } });
  const [product, purchaser, subscription] = await Promise.all([
    referencedProduct(redirect, purchase),
    purchase?.purchaser_id == null ? null : db.user.findUnique({ where: { id: purchase.purchaser_id } }),
    purchase?.subscription_id == null ? null : db.subscription.findUnique({ where: { id: purchase.subscription_id } }),
  ]);
  const seller = product?.user_id == null ? null : await db.user.findUnique({ where: { id: product.user_id } });
  return { redirect, purchase, purchaser, subscription, product, seller };
}

// Purchase#is_test_purchase?: the product's seller bought it.
export const isTestPurchase = ({ purchase, product }: Loaded) => purchase !== null && product?.user_id != null && product.user_id === purchase.purchaser_id;

// Purchase#claim_by_seller?
export function claimBySeller({ purchase, product }: Loaded, user: User | null, testPurchase: boolean): boolean {
  if (!purchase || !user || testPurchase || product?.user_id !== user.id) return false;
  return purchase.purchaser_id !== null || (purchase.email ?? "").toLowerCase() !== (user.email ?? "").toLowerCase();
}

// UrlRedirectsController#test_purchase_viewer?
const testPurchaseViewer = (loaded: Loaded, viewer: Viewer) => viewer.loggedInUser !== null && (loaded.purchase?.purchaser_id === viewer.loggedInUser.id || isTeamMember(viewer.loggedInUser));

// Subscription#alive?
function subscriptionAlive(subscription: Subscription, now: Date): boolean {
  if (subscription.failed_at !== null || subscription.ended_at !== null) return false;
  return subscription.cancelled_at === null || subscription.cancelled_at.getTime() > now.getTime();
}

// Subscription#grant_access_to_product?
function grantsAccess(subscription: Subscription, product: Link | null, now: Date): boolean {
  if (SubscriptionFlags.isSet(subscription.flags, "is_installment_plan")) return subscription.cancelled_at === null && subscription.failed_at === null;
  if (subscriptionAlive(subscription, now)) return true;
  return !(product !== null && LinkFlags.isSet(product.flags, "block_access_after_membership_cancellation"));
}

// UrlRedirectsController#viewer_owns_subscription?. `true_original_purchase&.gift_given.nil?` short-circuits to nil (falsy) without one.
async function viewerOwnsSubscription({ purchase, subscription }: Loaded, viewer: Viewer): Promise<boolean> {
  if (!purchase || PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")) return false;
  if (!viewer.currentUser || !subscription || subscription.user_id === null || viewer.loggedInUser?.id !== subscription.user_id) return false;
  const candidates = await db.purchase.findMany({ where: { subscription_id: subscription.id }, orderBy: { id: "asc" }, select: { id: true, flags: true } });
  const original = candidates.find((candidate) => PurchaseFlags.isSet(candidate.flags, "is_original_subscription_purchase"));
  if (!original) return false;
  return (await db.gift.count({ where: { gifter_purchase_id: original.id } })) === 0;
}

const mobileAppToken = (request: RailsRequest) => isPresent(queryParam(request, "access_token")) && isPresent(queryParam(request, "mobile_token"));

export type AccessInput = { loaded: Loaded; action: ActionLike; actionName: string; now?: Date };

// #check_permissions: null lets the action run; a result halts it. Answers 404 by throwing RoutingError.
export async function checkPermissions({ loaded, action, actionName, now = new Date() }: AccessInput): Promise<ActionResult | null> {
  const { redirect, purchase, purchaser, subscription } = loaded;
  const { request } = action;
  const viewer = viewerOf(action);
  const token = redirect.token ?? "";

  if (purchase && (purchase.stripe_refunded === true || (purchase.chargeback_date !== null && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed")))) throw new RoutingError("Not Found");

  const viewerOwns = await viewerOwnsSubscription(loaded, viewer);
  const testPurchase = isTestPurchase(loaded);

  if (purchase && viewer.currentUser && purchaser && viewer.loggedInUser?.id !== purchaser.id && !viewerOwns && !isTeamMember(viewer.loggedInUser!) && !testPurchase) {
    return halt(redirectPaths.checkPurchaser(token, request.path));
  }
  if (purchase?.rental_expired === true) return halt(redirectPaths.rentalExpired(token));
  if (purchase && PurchaseFlags.isSet(purchase.flags, "is_access_revoked")) return halt(redirectPaths.expired(token));
  if (purchase && subscription && !grantsAccess(subscription, loaded.product, now)) return halt(redirectPaths.membershipInactive(token));

  // Doorkeeper decides these; a request carrying a mobile token is Rails'.
  if (mobileAppToken(request)) throw new HandBackToRails("a mobile app token");

  if (purchase && testPurchase) {
    if (testPurchaseViewer(loaded, viewer)) return null;
    if (viewer.currentUser) throw new RoutingError("Not Found");
    return { ...appLoginRedirect(request.path + (request.queryString === "" ? "" : `?${request.queryString}`)), rescued: true };
  }

  const confirmed = readEncryptedCookie(railsCookieSecrets(), CONFIRMED_REDIRECT_COOKIE, request.cookies.get(CONFIRMED_REDIRECT_COOKIE) ?? undefined);
  if (confirmed === token || viewerOwns || (purchase && ((purchaser && purchaser.id === viewer.loggedInUser?.id) || purchase.ip_address === requestIp(request)))) return null;

  if (redirect.imported_customer_id !== null) return null;
  if (!UrlRedirectFlags.isSet(redirect.flags, "has_been_seen") || purchase === null) return null;

  const display = queryParam(request, "display");
  return halt(redirectPaths.confirm({ id: token, destination: actionName, display: isPresent(display) ? display : null }));
}

// #require_seller_for_test_purchase: a test purchase's delivery actions are the seller's. Throws RoutingError (or answers a JSON 404).
export function requireSellerForTestPurchase(loaded: Loaded, action: ActionLike): "forbidden" | null {
  if (!isTestPurchase(loaded)) return null;
  return testPurchaseViewer(loaded, viewerOf(action)) ? null : "forbidden";
}

export function confirmedRedirectCookie(token: string): string {
  return setCookieHeader(CONFIRMED_REDIRECT_COOKIE, { value: writeEncryptedCookie(railsCookieSecrets(), CONFIRMED_REDIRECT_COOKIE, token), path: "/", httpOnly: true, sameSite: "lax" });
}

// #register_that_user_has_downloaded_product: `increment!(:uses)`, `mark_as_seen` and the confirmation cookie.
export async function registerDownload(redirect: UrlRedirect, now: Date): Promise<string> {
  await db.$executeRaw`UPDATE url_redirects SET uses = COALESCE(uses, 0) + 1 WHERE id = ${redirect.id}`;
  await db.$executeRaw`UPDATE url_redirects SET flags = COALESCE(flags, 0) | 1, updated_at = ${now} WHERE id = ${redirect.id}`;
  return confirmedRedirectCookie(redirect.token ?? "");
}

// #create_consumption_event!
export async function createConsumptionEvent(loaded: Loaded, request: RailsRequest, eventType: string, productFileId: bigint | null, now: Date): Promise<void> {
  const { redirect, purchase } = loaded;
  await createEventBang(
    {
      event_type: eventType,
      platform: "web",
      url_redirect_id: redirect.id,
      product_file_id: productFileId,
      purchase_id: redirect.purchase_id,
      product_id: purchase?.link_id ?? redirect.link_id,
      folder_id: queryParam(request, "folder_id") ?? null,
      consumed_at: now,
      ip_address: requestIp(request),
    },
    () => now,
  );
}
