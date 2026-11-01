// The signed-in half of the shared props: RenderingExtension#logged_in_user_props and
// #current_seller_props (with UserPresenter#as_current_seller and UserMembershipsPresenter),
// ApplicationHelper#current_user_props and ApplicationController#show_passkey_setup_prompt?.
import type { User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { db } from "../../../lib/db.ts";
import { railsLoggedInUser } from "../../auth/resolve.ts";
import { getConfig } from "../../infra/config.ts";
import { notifyError } from "../../infra/error-reporting.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { isNameInvalidForEmailDelivery, sellerProfile, subdomain, UserFlags, Users, username } from "../../models/user.ts";
import { loadSellerContext, type SellerContext } from "../../policies/seller-context.ts";
import { assetHost, domainConfig } from "../domain.ts";
import type { SignedInPresentersPort } from "../ports.ts";
import {
  blockedPayoutCountry,
  INDIAN_BANK_ACCOUNT_TYPE,
  legalEntityCountryCode,
  legalGuardianRequirementMet,
  legalGuardianUnsupported,
  requiresLegalGuardian,
  noPayoutRailInComplianceCountry,
  observedUtcOffset,
  tzinfoName,
} from "./data.ts";
import { uploadedAvatarUrl } from "./avatar.ts";
import { policiesProps } from "./policy-props.ts";
import {
  activeBankAccount,
  aliveComplianceInfo,
  dashboardNavItems,
  hasAliveProducts,
  hasPayoutAccount,
  type ComplianceInfoRow,
  guardianById,
  hasPayoutSetupRejectionNote,
  isBuyer,
  passkeysSetupPending,
} from "./reads.ts";

const DEFAULT_AVATAR = "gumroad-default-avatar-5.png";
const CARD_BANK_ACCOUNT_TYPE = "CardBankAccount";
const DEFAULT_GUMROAD_ADMIN_ID = 767_082;
const STAGING_GUMROAD_ADMIN_ID = 978;
// DashboardNav::PROMOTABLE_ITEMS
export const PROMOTABLE_NAV_ITEMS = ["agent", "profile", "pages", "collaborators", "checkout", "emails", "workflows", "analytics", "affiliates", "community", "library"];

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// User#form_email
const formEmail = (user: User) => (present(user.unconfirmed_email) ? user.unconfirmed_email : present(user.email) ? user.email : null);

// User#display_name
export function displayName(user: User, { preferEmailOverDefaultUsername = false } = {}): string | null {
  if (present(user.name)) return user.name;
  const handle = username(Users.load(user));
  if (preferEmailOverDefaultUsername && handle === user.external_id) return formEmail(user) ?? (present(handle) ? handle : null);
  return present(handle) ? handle : formEmail(user);
}

// User#avatar_url
export async function avatarUrl(user: User): Promise<string> {
  const uploaded = await uploadedAvatarUrl(user);
  if (uploaded !== null) return uploaded;
  return `${assetHost(domainConfig(process.env)) ?? ""}/images/${DEFAULT_AVATAR}`;
}

// UserMembershipsPresenter#props
async function userMembershipsProps(context: SellerContext): Promise<unknown[]> {
  const { memberships } = context;
  // Every user with access to another seller's account must have an owner membership to switch back.
  if (memberships.length > 0 && !memberships.some((m) => m.role === "owner")) {
    notifyError(new Error(`Missing owner team membership for user ${context.user!.id}`));
    return [];
  }
  const sellers = new Map((await db.user.findMany({ where: { id: { in: memberships.map((m) => m.seller_id) } } })).map((seller) => [seller.id, seller]));
  const props: unknown[] = [];
  for (const membership of memberships) {
    const seller = sellers.get(membership.seller_id)!;
    props.push({
      id: externalId(membership.id),
      seller_name: displayName(seller, { preferEmailOverDefaultUsername: true }),
      seller_avatar_url: await avatarUrl(seller),
      has_some_read_only_access: membership.role !== "owner" && membership.role !== "admin",
      is_selected: membership.seller_id === context.seller?.id,
    });
  }
  return props;
}

// User::CreateBrandAccountService.bank_details_will_be_copied?
async function bankDetailsWillBeCopied(user: User, legalCountry: string | null): Promise<boolean> {
  if (legalCountry === null || blockedPayoutCountry(legalCountry)) return false;
  const bank = await activeBankAccount(user.id);
  return bank !== null && bank.type !== CARD_BANK_ACCOUNT_TYPE && bank.type !== INDIAN_BANK_ACCOUNT_TYPE;
}

async function loggedInUserProps(context: SellerContext): Promise<Record<string, unknown>> {
  const user = context.user!;
  const info = await aliveComplianceInfo(user.id);
  const legalCountry = info === null ? null : legalEntityCountryCode(info);
  const willCopyBank = await bankDetailsWillBeCopied(user, legalCountry);
  const confirmed = user.confirmed_at !== null;
  return {
    id: user.external_id,
    email: user.email,
    name: user.name,
    avatar_url: await avatarUrl(user),
    confirmed,
    team_memberships: await userMembershipsProps(context),
    // Creating a brand account requires a confirmed email; the server enforces it too.
    can_create_brand_account: confirmed && (await isFeatureEnabled("brand_accounts", userActor(user.id))),
    has_payout_setup_to_port: present(user.payment_address) || willCopyBank,
    can_port_bank_payout_setup: !blockedPayoutCountry(legalCountry),
    will_copy_bank_payout: willCopyBank,
    policies: await policiesProps(context, railsEnv() === "development"),
    promoted_nav_items: (await dashboardNavItems(user.id)).filter((item) => PROMOTABLE_NAV_ITEMS.includes(item)),
    lazy_load_offscreen_discover_images: await isFeatureEnabled("lazy_load_offscreen_discover_images", userActor(user.id)),
  };
}

// UserPresenter#publish_blocked_reason_for
async function publishBlockedReason(user: User): Promise<string> {
  const adminId = Number(getConfig("GUMROAD_ADMIN_ID", railsEnv() === "staging" ? String(STAGING_GUMROAD_ADMIN_ID) : String(DEFAULT_GUMROAD_ADMIN_ID)));
  return (await hasPayoutSetupRejectionNote(user.id, adminId)) ? "payout_setup_rejected" : "no_payout_method";
}

// UserComplianceInfo#legal_guardian_requirement_met?, reading the guardian only when one is required.
async function guardianRequirementMet(info: ComplianceInfoRow): Promise<boolean> {
  const guardian = requiresLegalGuardian(info) && info.guardian_id !== null ? await guardianById(info.guardian_id) : null;
  return legalGuardianRequirementMet(info, guardian);
}

// UserPresenter#as_current_seller
async function currentSellerProps(seller: User): Promise<Record<string, unknown>> {
  const record = Users.load(seller);
  const zone = tzinfoName(seller.timezone);
  if (zone === null) throw new TypeError(`undefined method 'tzinfo' for nil (timezone ${JSON.stringify(seller.timezone)})`);
  const info = await aliveComplianceInfo(seller.id);
  const canPublish = UserFlags.isSet(seller.flags, "is_team_member") || (await hasPayoutAccount(seller.id)) || present(seller.payment_address);
  const profile = await sellerProfile(record);
  return {
    id: seller.external_id,
    email: seller.email,
    name: displayName(seller, { preferEmailOverDefaultUsername: true }),
    subdomain: subdomain(record),
    avatar_url: await avatarUrl(seller),
    is_buyer: await isBuyer(seller.id),
    time_zone: { name: zone, offset: observedUtcOffset(zone) },
    has_published_products: await hasAliveProducts(seller.id),
    can_publish_products: canPublish,
    publish_blocked_reason: canPublish ? null : await publishBlockedReason(seller),
    no_payout_rail_in_compliance_country: (await activeBankAccount(seller.id)) === null && noPayoutRailInComplianceCountry(info),
    legal_guardian_requirement_met: info === null || (await guardianRequirementMet(info)),
    legal_guardian_unsupported: info !== null && legalGuardianUnsupported(info),
    is_name_invalid_for_email_delivery: isNameInvalidForEmailDelivery(record),
    profile_background_color: profile.get("background_color"),
    profile_highlight_color: profile.get("highlight_color"),
    profile_font: profile.get("font"),
  };
}

export const signedInPresenters: SignedInPresentersPort = {
  async loggedInUser(requestContext) {
    return loggedInUserProps(await loadSellerContext(requestContext));
  },
  async currentSeller(requestContext) {
    return currentSellerProps(requestContext.currentSeller!);
  },
  async currentUser(requestContext) {
    const user = requestContext.loggedInUser!;
    const impersonated = requestContext.impersonatedUser;
    return {
      name: displayName(user),
      avatar_url: await avatarUrl(user),
      impersonated_user: impersonated ? { name: displayName(impersonated), avatar_url: await avatarUrl(impersonated) } : null,
    };
  },
  async showPasskeySetupPrompt(requestContext, { promptedUserId, mobileAppCookie }) {
    const user = railsLoggedInUser(requestContext);
    if (!user || requestContext.impersonatedUser || present(mobileAppCookie)) return false;
    if (promptedUserId === undefined || promptedUserId === null || String(promptedUserId) !== String(user.id)) return false;
    if (requestContext.currentSeller?.id !== user.id) return false;
    return passkeysSetupPending(user.id);
  },
  async thirdPartyAnalyticsDisabled(seller) {
    return UserFlags.isSet(seller.flags, "disable_third_party_analytics");
  },
};
