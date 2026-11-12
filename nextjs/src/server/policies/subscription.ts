// app/policies/subscription_policy.rb
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

// `return false if record.link.user != seller; user.role_admin_for?(seller) || user.role_support_for?(seller)`
function unsubscribeBySeller(context: SellerContext, linkSellerId: bigint | number): boolean {
  const c = requireUser(context);
  if (context.seller === null || BigInt(linkSellerId) !== BigInt(context.seller.id)) return false;
  return roleAdminFor(c) || roleSupportFor(c);
}

export const subscriptionPolicy = { unsubscribeBySeller };
