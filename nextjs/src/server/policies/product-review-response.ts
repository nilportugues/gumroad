// app/policies/product_review_response_policy.rb
import { requireUser, roleAdminFor, roleOwnerFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

// `role_permitted? && owned_by_seller?`; the record is the review's product's seller id.
function allowed(context: SellerContext, productSellerId: bigint | number | null): boolean {
  const c = requireUser(context);
  const permitted = roleOwnerFor(c) || roleAdminFor(c) || roleSupportFor(c);
  return permitted && productSellerId !== null && context.seller !== null && BigInt(productSellerId) === BigInt(context.seller.id);
}

export const productReviewResponsePolicy = { update: allowed, destroy: allowed };
