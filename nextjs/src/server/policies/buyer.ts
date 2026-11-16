// PurchasePolicy (app/policies/purchase_policy.rb), WishlistPolicy and ProductReviewPolicy: the
// buyer's own library, saved wishlists and reviews belong to the account owner, never a team member.
import { requireUser, roleOwnerFor, type SellerContext } from "./seller-context.ts";

function index(context: SellerContext): boolean {
  return roleOwnerFor(requireUser(context));
}

// `index? && record.user == user`
function ownWishlist(context: SellerContext, wishlist: { user_id: bigint | null }): boolean {
  const c = requireUser(context);
  return roleOwnerFor(c) && wishlist.user_id === c.user.id;
}

export const purchasePolicy = { index, archive: index, unarchive: index, delete: index };
export const wishlistPolicy = { index, create: index, update: ownWishlist, destroy: ownWishlist };
export const productReviewPolicy = { index };
