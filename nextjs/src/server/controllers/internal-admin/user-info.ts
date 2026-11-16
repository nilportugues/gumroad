// Api::Internal::Admin::UsersController#info: the support lookup of one user by email, user_id or username, with their risk state, payout
// state, sales totals, sign-in and social data and Stripe verification.
//
// Left to Rails: a seller with an unpaid balance above the minimum who is on a daily payout schedule (Payouts.is_user_payable asks Stripe).
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { domainConfig } from "../../infra/domain.ts";
import { moneyFormatWithGemSymbol } from "../../models/concerns/money-formatter.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { unpaidBalanceCents } from "../../models/user-balance-stats.ts";
import { aliveUserComplianceInfoRow } from "../../models/user-compliance-info.ts";
import {
  formEmail,
  isFlagSet,
  NotPortedError,
  payoutsPausedBy,
  subdomainWithProtocol,
  Users,
} from "../../models/user.ts";
import { isoDate } from "../../page-props/payouts/payout-schedule.ts";
import { nextPayoutForAdmin } from "../../page-props/payouts/payouts.ts";
import { recentPingDeliveries } from "../../page-props/settings/presenter.ts";
import { salesCentsTotal } from "../../search/purchase-sales.ts";
import { StripeError } from "../../stripe/errors.ts";
import { Account } from "../../stripe/resources.ts";

import { jsonRendered } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";
import { activeWatch, serializeWatchedUser } from "./user-watch.ts";
import { findUserForRead, successPayload } from "./users.ts";

const RISK_STATE_COMMENT_TYPES = ["compliant", "not_reviewed", "on", "flagged", "suspended"];
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
const FLAGGED_STATES = ["flagged_for_tos_violation", "flagged_for_fraud"];
// User::PAYOUT_PAUSE_SOURCE_*
const PAUSE_SOURCE_ADMIN = "admin";
const PAUSE_SOURCE_STRIPE = "stripe";
const PAUSE_SOURCE_SYSTEM = "system";
const PAUSE_SOURCE_USER = "user";
// User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS.values
const SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS = [
  "pause_payouts_after_repeated_failures",
  "pause_payouts_for_seller_based_on_chargeback_rate",
  "pause_payouts_for_seller_based_on_recent_failures",
];
const STRIPE_DASHBOARD = "https://dashboard.stripe.com/connect/accounts";

// ActiveSupport::TimeWithZone#as_json: ISO 8601 with milliseconds.
const asJson = (time: Date | null): string | null => (time === null ? null : time.toISOString());
// Money#format puts the minus sign inside the symbol in a way Node does not model.
function money(cents: number): string {
  if (cents < 0)
    throw new NotPortedError(
      "a negative amount in Money#format",
      "app/controllers/api/internal/admin/users_controller.rb",
    );
  return moneyFormatWithGemSymbol(cents, "usd");
}
const presence = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value);

type UserRow = NonNullable<Awaited<ReturnType<typeof db.user.findFirst>>>;

// Admin::UserRiskStatePresenter#props
export function riskStateProps(userRiskState: string | null, lastStatusChangedAt: Date | null) {
  const suspended = userRiskState !== null && SUSPENDED_STATES.includes(userRiskState);
  const flagged = userRiskState !== null && FLAGGED_STATES.includes(userRiskState);
  return {
    status: suspended ? "Suspended" : flagged ? "Flagged" : "Compliant",
    user_risk_state: userRiskState,
    suspended,
    flagged_for_fraud: userRiskState === "flagged_for_fraud",
    flagged_for_tos_violation: userRiskState === "flagged_for_tos_violation",
    on_probation: userRiskState === "on_probation",
    compliant: userRiskState === "compliant",
    last_status_changed_at: asJson(lastStatusChangedAt),
  };
}

const commentsOf = (userId: bigint) => ({ commentable_type: "User", commentable_id: userId });

// User#payouts_paused_by_source and #payouts_paused_for_reason
async function pauseState(user: UserRow) {
  const record = Users.load(user);
  const internally = isFlagSet(record, "payouts_paused_internally");
  const byUser = isFlagSet(record, "payouts_paused_by_user");
  const paused = internally || byUser;
  const pausedBy = payoutsPausedBy(record);
  const source = !paused
    ? null
    : internally
      ? pausedBy === PAUSE_SOURCE_STRIPE || pausedBy === PAUSE_SOURCE_SYSTEM
        ? pausedBy
        : PAUSE_SOURCE_ADMIN
      : PAUSE_SOURCE_USER;
  let reason: string | null = null;
  if (source === PAUSE_SOURCE_ADMIN || source === PAUSE_SOURCE_STRIPE) {
    const last = await db.comment.findFirst({
      where: { ...commentsOf(user.id), comment_type: "payouts_paused" },
      orderBy: { id: "desc" },
    });
    reason = last?.content ?? null;
  } else if (source === PAUSE_SOURCE_SYSTEM) {
    const last = await db.comment.findFirst({
      where: { ...commentsOf(user.id), comment_type: "on", author_name: { in: SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS } },
      orderBy: { id: "desc" },
    });
    reason = last?.content ?? null;
  }
  return { paused_internally: internally, paused_by_user: byUser, paused_by_source: source, paused_for_reason: reason };
}

