// app/policies/{analytics,audience,churn}_policy.rb and app/policies/audience/purchase_policy.rb#index?:
// every team role reads the sales and audience dashboards.
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function anyRole(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c) || roleAccountantFor(c);
}

export const analyticsPolicy = { index: anyRole };
export const audiencePolicy = { index: anyRole, export: anyRole };
export const churnPolicy = { show: anyRole };
export const audiencePurchasePolicy = { index: anyRole };
