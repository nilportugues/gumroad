// Whether a post is visible to a visitor, for the comment actions that ask `User#visible_posts_for` through CommentContextPolicy.
import { Prisma, type Installment } from "@prisma/client";

import { InstallmentFlags } from "../models/installment-post.ts";
import { selectRows, table, column } from "../models/sql.ts";
import { AFFILIATE_TYPE, FOLLOWER_TYPE, filterValue, parseJsonData, readFilters } from "../models/with-filtering.ts";
import { AUDIENCE_TYPE } from "../page-props/storefront/post.ts";
import type { SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails } from "./application-controller.ts";

export const one = async (query: Prisma.Sql): Promise<boolean> => (await selectRows(query)).length > 0;

// `follower_passes_filters` / `affiliate_passes_filters` for the two time filters; the filters on waitlisted products and on
// affiliate products, and any value the port cannot read, stay in Rails.
function passesTimeFilters(post: Installment, joinedAt: Date): boolean {
  const subject = { jsonData: () => parseJsonData(post.json_data) };
  try {
    if (filterValue(subject, "waitlisted_products") !== null || filterValue(subject, "affiliate_products") !== null)
      throw new HandBackToRails("a post filtered by waitlisted or affiliate products");
    const { createdAfter, createdBefore } = readFilters(subject);
    if (createdAfter !== null && joinedAt < createdAfter) return false;
    if (createdBefore !== null && joinedAt > createdBefore) return false;
    return true;
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    throw new HandBackToRails("a post whose audience filters the port cannot read");
  }
}

// `commentable.seller.visible_posts_for(pundit_user: context, shown_on_profile: false).include?(commentable)` for a published post.
// `relations`: also weigh a visitor who is an active follower or a direct affiliate of the seller (CommentsController#create); a
// customer still hands back, as does a post filtered by anything but the two time filters.
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
  const followerRows = await selectRows<{ confirmed_at: Date | null; deleted_at: Date | null; created_at: Date }>(
    Prisma.sql`SELECT ${column("followers", "confirmed_at")} AS confirmed_at, ${column("followers", "deleted_at")} AS deleted_at, ${column("followers", "created_at")} AS created_at FROM ${table("followers")} WHERE ${column("followers", "followed_id")} = ${sellerId} AND ${column("followers", "email")} = ${user.email}`,
  );
  const affiliateRows = await selectRows<{ type: string | null; deleted_at: Date | null; created_at: Date }>(
    Prisma.sql`SELECT ${column("affiliates", "type")} AS type, ${column("affiliates", "deleted_at")} AS deleted_at, ${column("affiliates", "created_at")} AS created_at FROM ${table("affiliates")} WHERE ${column("affiliates", "seller_id")} = ${sellerId} AND ${column("affiliates", "affiliate_user_id")} = ${user.id}`,
  );
  if (followerRows.length === 0 && affiliateRows.length === 0) return false;
  if (!relations) throw new HandBackToRails("a visitor who follows or is an affiliate of the seller");

  // `Follower.active.find_by(...)` and `direct_affiliates.alive.find_by(...)`: an unconfirmed or removed follower, a collaborator
  // and a removed affiliate are no relation at all; two live rows would leave Rails' pick unspecified.
  const followers = followerRows.filter((row) => row.confirmed_at !== null && row.deleted_at === null);
  const affiliates = affiliateRows.filter((row) => row.type === "DirectAffiliate" && row.deleted_at === null);
  if (followers.length > 1 || affiliates.length > 1) throw new HandBackToRails("several live rows of one visitor");
  const follower = followers[0];
  const affiliate = affiliates[0];
  if (follower === undefined && affiliate === undefined) return false;

  if (post.workflow_id !== null || post.deleted_at !== null) return false;
  switch (post.installment_type) {
    case AUDIENCE_TYPE:
      return true;
    case FOLLOWER_TYPE:
      return follower !== undefined && passesTimeFilters(post, follower.created_at);
    case AFFILIATE_TYPE:
      return affiliate !== undefined && passesTimeFilters(post, affiliate.created_at);
    default:
      // seller, product, variant and abandoned cart posts reach a visitor through a purchase only.
      return false;
  }
}
