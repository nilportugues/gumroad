// app/policies/product_review_video_policy.rb, for the seller's approve and reject actions.
import { requireUser, roleAdminFor, roleOwnerFor, roleSupportFor, type SellerContext } from "./seller-context.ts";

// `role_permitted? && owned_by_seller?(record)`; the record is the seller id of the video's review's purchase.
function approve(context: SellerContext, purchaseSellerId: bigint | number | null): boolean {
  const c = requireUser(context);
  const permitted = roleOwnerFor(c) || roleAdminFor(c) || roleSupportFor(c);
  return permitted && purchaseSellerId !== null && context.seller !== null && BigInt(purchaseSellerId) === BigInt(context.seller.id);
}

export const productReviewVideoPolicy = { approve, reject: approve };
