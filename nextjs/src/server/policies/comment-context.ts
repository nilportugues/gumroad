// app/policies/comment_context_policy.rb. It is used where the visitor may be signed out, so it takes the context as it is.
//
// The visibility of the post (`visible_posts_for`) is not ported: a caller that reaches it gets a NotPortedError. A purchase is
// served only when the caller says it is eligible (`eligible_purchase?`), which it knows for a post that needs no purchase.
import { NotPortedError } from "../models/user.ts";

import { roleAdminFor, roleMarketingFor, requireUser, type SellerContext } from "./seller-context.ts";

export type CommentContextRecord = {
  // The comment, with the fields the policy reads.
  comment: { author_id: bigint | null; purchase_id: bigint | null; commentable_seller_id: number | null } | null;
  // The post, for index?
  commentable: { seller_id: number | null } | null;
  purchase: { id: bigint; eligible: boolean } | null;
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

function viewable(
  context: SellerContext,
  sellerId: number | null,
  purchase: CommentContextRecord["purchase"],
  postVisible?: boolean,
): boolean {
  if (sellerRoles(context, sellerId)) return true;
  if (purchase?.eligible) return true;
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

// "Allow the purchaser of the post's belonging product": the purchase is the one the comment was written with.
function purchased(record: CommentContextRecord): boolean {
  return record.purchase !== null && record.comment!.purchase_id !== null && record.purchase.id === record.comment!.purchase_id;
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
