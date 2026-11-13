// Whether a post is visible to a visitor, for the comment actions that ask `User#visible_posts_for` through CommentContextPolicy.
import { Prisma, type Installment } from "@prisma/client";

import { InstallmentFlags } from "../models/installment-post.ts";
import { selectRows, table, column } from "../models/sql.ts";
import { AFFILIATE_TYPE, FOLLOWER_TYPE } from "../models/with-filtering.ts";
import { AUDIENCE_TYPE } from "../page-props/storefront/post.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails } from "./application-controller.ts";

export const one = async (query: Prisma.Sql): Promise<boolean> => (await selectRows(query)).length > 0;

const FILTER_KEYS = ["created_after", "created_before", "waitlisted_products", "affiliate_products"];

// Whether the post carries a filter of WithFiltering that `follower_passes_filters` or `affiliate_passes_filters` would weigh.
function hasAudienceFilter(post: Installment): boolean {
  if (post.json_data === null || post.json_data === "") return false;
  let data: unknown;
  try {
    data = JSON.parse(post.json_data);
  } catch {
    return true;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return true;
  return FILTER_KEYS.some((key) => {
    const value = (data as Record<string, unknown>)[key];
    return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
  });
}

// `commentable.seller.visible_posts_for(pundit_user: context, shown_on_profile: false).include?(commentable)` for a published post.
// `relations`: also weigh a visitor who is an active follower or a direct affiliate of the seller (CommentsController#create); a
// customer, an unconfirmed or removed follower and any other affiliate row still hand back, as does a post whose filters would apply.
export async function visibleToVisitor(
  sellerContext: SellerContext,
  post: Installment,
  { relations = false }: { relations?: boolean } = {},
): Promise<boolean> {
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
  if (user.email === null) throw new HandBackToRails("a visitor without an email address");
  if (
    await one(
      Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "purchaser_id")} = ${user.id} LIMIT 1`,
    )
  )
    throw new HandBackToRails("a visitor who bought from the seller");
  const followerRows = await selectRows(
    Prisma.sql`SELECT ${column("followers", "confirmed_at")} AS confirmed_at, ${column("followers", "deleted_at")} AS deleted_at FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} = ${user.email}`,
  );
  const affiliateRows = await selectRows(
    Prisma.sql`SELECT ${column("affiliates", "type")} AS type, ${column("affiliates", "deleted_at")} AS deleted_at FROM ${table("affiliates")} WHERE ${column("affiliates", "seller_id")} = ${sellerId} AND ${column("affiliates", "affiliate_user_id")} = ${user.id}`,
  );
  if (followerRows.length === 0 && affiliateRows.length === 0) return false;
  if (!relations) throw new HandBackToRails("a visitor who follows or is an affiliate of the seller");

  if (followerRows.length > 1) throw new HandBackToRails("several follower rows of one address");
  const follower = followerRows.length === 1;
  if (follower && (followerRows[0]!.confirmed_at === null || followerRows[0]!.deleted_at !== null))
    throw new HandBackToRails("a follower who is unconfirmed or removed");
  const affiliate = affiliateRows.length > 0;
  if (
    affiliate &&
    (affiliateRows.length > 1 || affiliateRows[0]!.type !== "DirectAffiliate" || affiliateRows[0]!.deleted_at !== null)
  )
    throw new HandBackToRails("an affiliate row that is not a live direct affiliate");

  if (post.workflow_id !== null || post.deleted_at !== null) return false;
  switch (post.installment_type) {
    case AUDIENCE_TYPE:
      return true;
    case FOLLOWER_TYPE:
      if (!follower) return false;
      break;
    case AFFILIATE_TYPE:
      if (!affiliate) return false;
      break;
    default:
      // seller, product, variant and abandoned cart posts reach a visitor through a purchase only.
      return false;
  }
  if (hasAudienceFilter(post)) throw new HandBackToRails("a post whose audience filters would apply to the visitor");
  return true;
}
