// app/policies/commission_policy.rb
import { requireUser, roleAdminFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

// `(user.role_admin_for?(seller) || user.role_support_for?(seller)) && record.deposit_purchase.seller == seller`
function update(context: SellerContext, depositSellerId: bigint | number | null): boolean {
  const c = requireUser(context);
  if (!(roleAdminFor(c) || roleSupportFor(c))) return false;
  return context.seller !== null && depositSellerId !== null && BigInt(depositSellerId) === BigInt(context.seller.id);
}

export const commissionPolicy = { update, complete: update };
