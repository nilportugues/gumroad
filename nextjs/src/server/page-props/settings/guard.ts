// The before_actions every Settings page runs ahead of its action: Sellers::BaseController's
// require_account_email and authenticate_user!, the controller's `authorize`, and the
// PunditAuthorization#user_not_authorized handler for a refusal.
import * as Routes from "@/lib/navigation/routes";

import type { Redirected } from "../../controllers/application-controller.ts";
import { notifyError } from "../../infra/error-reporting.ts";
import { findUserMembershipForSeller, loadSellerContext, MembershipNotFoundError, roleOwnerFor, requireUser, type SellerContext } from "../../policies/seller-context.ts";
import type { GuardInput, PageGuard } from "../guards.ts";
import { NotPortedError } from "../not-ported.ts";

const GENERIC_NOT_ALLOWED = "You are not allowed to perform this action.";
const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";

const blank = (value: string | null | undefined) => value == null || value.trim() === "";
const humanize = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

// PunditAuthorization#build_error_message
function notAllowedMessage(context: SellerContext): string {
  const c = requireUser(context);
  if (roleOwnerFor(c)) return GENERIC_NOT_ALLOWED;
  try {
    return `Your current role as ${humanize(findUserMembershipForSeller(c, c.seller!).role)} cannot perform this action.`;
  } catch (error) {
    if (!(error instanceof MembershipNotFoundError)) throw error;
    notifyError(new Error(`Team: Could not find membership for user ${c.user.id} and seller ${c.seller?.id}`));
    return GENERIC_NOT_ALLOWED;
  }
}

export type SettingsGuardOptions = {
  // The `authorize` before_action: whether the policy query allows the visitor.
  authorize: (context: SellerContext) => boolean | Promise<boolean>;
  // Settings::Main::UserPolicy#show? sends those it refuses to the profile instead of the dashboard.
  refusedToProfile?: boolean;
  // Settings::MainController is the one page that does not need an account email.
  skipRequireAccountEmail?: boolean;
  // The controller's own before_actions after `authorize`.
  afterAuthorize?: (context: SellerContext, input: GuardInput) => Redirected | null;
};

export function settingsGuard(options: SettingsGuardOptions): PageGuard {
  return async (input) => {
    const context = await loadSellerContext(input.context);
    if (!context.user) throw new NotPortedError("authenticate_user! for a signed-out visitor");

    const { user } = context;
    if (!options.skipRequireAccountEmail && blank(user.email) && blank(user.unconfirmed_email) && input.context.impersonatedUser === null) {
      return { status: 302, location: "/settings", rescued: true, flash: { warning: ADD_EMAIL_MESSAGE } };
    }

    if (!(await options.authorize(context))) {
      if (options.refusedToProfile) return { status: 302, location: "/profile", rescued: true };
      // `params["account_switched"]` is truthy for any value, an empty one included.
      const flash = input.url.searchParams.has("account_switched") ? undefined : { alert: notAllowedMessage(context) };
      return { status: 302, location: Routes.dashboard_url(input.urlOptions), rescued: true, ...(flash && { flash }) };
    }

    return options.afterAuthorize?.(context, input) ?? null;
  };
}
