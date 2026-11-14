// app/policies/dashboard_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

export const dashboardPolicy = {
  index,
  customersCount: index,
  totalRevenue: index,
  activeMembersCount: index,
  monthlyRecurringRevenue: index,
  downloadTaxForm: index,
  dismissGettingStartedChecklist: index,
};
