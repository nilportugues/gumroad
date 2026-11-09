// Port of UrlRedirectsController#check_permissions and #withdrawn_content_response for #download_page. Pure:
// the caller loads the facts, so every branch can be pinned without a database.
import { cgiEscape } from "../../controllers/rails-params.ts";

export type GatePurchase = {
  // stripe_refunded, or a chargeback that was not reversed.
  withdrawn: boolean;
  purchaserId: bigint | null;
  rentalExpired: boolean;
  accessRevoked: boolean;
  isTestPurchase: boolean;
  ipAddress: string | null;
  // subscription && !subscription.grant_access_to_product?
  membershipInactive: boolean;
};

export type GateInput = {
  token: string;
  // request.path and request.fullpath.
  path: string;
  fullpath: string;
  display: string | null;
  // params[:action], which the confirm page sends the buyer back to. Defaults to the download page.
  destination?: string;
  // The buyer content page's background poll (download_page_polling_request?).
  isPoll: boolean;
  hasBeenSeen: boolean;
  purchase: GatePurchase | null;
  viewer: { id: bigint; isTeamMember: boolean } | null;
  viewerOwnsSubscription: boolean;
  // cookies.encrypted[:confirmed_redirect] == token
  confirmedCookie: boolean;
  remoteIp: string | null;
  // login_url(next:, host: DOMAIN, protocol: PROTOCOL)
  loginUrl: (next: string) => string;
};

export type GateDecision = { kind: "pass" } | { kind: "redirect"; location: string } | { kind: "notFound" };

const redirect = (location: string): GateDecision => ({ kind: "redirect", location });

export function decideAccess(input: GateInput): GateDecision {
  const { token, purchase, viewer } = input;

  // A refund or chargeback has no redirect of its own; the poll gets the expired page because the
  // page drops a non-Inertia response (a 404) from the URL it polled.
  if (purchase?.withdrawn) return input.isPoll ? redirect(`/r/${token}/expired`) : { kind: "notFound" };

  if (purchase && viewer && purchase.purchaserId !== null && viewer.id !== purchase.purchaserId && !input.viewerOwnsSubscription && !viewer.isTeamMember && !purchase.isTestPurchase) {
    return redirect(`/r/${token}/check_purchaser?next=${cgiEscape(input.path)}`);
  }
  if (purchase?.rentalExpired) return redirect(`/r/${token}/rental_expired`);
  if (purchase?.accessRevoked) return redirect(`/r/${token}/expired`);
  if (purchase?.membershipInactive) return redirect(`/r/${token}/membership_inactive`);

  // A seller's own purchase carries the seller's public email, so the checks below prove nothing.
  if (purchase?.isTestPurchase) {
    const isViewer = viewer !== null && (purchase.purchaserId === viewer.id || viewer.isTeamMember);
    if (isViewer) return { kind: "pass" };
    return viewer ? { kind: "notFound" } : redirect(input.loginUrl(input.fullpath));
  }

  const holdsLink =
    input.confirmedCookie ||
    input.viewerOwnsSubscription ||
    (purchase !== null && ((purchase.purchaserId !== null && viewer?.id === purchase.purchaserId) || (purchase.ipAddress !== null && purchase.ipAddress === input.remoteIp)));
  if (holdsLink) return { kind: "pass" };
  if (!input.hasBeenSeen || purchase === null) return { kind: "pass" };

  // to_query sorts the keys.
  const query = [`destination=${cgiEscape(input.destination ?? "download_page")}`, ...(input.display ? [`display=${cgiEscape(input.display)}`] : []), `id=${cgiEscape(token)}`].join("&");
  return redirect(`/confirm?${query}`);
}