// serialize_stripe_connect
async function stripeProps(userId: bigint) {
  const [account] = await selectRows<{ charge_processor_merchant_id: string | null }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "charge_processor_merchant_id")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = 'stripe' ORDER BY ${column("merchant_accounts", "id")} LIMIT 1`,
  );
  const accountId = account?.charge_processor_merchant_id ?? null;
  if (accountId === null || accountId.trim() === "") return { stripeAccountId: null, stripe: { connected: false } };
  return {
    stripeAccountId: accountId,
    stripe: {
      connected: true,
      stripe_connect_account_id: accountId,
      stripe_dashboard_url: `${STRIPE_DASHBOARD}/${accountId}`,
      verification: await stripeVerification(accountId),
    },
  };
}

// serialize_stripe_verification: one Stripe call, whose failure degrades to an error subfield.
export async function stripeVerification(accountId: string) {
  try {
    const account = await Account.retrieve(accountId);
    const requirements = account.requirements;
    return {
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      disabled_reason: requirements?.disabled_reason ?? null,
      currently_due_count: requirements?.currently_due?.length ?? 0,
      past_due_count: requirements?.past_due?.length ?? 0,
      pending_verification_count: requirements?.pending_verification?.length ?? 0,
    };
  } catch (error) {
    if (error instanceof StripeError) return { error: error.message };
    throw error;
  }
}

async function userInfo(user: UserRow) {
  const record = Users.load(user);
  const complianceInfo = await aliveUserComplianceInfoRow(user.id);
  const riskComments = await db.comment.aggregate({
    where: { ...commentsOf(user.id), comment_type: { in: RISK_STATE_COMMENT_TYPES } },
    _max: { created_at: true },
  });
  const watched = await activeWatch(user.id);
  const externalAuthentications = await db.userExternalAuthentication.findMany({
    where: { user_id: user.id },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
  const payout = await nextPayoutForAdmin(user);
  const salesCount = await db.purchase.count({ where: { seller_id: user.id, purchase_state: "successful" } });
  const stripe = await stripeProps(user.id);
  const pingDeliveries = await recentPingDeliveries(user);
  const { protocol, domain } = domainConfig();
  const identifier = encodeURIComponent(user.external_id ?? "");
  const adminLinks: Record<string, string> = {
    impersonate: `${protocol}://${domain}/admin/impersonate?user_identifier=${identifier}`,
  };
  if (stripe.stripeAccountId !== null)
    adminLinks.stripe_dashboard = `${protocol}://${domain}/admin/redirect_to_stripe_dashboard?user_identifier=${identifier}`;

  return {
    id: user.external_id,
    email: formEmail(record),
    name: user.name,
    username: presence(user.username) ?? user.external_id,
    profile_url: subdomainWithProtocol(record),
    country: complianceInfo?.country ?? null,
    locale: user.locale,
    timezone: user.timezone,
    created_at: asJson(user.created_at),
    deleted_at: asJson(user.deleted_at),
    risk_state: riskStateProps(user.user_risk_state, riskComments._max.created_at),
    active_watched_user: watched === null ? null : serializeWatchedUser(watched),
    two_factor_authentication_enabled: isFlagSet(record, "two_factor_authentication_enabled"),
    sign_in: {
      account_created_ip: user.account_created_ip,
      current_ip: user.current_sign_in_ip,
      current_at: asJson(user.current_sign_in_at),
      last_ip: user.last_sign_in_ip,
      last_at: asJson(user.last_sign_in_at),
      count: user.sign_in_count,
    },
    social: {
      twitter_user_id: user.twitter_user_id,
      twitter_handle: user.twitter_handle,
      facebook_uid: user.facebook_uid,
      google_uid: user.google_uid,
      oauth_provider: user.provider,
      external_authentications: externalAuthentications.map((authentication) => ({
        provider: authentication.provider,
        uid: authentication.uid,
        linked_at: asJson(authentication.created_at),
      })),
    },
    payouts: {
      ...(await pauseState(user)),
      next_payout_date: payout.nextPayoutDate === null ? null : isoDate(payout.nextPayoutDate),
      balance_for_next_payout: payout.formattedBalance,
    },
    stats: {
      sales_count: salesCount,
      total_earnings_formatted: money(await salesCentsTotal(user.id)),
      unpaid_balance_formatted: money(await unpaidBalanceCents(user.id)),
      comments_count: await db.comment.count({ where: commentsOf(user.id) }),
    },
    stripe: stripe.stripe,
    recent_ping_deliveries: pingDeliveries,
    admin_links: adminLinks,
  };
}

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/users/info",
  run: async (admin) => {
    const found = await findUserForRead(admin, true);
    if ("refusal" in found) return found.refusal;
    const user = await db.user.findUniqueOrThrow({ where: { id: found.user.id } });
    return jsonRendered(successPayload(found.user, { user: await userInfo(user) }));
  },
});
