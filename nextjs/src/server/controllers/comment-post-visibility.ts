// Whether a post is visible to a visitor, for the comment actions that ask `User#visible_posts_for` through CommentContextPolicy.
import { Prisma, type Installment } from "@prisma/client";

import { InstallmentFlags } from "../models/installment-post.ts";
import { selectRows, table, column } from "../models/sql.ts";
import { AUDIENCE_TYPE } from "../page-props/storefront/post.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails } from "./application-controller.ts";

export const one = async (query: Prisma.Sql): Promise<boolean> => (await selectRows(query)).length > 0;

// `commentable.seller.visible_posts_for(pundit_user: context, shown_on_profile: false).include?(commentable)` for a published post.
export async function visibleToVisitor(sellerContext: SellerContext, post: Installment): Promise<boolean> {
  const sellerId = BigInt(post.seller_id!);
  // The seller's own account sees every post that is not a workflow's and not deleted.
  if (sellerContext.seller !== null && sellerContext.seller.id === sellerId)
    return post.workflow_id === null && post.deleted_at === null;
  const user = sellerContext.user;
  const publicPost =
    post.installment_type === AUDIENCE_TYPE &&
    InstallmentFlags.isSet(post.flags, "shown_on_profile") &&
    post.workflow_id === null &&
    post.deleted_at === null;
  if (publicPost) return true;
  if (user === null) return false;
  // The posts a follower, a customer or an affiliate sees depend on the filters of each: only the visitor with none of the three is
  // settled here.
  const related =
    (user.email !== null &&
      user.email !== "" &&
      (await one(
        Prisma.sql`SELECT 1 AS one FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} = ${user.email} LIMIT 1`,
      ))) ||
    (await one(
      Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "purchaser_id")} = ${user.id} LIMIT 1`,
    )) ||
    (await one(
      Prisma.sql`SELECT 1 AS one FROM ${table("affiliates")} WHERE ${column("affiliates", "seller_id")} = ${sellerId} AND ${column("affiliates", "affiliate_user_id")} = ${user.id} LIMIT 1`,
    ));
  if (related) throw new HandBackToRails("a visitor who follows, bought from or is an affiliate of the seller");
  return false;
}
