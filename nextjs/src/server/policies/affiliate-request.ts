// app/policies/affiliate_request_policy.rb
import { requireUser, roleAdminFor, roleMarketingFor, type SellerContext } from "./seller-context.ts";

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const affiliateRequestPolicy = { update, approve_all: update };
