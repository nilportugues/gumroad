// app/policies/audience/follower_policy.rb
import { requireUser, roleAccountantFor, roleAdminFor, roleMarketingFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAccountantFor(c) || roleAdminFor(c) || roleMarketingFor(c) || roleSupportFor(c);
}

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleSupportFor(c);
}

export const audienceFollowerPolicy = { index, update, destroy: update };
