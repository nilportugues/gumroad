// app/policies/profile_section_policy.rb
import { requireUser, roleAdminFor, roleMarketingFor, type SellerContext } from "./seller-context.ts";

function update(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

export const profileSectionPolicy = { create: update, update, destroy: update };
