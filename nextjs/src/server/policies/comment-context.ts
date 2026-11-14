// app/policies/comment_context_policy.rb. It is used where the visitor may be signed out, so it takes the context as it is.
//
// The clauses that need a purchase (`eligible_purchase?`) and the visibility of the post (`visible_posts_for`) are not ported: a
// caller that reaches one gets a NotPortedError, and passes no purchase in the paths it serves.
import { NotPortedError } from "../models/user.ts";

import { roleAdminFor, roleMarketingFor, requireUser, type SellerContext } from "./seller-context.ts";

export type CommentContextRecord = {
  // The comment, with the fields the policy reads.
  comment: { author_id: bigint | null; purchase_id: bigint | null; commentable_seller_id: number | null } | null;
  // The post, for index?
  commentable: { seller_id: number | null } | null;
  purchase: unknown;
  // Whether `seller.visible_posts_for(...)` includes the post, which needs queries; a caller that computed it passes it.
  postVisible?: boolean;
};

// "Allow the seller of the post, and appropriate roles for the seller"
function sellerRoles(context: SellerContext, commentableSellerId: number | null): boolean {
  if (context.user === null || context.seller === null || commentableSellerId === null) return false;
  if (commentableSellerId !== Number(context.seller.id)) return false;
  const c = requireUser(context);
  return roleAdminFor(c) || roleMarketingFor(c);
}

function viewable(context: SellerContext, sellerId: number | null, purchase: unknown, postVisible?: boolean): boolean {
  if (sellerRoles(context, sellerId)) return true;
  if (purchase !== null)
    throw new NotPortedError(
      "A comment purchase's eligibility (Installment#eligible_purchase?)",
      "app/policies/comment_context_policy.rb",
    );
  if (sellerId === null) return false;
  if (postVisible !== undefined) return postVisible;
  throw new NotPortedError(
    "The visibility of a post to a visitor (User#visible_posts_for)",
    "app/policies/comment_context_policy.rb",
  );
}

const index = (context: SellerContext, record: CommentContextRecord) =>
  viewable(context, record.commentable!.seller_id, record.purchase, record.postVisible);
const create = (context: SellerContext, record: CommentContextRecord) =>
  viewable(context, record.comment!.commentable_seller_id, record.purchase, record.postVisible);

function authoredBy(context: SellerContext, authorId: bigint | null): boolean {
  return context.user !== null && authorId !== null && authorId === context.user.id;
}

function purchased(record: CommentContextRecord): boolean {
  if (record.purchase === null) return false;
  throw new NotPortedError("A comment purchase's ownership", "app/policies/comment_context_policy.rb");
}

function update(context: SellerContext, record: CommentContextRecord): boolean {
  return purchased(record) || authoredBy(context, record.comment!.author_id);
}

function destroy(context: SellerContext, record: CommentContextRecord): boolean {
  return (
    sellerRoles(context, record.comment!.commentable_seller_id) ||
    purchased(record) ||
    authoredBy(context, record.comment!.author_id)
  );
}

export const commentContextPolicy = { index, create, update, destroy };
