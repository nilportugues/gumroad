// RenderingExtension#policies_props: the verdicts of the record-less policy queries the client
// gates its UI on. Evaluation order follows the Ruby hash; a role check raises
// MembershipNotFoundError for a seller the user has no membership on, as ActiveRecord does.
import { RISK_STATES } from "../../models/user.ts";
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleOwnerFor, roleSupportFor, type AuthorizedSellerContext, type SellerContext } from "../../policies/seller-context.ts";
import { MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT, salesCentsTotal } from "../../search/purchase-sales.ts";
import { hasAccessibleCommunities, hasCompletedPayment, madeSaleWithConnectOrPaypalAccount } from "./reads.ts";

const anyRole = (c: AuthorizedSellerContext) => roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
const adminOrMarketing = (c: AuthorizedSellerContext) => roleAdminFor(c) || roleMarketingFor(c);

// User#eligible_for_store_agent?, still read by PiracyReports::Eligibility: cheapest checks first, so an unpaid seller never reaches Elasticsearch.
export async function eligibleForStoreAgent(seller: AuthorizedSellerContext["user"], isDevelopment: boolean): Promise<boolean> {
  if (isDevelopment) return true;
  const suspended = (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state);
  if (seller.confirmed_at === null || suspended) return false;
  const hasCompletedPayouts = (await hasCompletedPayment(seller.id)) || (await madeSaleWithConnectOrPaypalAccount(seller.id));
  if (!hasCompletedPayouts) return false;
  return (await salesCentsTotal(seller.id)) >= MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT;
}

export async function policiesProps(context: SellerContext): Promise<Record<string, Record<string, boolean>>> {
  const c = requireUser(context);

  return {
    affiliate_requests_onboarding_form: { update: adminOrMarketing(c) },
    direct_affiliate: { create: adminOrMarketing(c), update: adminOrMarketing(c) },
    collaborator: { create: roleAdminFor(c), update: roleAdminFor(c) },
    product: { create: adminOrMarketing(c) },
    product_review_response: { update: roleOwnerFor(c) || roleAdminFor(c) || roleSupportFor(c) },
    balance: { index: roleAccountantFor(c) || roleAdminFor(c) || roleSupportFor(c), export: roleAccountantFor(c) || roleAdminFor(c) || roleSupportFor(c) },
    checkout_offer_code: { create: adminOrMarketing(c) },
    checkout_form: { update: adminOrMarketing(c) },
    upsell: { create: adminOrMarketing(c) },
    settings_payments_user: { show: roleAdminFor(c) },
    settings_main_user: { update_username: roleOwnerFor(c) },
    settings_profile: { manage_social_connections: roleOwnerFor(c), update: adminOrMarketing(c) },
    settings_third_party_analytics_user: { update: roleAdminFor(c) },
    installment: { create: adminOrMarketing(c) },
    workflow: { create: adminOrMarketing(c) },
    utm_link: { index: roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c) || roleAccountantFor(c) },
    community: { index: await hasAccessibleCommunities(c.user) },
    churn: { show: roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c) || roleAccountantFor(c) },
    page: { index: anyRole(c), create: adminOrMarketing(c) },
  };
}

