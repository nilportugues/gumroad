// What Sellers::BaseController, RequireAccountEmail and PunditAuthorization do before a seller page
// renders: sign-in check, the account email check and the policy verdict.
import * as Routes from "@/lib/navigation/routes";

import { RoutingError } from "../../controllers/application-controller.ts";
import type { Redirected } from "../../controllers/application-controller.ts";
import type { GuardInput } from "../guards.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { notifyError } from "../../infra/error-reporting.ts";
import { authorize, type PolicyQuery } from "../../policies/authorize.ts";
import { findUserMembershipForSeller, loadSellerContext, MembershipNotFoundError, NotAuthorizedError, roleOwnerFor, requireUser, type SellerContext } from "../../policies/seller-context.ts";

const NOT_ALLOWED = "You are not allowed to perform this action.";
const ACCOUNT_EMAIL_REQUIRED = "Please add an email address to your account before continuing.";

// Rack's URL-encoding for query values (`Hash#to_query` uses CGI.escape): spaces are `+`.
export const cgiEscape = (value: string) =>
  encodeURIComponent(value).replace(/%20/gu, "+").replace(/[!'()*~]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// PunditAuthorization#build_error_message
export function notAllowedMessage(context: SellerContext): string {
  if (!context.user || roleOwnerFor(requireUser(context), context.seller)) return NOT_ALLOWED;
  try {
    const membership = findUserMembershipForSeller(context, context.seller!);
    const role = membership.role.charAt(0).toUpperCase() + membership.role.slice(1);
    return `Your current role as ${role} cannot perform this action.`;
  } catch (error) {
    if (!(error instanceof MembershipNotFoundError)) throw error;
    notifyError(new Error(`Team: Could not find membership for user ${context.user.id} and seller ${context.seller?.id}`));
    return NOT_ALLOWED;
  }
}

export type SellerGuardStep = (context: SellerContext) => void | Promise<void>;

// `authenticate_user!`, `require_account_email`, then the action's `authorize`. A step may throw
// RoutingError (`e404`) once authorization has passed, as the action's own lookups do.
export async function sellerGuard(
  { context, url, urlOptions }: GuardInput,
  authorization: SellerGuardStep,
  // `beforeAuthorize`: the controller's own before_actions that sit between `authenticate_user!` and the
  // action's `authorize` (`check_payment_details`); one may throw HandBackToRails.
  { requireAccountEmail = true, beforeAuthorize, afterAuthorize }: { requireAccountEmail?: boolean; beforeAuthorize?: SellerGuardStep; afterAuthorize?: SellerGuardStep } = {},
): Promise<Redirected | null> {
  const loggedIn = railsLoggedInUser(context);

  // RequireAccountEmail is included first, so its filter runs ahead of authenticate_user!.
  if (requireAccountEmail && loggedIn && !loggedIn.email && !loggedIn.unconfirmed_email && !context.impersonatedUser) {
    return { status: 302, location: Routes.settings_main_path(), flash: { warning: ACCOUNT_EMAIL_REQUIRED }, rescued: true };
  }
  if (!loggedIn) {
    return { status: 302, location: `/login?next=${cgiEscape(`${url.pathname}${url.search}`)}`, rescued: true };
  }

  const sellerContext = await loadSellerContext(context);
  await beforeAuthorize?.(sellerContext);
  try {
    await authorization(sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    // PunditAuthorization#default_user_not_authorized
    const flash = url.searchParams.get("account_switched") ? undefined : { alert: notAllowedMessage(sellerContext) };
    return { status: 302, location: Routes.dashboard_url(urlOptions), flash, rescued: true };
  }
  await afterAuthorize?.(sellerContext);
  return null;
}

export { authorize, RoutingError };
export type { PolicyQuery };
