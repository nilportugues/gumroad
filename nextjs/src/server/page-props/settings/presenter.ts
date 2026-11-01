// SettingsPresenter (app/presenters/settings_presenter.rb) and Settings::TeamPresenter: the props of
// the settings pages. The payments page is not ported (see ./pages.ts).
import type { OauthApplication, TeamInvitation, TeamMembership, User } from "@prisma/client";

import { encrypt as externalId, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { db } from "../../../lib/db.ts";
import { getConfig } from "../../infra/config.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { LinkFlags } from "../../models/link.ts";
import { formEmail, jsonDataForAttr, unpaidBalanceCents, UserFlags, Users } from "../../models/user.ts";
import { settingsAdvancedUserPolicy } from "../../policies/settings/advanced-user.ts";
import { settingsAuthorizedApplicationsOauthApplicationPolicy } from "../../policies/settings/authorized-applications-oauth-application.ts";
import { settingsBillingPolicy } from "../../policies/settings/billing.ts";
import { settingsMainUserPolicy } from "../../policies/settings/main-user.ts";
import { settingsPasswordUserPolicy } from "../../policies/settings/password-user.ts";
import { settingsPaymentsUserPolicy } from "../../policies/settings/payments-user.ts";
import { settingsSocialConnectionsPolicy } from "../../policies/settings/social-connections.ts";
import { settingsTeamInvitationPolicy } from "../../policies/settings/team-invitation.ts";
import { settingsTeamMembershipPolicy } from "../../policies/settings/team-membership.ts";
import { settingsTeamUserPolicy } from "../../policies/settings/team-user.ts";
import { settingsThirdPartyAnalyticsUserPolicy } from "../../policies/settings/third-party-analytics-user.ts";
import { userPolicy } from "../../policies/user.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { assetHost, domainConfig } from "../domain.ts";
import { NotPortedError } from "../not-ported.ts";
import { aliveComplianceInfo } from "../signed-in/reads.ts";
import { avatarUrl, displayName } from "../signed-in/presenters.ts";
import DATA from "./settings-data.generated.json" with { type: "json" };

const DEFAULT_IOS_APP_ID = "916819108";
const DEFAULT_ANDROID_BUNDLE_ID = "com.gumroad.app";
// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS
const ALLOWED_REFUND_PERIODS_IN_DAYS: Record<number, string> = {
  0: "No refunds allowed",
  7: "7-day money back guarantee",
  14: "14-day money back guarantee",
  30: "30-day money back guarantee",
  183: "6-month money back guarantee",
};
const NO_REFUNDS_PERIOD = 0;
// User::LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY, Time.new(2025, 3, 31).end_of_day (UTC)
const LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY = Date.UTC(2025, 2, 31, 23, 59, 59, 999);
// PingDelivery::MAX_RECENT
const MAX_RECENT_PING_DELIVERIES = 10;
const TEAM_ROLES_WITHOUT_OWNER = ["accountant", "admin", "marketing", "support"] as const;
const DEFAULT_AVATAR = "gumroad-default-avatar-5.png";
const TYPE_OWNER = "owner";
const TYPE_MEMBERSHIP = "membership";
const TYPE_INVITATION = "invitation";

type Pages = string[];
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
// Time#iso8601
const iso8601 = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// OauthApplication#icon_url goes through Active Storage and the CDN rewrite.
async function iconUrl(application: OauthApplication): Promise<string | null> {
  const attached = await db.activeStorageAttachment.findFirst({ where: { record_type: "OauthApplication", record_id: application.id, name: "file" }, select: { id: true } });
  if (attached) throw new NotPortedError("OauthApplication#icon_url for an uploaded icon");
  return null;
}

// OauthApplication.alive.authorized_for(seller): applications holding a not revoked token of the seller.
async function authorizedApplications(seller: User): Promise<OauthApplication[]> {
  const tokens = await db.oauthAccessToken.findMany({ where: { resource_owner_id: Number(seller.id), revoked_at: null }, select: { application_id: true }, distinct: ["application_id"] });
  if (tokens.length === 0) return [];
  return db.oauthApplication.findMany({ where: { deleted_at: null, id: { in: tokens.map((token) => token.application_id) } }, orderBy: { id: "asc" } });
}

// SettingsPresenter#pages
export async function settingsPages(context: SellerContext): Promise<Pages> {
  const seller = context.seller!;
  const checks: [string, () => boolean | Promise<boolean>][] = [
    ["main", () => settingsMainUserPolicy.show(context)],
    ["team", () => settingsTeamUserPolicy.show(context)],
    ["payments", () => settingsPaymentsUserPolicy.show(context, seller)],
    ["billing", () => settingsBillingPolicy.show(context)],
    ["authorized_applications", async () => settingsAuthorizedApplicationsOauthApplicationPolicy.index(context) && (await authorizedApplications(seller)).length > 0],
    ["password", () => settingsPasswordUserPolicy.show(context)],
    ["social_connections", () => settingsSocialConnectionsPolicy.show(context)],
    ["third_party_analytics", () => settingsThirdPartyAnalyticsUserPolicy.show(context)],
    ["advanced", () => settingsAdvancedUserPolicy.show(context)],
  ];
  const pages: Pages = [];
  for (const [page, allowed] of checks) if (await allowed()) pages.push(page);
  return pages;
}

// Feature.active?(:name, seller)
const featureActive = (name: string, seller: User) => isFeatureEnabled(name, userActor(seller.id));

// User#refund_policy_settings_editable?
async function refundPolicySettingsEditable(seller: User, now: Date): Promise<boolean> {
  if (UserFlags.isSet(seller.flags, "refund_policy_enforced")) return false;
  if (await isFeatureEnabled("seller_refund_policy_disabled_for_all")) return false;
  const delayed = (await featureActive("account_level_refund_policy_delayed_for_sellers", seller)) && now.getTime() <= LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY;
  if (delayed) return false;
  return UserFlags.isSet(seller.flags, "refund_policy_enabled");
}

// SettingsPresenter#seller_refund_policy
async function sellerRefundPolicy(seller: User, now: Date) {
  const enforced = UserFlags.isSet(seller.flags, "refund_policy_enforced");
  const periods = Object.keys(ALLOWED_REFUND_PERIODS_IN_DAYS).map(Number).filter((period) => !(enforced && period === NO_REFUNDS_PERIOD));
  const policy = await db.refundPolicy.findFirst({ where: { seller_id: seller.id, product_id: null }, orderBy: { id: "asc" } });
  if (!policy) throw new TypeError("undefined method 'max_refund_period_in_days' for nil");
  return {
    editable: await refundPolicySettingsEditable(seller, now),
    refund_policy_enforced: enforced,
    allowed_refund_periods_in_days: periods.map((key) => ({ key, value: ALLOWED_REFUND_PERIODS_IN_DAYS[key] })),
    max_refund_period_in_days: policy.max_refund_period_in_days,
    fine_print: policy.fine_print,
    fine_print_enabled: present(policy.fine_print),
  };
}

// User#product_level_support_emails
async function productLevelSupportEmails(seller: User) {
  const links = await db.link.findMany({ where: { user_id: seller.id, support_email: { not: null } }, select: { id: true, support_email: true }, orderBy: { id: "asc" } });
  const grouped = new Map<string, string[]>();
  for (const link of links) {
    const ids = grouped.get(link.support_email!) ?? [];
    ids.push(externalId(link.id));
    grouped.set(link.support_email!, ids);
  }
  return [...grouped].map(([email, product_ids]) => ({ email, product_ids }));
}

export async function mainProps(context: SellerContext, now = new Date()) {
  const seller = context.seller!;
  const [pages, products, complianceInfo, announcements] = [
    await settingsPages(context),
    await db.link.findMany({ where: { user_id: seller.id, deleted_at: null }, select: { id: true, name: true, flags: true }, orderBy: { id: "asc" } }),
    await aliveComplianceInfo(seller.id),
    await db.featureAnnouncementSubscription.findFirst({ where: { user_id: seller.id } }),
  ];
  const flag = (name: Parameters<typeof UserFlags.isSet>[1]) => UserFlags.isSet(seller.flags, name);
  const form = formEmail(Users.load(seller));
  return {
    settings_pages: pages,
    is_form_disabled: !settingsMainUserPolicy.update(context),
    invalidate_active_sessions: settingsMainUserPolicy.invalidateActiveSessions(context),
    ios_app_store_url: `https://itunes.apple.com/app/id${getConfig("IOS_APP_ID", DEFAULT_IOS_APP_ID)}`,
    android_app_store_url: `https://play.google.com/store/apps/details?id=${getConfig("ANDROID_BUNDLE_ID", DEFAULT_ANDROID_BUNDLE_ID)}`,
    timezones: DATA.timezones,
    currencies: DATA.currencies,
    user: {
      email: form,
      username: seller.username ?? "",
      support_email: seller.support_email,
      locale: seller.locale,
      timezone: seller.timezone,
      currency_type: seller.currency_type,
      has_unconfirmed_email: present(seller.unconfirmed_email) || seller.confirmed_at === null,
      compliance_country: complianceInfo?.country ?? null,
      purchasing_power_parity_enabled: flag("purchasing_power_parity_enabled"),
      purchasing_power_parity_limit: seller.purchasing_power_parity_limit,
      purchasing_power_parity_payment_verification_disabled: flag("purchasing_power_parity_payment_verification_disabled"),
      products: products.map((product) => ({ id: externalId(product.id), name: product.name })),
      purchasing_power_parity_excluded_product_ids: products.filter((product) => LinkFlags.isSet(product.flags, "purchasing_power_parity_disabled")).map((product) => externalId(product.id)),
      enable_payment_email: flag("enable_payment_email"),
      enable_payment_push_notification: flag("enable_payment_push_notification"),
      enable_recurring_subscription_charge_email: flag("enable_recurring_subscription_charge_email"),
      enable_recurring_subscription_charge_push_notification: flag("enable_recurring_subscription_charge_push_notification"),
      enable_free_downloads_email: flag("enable_free_downloads_email"),
      enable_free_downloads_push_notification: flag("enable_free_downloads_push_notification"),
      announcement_notification_enabled: flag("announcement_notification_enabled"),
      feature_announcements: { subscribed: announcements?.subscribed ?? false, version: announcements?.version ?? 0 },
      disable_comments_email: flag("disable_comments_email"),
      disable_reviews_email: flag("disable_reviews_email"),
      disable_review_reminders: flag("disable_review_reminders"),
      show_nsfw_products: flag("show_nsfw_products"),
      disable_affiliate_requests: flag("disable_affiliate_requests"),
      seller_refund_policy: await sellerRefundPolicy(seller, now),
      product_level_support_emails: await productLevelSupportEmails(seller),
    },
  };
}

export async function passwordProps(context: SellerContext) {
  const seller = context.seller!;
  const credentials = await db.webauthnCredential.findMany({ where: { user_id: seller.id }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
  const totp = await db.totpCredential.findFirst({ where: { user_id: seller.id } });
  return {
    require_old_password: !present(seller.provider),
    settings_pages: await settingsPages(context),
    authenticator_app_enabled: totp?.confirmed_at != null,
    passkeys: credentials.map((credential) => ({
      id: externalId(credential.id),
      nickname: credential.nickname,
      created_at: iso8601(credential.created_at),
      last_used_at: credential.last_used_at ? iso8601(credential.last_used_at) : null,
    })),
  };
}

export async function socialConnectionsProps(context: SellerContext) {
  const seller = context.seller!;
  const [awaitingReconnect, youtube, instagram, tiktok] = [
    await db.marketingAction.findFirst({ where: { user_id: seller.id, error_code: "x_write_permission_missing", status: { notIn: ["posted", "failed", "cancelled"] } }, select: { id: true } }),
    await db.userYoutubeIdentity.findFirst({ where: { user_id: seller.id } }),
    await db.userInstagramIdentity.findFirst({ where: { user_id: seller.id } }),
    await db.userTiktokIdentity.findFirst({ where: { user_id: seller.id } }),
  ];
  return {
    twitter_connected: present(seller.twitter_user_id),
    twitter_handle: seller.twitter_handle,
    twitter_write_permission_missing: awaitingReconnect !== null,
    youtube_connect_enabled: await featureActive("youtube_connect", seller),
    youtube_connected: youtube !== null,
    youtube_handle: youtube?.handle ?? null,
    instagram_connect_enabled: await featureActive("instagram_connect", seller),
    instagram_connected: instagram !== null,
    instagram_handle: instagram?.handle ?? null,
    tiktok_connect_enabled: await featureActive("tiktok_connect", seller),
    tiktok_connected: tiktok !== null,
    tiktok_handle: tiktok?.handle ?? null,
  };
}

// Settings::ThirdPartyAnalyticsController#show
export async function thirdPartyAnalyticsPageProps(context: SellerContext) {
  const seller = context.seller!;
  const record = Users.load(seller);
  const snippets = await db.thirdPartyAnalytic.findMany({ where: { user_id: Number(seller.id), deleted_at: null }, orderBy: { id: "asc" } });
  const linkIds = snippets.flatMap((snippet) => (snippet.link_id === null ? [] : [BigInt(snippet.link_id)]));
  const permalinks = new Map((await db.link.findMany({ where: { id: { in: linkIds } }, select: { id: true, unique_permalink: true } })).map((link) => [link.id, link.unique_permalink]));
  const products = await db.link.findMany({ where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null }, select: { unique_permalink: true, name: true }, orderBy: { id: "asc" } });
  const flag = (name: Parameters<typeof UserFlags.isSet>[1]) => UserFlags.isSet(seller.flags, name);
  return {
    third_party_analytics: {
      disable_third_party_analytics: flag("disable_third_party_analytics"),
      google_analytics_id: seller.google_analytics_id || "",
      facebook_pixel_id: seller.facebook_pixel_id || "",
      tiktok_pixel_id: (jsonDataForAttr(record, "tiktok_pixel_id") as string | null) || "",
      skip_free_sale_analytics: flag("skip_free_sale_analytics"),
      facebook_meta_tag: seller.facebook_meta_tag || "",
      enable_verify_domain_third_party_services: flag("enable_verify_domain_third_party_services"),
      snippets: snippets.map((snippet) => ({
        id: externalId(snippet.id),
        product: snippet.link_id === null ? null : (permalinks.get(BigInt(snippet.link_id)) ?? null),
        name: snippet.name || "",
        location: snippet.location,
        code: snippet.analytics_code,
      })),
    },
    products: products.map((product) => ({ permalink: product.unique_permalink, name: product.name })),
  };
}

// PingDelivery#as_props
async function recentPingDeliveries(seller: User) {
  const rows = await db.pingDelivery.findMany({ where: { user_id: seller.id }, orderBy: [{ created_at: "desc" }, { id: "desc" }], take: MAX_RECENT_PING_DELIVERIES });
  const purchases = new Map<bigint, bigint>();
  for (const row of rows) if (row.purchase_id !== null) purchases.set(row.purchase_id, row.purchase_id);
  const purchaseIds = await db.purchase.findMany({ where: { id: { in: [...purchases.keys()] } }, select: { id: true } });
  const existing = new Set(purchaseIds.map((purchase) => purchase.id));
  return rows.map((row) => ({
    id: Number(row.id),
    resource_name: row.resource_name,
    sale_id: row.purchase_id !== null && existing.has(row.purchase_id) ? String(encryptNumeric(Number(row.purchase_id))) : null,
    subscription_id: row.subscription_id === null ? null : Number(row.subscription_id),
    post_url: row.post_url,
    attempt: row.attempt,
    outcome: row.response_code != null ? `HTTP ${row.response_code}` : present(row.error_class) ? row.error_class : "No response",
    succeeded: row.succeeded,
    created_at: row.created_at.toISOString(),
  }));
}

export async function advancedProps(context: SellerContext) {
  const seller = context.seller!;
  const customDomain = await db.customDomain.findFirst({ where: { user_id: Number(seller.id), deleted_at: null }, orderBy: { id: "asc" } });
  if (customDomain?.state === "unverified") throw new NotPortedError("CustomDomainVerificationService (DNS lookups for an unverified custom domain)");
  const blocked = await db.blockedCustomerObject.findMany({ where: { seller_id: seller.id, object_type: "email", blocked_at: { not: null } }, select: { object_value: true }, orderBy: { id: "asc" } });
  const applications = await db.oauthApplication.findMany({ where: { owner_id: Number(seller.id), owner_type: "User", deleted_at: null }, orderBy: { id: "asc" } });
  const balance = await unpaidBalanceCents(Users.load(seller), db);
  return {
    settings_pages: await settingsPages(context),
    user_id: externalId(seller.id),
    notification_endpoint: seller.notification_endpoint || "",
    blocked_customer_emails: blocked.map((object) => object.object_value).join("\n"),
    custom_domain_verification_status: null,
    custom_domain_name: customDomain?.domain || "",
    applications: await Promise.all(applications.map(async (application) => ({ id: externalId(application.id), name: application.name, icon_url: await iconUrl(application) }))),
    allow_deactivation: userPolicy.deactivate(context),
    formatted_balance_to_forfeit_on_account_deletion: balance > 0n ? formattedDollarAmount(balance) : null,
    recent_ping_deliveries: await recentPingDeliveries(seller),
  };
}

export async function billingProps(context: SellerContext) {
  const seller = context.seller!;
  const detail = await db.billingDetail.findFirst({ where: { purchaser_id: seller.id }, orderBy: { id: "asc" } });
  return {
    settings_pages: await settingsPages(context),
    billing_detail: {
      full_name: detail?.full_name || seller.name || "",
      business_name: detail?.business_name || "",
      business_id: detail?.business_id || "",
      street_address: detail?.street_address || "",
      city: detail?.city || "",
      state: detail?.state || "",
      zip_code: detail?.zip_code || "",
      country_code: detail?.country_code || "",
      additional_notes: detail?.additional_notes || "",
      auto_email_invoice_enabled: detail === null || detail.auto_email_invoice_enabled,
    },
    countries: Object.fromEntries(DATA.countries as [string, string][]),
    business_id_country_codes: DATA.businessIdCountryCodes,
    business_id_labels: DATA.businessIdLabels,
  };
}

export async function authorizedApplicationsProps(context: SellerContext, now = new Date()) {
  const seller = context.seller!;
  const applications = await authorizedApplications(seller);
  const grants = new Map<number, { created_at: Date; scopes: string }>();
  for (const application of applications) {
    const grant = await db.oauthAccessGrant.findFirst({ where: { application_id: application.id, resource_owner_id: Number(seller.id) }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
    if (grant) grants.set(application.id, grant);
  }
  const valid = applications.filter((application) => grants.has(application.id)).sort((a, b) => grants.get(a.id)!.created_at.getTime() - grants.get(b.id)!.created_at.getTime());
  const liveScopes = await liveScopesByApplication(seller, valid.map((application) => application.id), now);
  return {
    settings_pages: await settingsPages(context),
    authorized_applications: await Promise.all(
      valid.map(async (application) => ({
        name: application.name,
        icon_url: await iconUrl(application),
        is_own_app: application.owner_id !== null && BigInt(application.owner_id) === seller.id,
        first_authorized_at: iso8601(grants.get(application.id)!.created_at),
        scopes: liveScopes.get(application.id) ?? grants.get(application.id)!.scopes.split(/\s+/).filter(Boolean),
        id: externalId(application.id),
      })),
    ),
  };
}

// SettingsPresenter#live_scopes_by_application: the union of the scopes of the seller's unexpired tokens.
async function liveScopesByApplication(seller: User, applicationIds: number[], now: Date): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (applicationIds.length === 0) return result;
  const tokens = await db.oauthAccessToken.findMany({ where: { resource_owner_id: Number(seller.id), revoked_at: null, application_id: { in: applicationIds } }, orderBy: { id: "asc" } });
  for (const token of tokens) {
    if (token.expires_in !== null && token.created_at.getTime() + token.expires_in * 1000 <= now.getTime()) continue;
    const scopes = result.get(token.application_id) ?? [];
    for (const scope of (token.scopes ?? "").split(/\s+/).filter(Boolean)) if (!scopes.includes(scope)) scopes.push(scope);
    if (scopes.length > 0) result.set(token.application_id, scopes);
  }
  return result;
}

const roleOptions = (roles: readonly string[], current: string, canChange: boolean) =>
  roles.filter((role) => role === current || canChange).map((role) => ({ id: role, label: capitalize(role) }));

// Settings::TeamPresenter#member_infos
export async function teamMemberInfos(context: SellerContext, now = new Date()) {
  const seller = context.seller!;
  const defaultAvatar = `${assetHost(domainConfig(process.env)) ?? ""}/images/${DEFAULT_AVATAR}`;
  const memberships = (await db.teamMembership.findMany({ where: { seller_id: seller.id, deleted_at: null }, orderBy: [{ created_at: "desc" }, { id: "desc" }] })).filter((membership) => membership.role !== "owner");
  const invitations = await db.teamInvitation.findMany({ where: { seller_id: seller.id, deleted_at: null }, orderBy: [{ created_at: "desc" }, { id: "desc" }] });
  const members = new Map((await db.user.findMany({ where: { id: { in: memberships.map((membership) => membership.user_id) } } })).map((member) => [member.id, member]));

  const infos: Record<string, unknown>[] = [
    {
      type: TYPE_OWNER,
      id: seller.external_id,
      role: "owner",
      name: displayName(seller),
      email: formEmail(Users.load(seller)),
      avatar_url: await avatarUrl(seller),
      is_expired: false,
      options: [{ id: "owner", label: "Owner" }],
      leave_team_option: null,
    },
  ];
  for (const membership of memberships) infos.push(await membershipInfo(context, membership, members.get(membership.user_id)!));
  for (const invitation of invitations) infos.push(invitationInfo(context, invitation, defaultAvatar, now));
  return infos;
}

async function membershipInfo(context: SellerContext, membership: TeamMembership, member: User) {
  const canChangeRole = settingsTeamMembershipPolicy.update(context);
  const roles = ["accountant", "admin", "marketing", "support"];
  const isSelf = member.id === context.user!.id;
  const options: { id: string; label: string }[] = roleOptions(roles, membership.role, canChangeRole);
  // build_remove_from_team_option: a member sees "leave team" instead of "remove from team".
  if (!isSelf && settingsTeamMembershipPolicy.destroy(context, membership)) options.push({ id: "remove_from_team", label: "Remove from team" });
  return {
    type: TYPE_MEMBERSHIP,
    id: externalId(membership.id),
    role: membership.role,
    name: displayName(member),
    email: formEmail(Users.load(member)),
    avatar_url: await avatarUrl(member),
    is_expired: false,
    options,
    leave_team_option: isSelf && settingsTeamMembershipPolicy.destroy(context, membership) ? { id: "leave_team", label: "Leave team" } : null,
  };
}

function invitationInfo(context: SellerContext, invitation: TeamInvitation, defaultAvatar: string, now: Date) {
  const options: { id: string; label: string }[] = roleOptions(TEAM_ROLES_WITHOUT_OWNER, invitation.role, settingsTeamInvitationPolicy.update(context));
  if (settingsTeamInvitationPolicy.resendInvitation(context)) options.push({ id: "resend_invitation", label: "Resend invitation" });
  if (settingsTeamInvitationPolicy.destroy(context)) options.push({ id: "remove_from_team", label: "Remove from team" });
  return {
    type: TYPE_INVITATION,
    id: externalId(invitation.id),
    role: invitation.role,
    name: "",
    email: invitation.email,
    avatar_url: defaultAvatar,
    is_expired: invitation.expires_at.getTime() < now.getTime(),
    options,
    leave_team_option: null,
  };
}
