// The Settings::* pages (Settings::BaseController and its show/index actions). Registered in
// ../pages.ts. The form submissions stay in Rails.
import type { GuardInput } from "../guards.ts";
import { loadSellerContext, type SellerContext } from "../../policies/seller-context.ts";
import { settingsAdvancedUserPolicy } from "../../policies/settings/advanced-user.ts";
import { settingsAuthorizedApplicationsOauthApplicationPolicy } from "../../policies/settings/authorized-applications-oauth-application.ts";
import { settingsBillingPolicy } from "../../policies/settings/billing.ts";
import { settingsPaymentsUserPolicy } from "../../policies/settings/payments-user.ts";
import { settingsMainUserPolicy } from "../../policies/settings/main-user.ts";
import { settingsProfilePolicy } from "../../policies/settings/profile.ts";
import { settingsPasswordUserPolicy } from "../../policies/settings/password-user.ts";
import { settingsTeamUserPolicy } from "../../policies/settings/team-user.ts";
import { settingsThirdPartyAnalyticsUserPolicy } from "../../policies/settings/third-party-analytics-user.ts";
import { SOCIAL_CONNECTIONS_OPTIONS, socialConnectionsGuard } from "../../controllers/settings-pages.ts";
import type { ActionContext } from "../load-page.ts";
import { NotPortedError } from "../not-ported.ts";
import type { PageSpec } from "../pages.ts";
import { settingsGuard } from "./guard.ts";
import { paymentsProps } from "./payments.ts";
import { profileProps } from "./profile.ts";
import {
  advancedProps,
  applicationProps,
  findOwnedApplication,
  authorizedApplicationsProps,
  billingProps,
  mainProps,
  passwordProps,
  settingsPages,
  socialConnectionsProps,
  teamMemberInfos,
  thirdPartyAnalyticsPageProps,
} from "./presenter.ts";
import { settingsTeamInvitationPolicy } from "../../policies/settings/team-invitation.ts";

const NO_EMAIL_ALERT = "Your Gumroad account doesn't have an email associated. Please assign and verify your email, and try again.";

// Settings::BaseController: the title, and the `settings_pages` inertia_share every page carries.
async function settingsPage(action: ActionContext, build: (context: SellerContext) => Promise<Record<string, unknown>>, title = "Settings") {
  action.meta.set({ title });
  const context = await loadSellerContext(action.context);
  return { settings_pages: await settingsPages(context), ...(await build(context)) };
}

const page = (component: string, spec: Pick<PageSpec, "guard" | "props" | "options">): PageSpec => ({ component, mobileAppWebView: true, ...spec });

export const SETTINGS_PAGES: Record<string, PageSpec> = {
  "/settings": page("Settings/Main/Show", {
    guard: settingsGuard({ authorize: settingsMainUserPolicy.show, refusedToProfile: true, skipRequireAccountEmail: true }),
    props: (_, action) => settingsPage(action, (context) => mainProps(context)),
  }),
  "/settings/team": page("Settings/Team/Show", {
    guard: settingsGuard({
      authorize: settingsTeamUserPolicy.show,
      // check_email_presence
      afterAuthorize: (context) => (context.seller?.email ? null : { status: 302, location: "/settings", rescued: true, flash: { alert: NO_EMAIL_ALERT } }),
    }),
    props: (_, action) =>
      settingsPage(
        action,
        async (context) => ({ member_infos: await teamMemberInfos(context), can_invite_member: settingsTeamInvitationPolicy.create(context) }),
        "Team",
      ),
  }),
  "/settings/password": page("Settings/Password/Show", {
    guard: settingsGuard({ authorize: settingsPasswordUserPolicy.show }),
    props: (_, action) => settingsPage(action, passwordProps),
  }),
  "/settings/social_connections": page("Settings/SocialConnections/Show", {
    guard: socialConnectionsGuard,
    // prepare_social_connect_return keeps the destination of a connect flow in the session.
    options: SOCIAL_CONNECTIONS_OPTIONS,
    props: (_, action) =>
      settingsPage(
        action,
        async (context) => ({ ...(await socialConnectionsProps(context)), social_connect_return: action.state.social_connect_return ?? null }),
        "Social connections",
      ),
  }),
  "/settings/third_party_analytics": page("Settings/ThirdPartyAnalytics/Show", {
    guard: settingsGuard({ authorize: settingsThirdPartyAnalyticsUserPolicy.show }),
    props: (_, action) => settingsPage(action, thirdPartyAnalyticsPageProps),
  }),
  "/settings/advanced": page("Settings/Advanced/Show", {
    guard: settingsGuard({ authorize: settingsAdvancedUserPolicy.show }),
    props: (_, action) => settingsPage(action, advancedProps),
  }),
  "/settings/billing": page("Settings/Billing/Show", {
    guard: settingsGuard({ authorize: settingsBillingPolicy.show }),
    props: (_, action) => settingsPage(action, billingProps),
  }),
  "/settings/payments": page("Settings/Payments/Show", {
    guard: settingsGuard({ authorize: (context) => settingsPaymentsUserPolicy.show(context) }),
    props: (_, action) => settingsPage(action, (context) => paymentsProps(context, { impersonating: action.context.impersonatedUser !== null })),
  }),
  "/profile": page("Settings/Profile/Show", {
    guard: settingsGuard({ authorize: settingsProfilePolicy.show }),
    props: (_, action) => settingsPage(action, profileProps, "Profile settings"),
  }),
  "/settings/authorized_applications": page("Settings/AuthorizedApplications/Index", {
    guard: settingsGuard({ authorize: settingsAuthorizedApplicationsOauthApplicationPolicy.index }),
    props: (_, action) => settingsPage(action, (context) => authorizedApplicationsProps(context)),
  }),
};

// Oauth::ApplicationsController#edit (a Doorkeeper controller, not a Settings::BaseController): the
// application is looked up among the seller's own before the `authorize` in the action.
const APPLICATION_NOT_FOUND_ALERT = "Application not found or you don't have the permissions to modify it.";
const editApplicationGuard = settingsGuard({ authorize: settingsAuthorizedApplicationsOauthApplicationPolicy.edit, skipRequireAccountEmail: true });

export const OAUTH_APPLICATION_PAGES: Record<string, PageSpec> = {
  "/oauth/applications/:id/edit": {
    component: "Oauth/Applications/Edit",
    guard: async (input: GuardInput) => {
      const context = await loadSellerContext(input.context);
      if (!context.user) throw new NotPortedError("authenticate_user! for a signed-out visitor");
      if (!(await findOwnedApplication(context.seller!, input.params.id ?? ""))) {
        const { protocol, host } = input.urlOptions;
        return { status: 302, location: `${protocol}://${host}/oauth/applications`, rescued: true, flash: { alert: APPLICATION_NOT_FOUND_ALERT } };
      }
      return editApplicationGuard(input);
    },
    props: async ({ id }, action) => {
      action.meta.set({ title: "Update application" });
      const context = await loadSellerContext(action.context);
      return applicationProps(context, (await findOwnedApplication(context.seller!, id!))!);
    },
  },
};
