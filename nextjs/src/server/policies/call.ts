// app/policies/call_policy.rb
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

// `(user.role_admin_for?(seller) || user.role_support_for?(seller)) && record.purchase.seller == seller`
function update(context: SellerContext, purchaseSellerId: bigint | number | null): boolean {
  const c = requireUser(context);
  return (roleAdminFor(c) || roleSupportFor(c)) && purchaseSellerId !== null && context.seller !== null && BigInt(purchaseSellerId) === BigInt(context.seller.id);
}

export const callPolicy = { update };
