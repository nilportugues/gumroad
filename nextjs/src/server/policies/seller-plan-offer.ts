// app/policies/seller_plan_offer_policy.rb
import { requireUser, roleAdminFor, roleOwnerFor, type SellerContext } from "./seller-context.ts";

// `user.role_owner_for?(seller) || user.role_admin_for?(seller)`
function checkout(context: SellerContext): boolean {
  const c = requireUser(context);
  return roleOwnerFor(c) || roleAdminFor(c);
}

export const sellerPlanOfferPolicy = { checkout };
