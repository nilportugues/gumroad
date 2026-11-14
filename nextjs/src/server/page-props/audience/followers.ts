// FollowersController#index and Follower#as_json.
import { Prisma, type User } from "@prisma/client";

import { audienceFollowerPolicy } from "../../policies/audience-follower.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { externalId, paramToI, stringParam, type QuerySource } from "./support.ts";

const FOLLOWERS = "followers";
const FOLLOWERS_PER_PAGE = 20;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type FollowerRow = { id: number; email: string | null; created_at: Date | null; source: string | null; confirmed_at: Date | null };

// Time#to_fs(:formatted_date_full_month): "%B %-d, %Y"
// `to_fs(:formatted_date_full_month)` in the app's UTC zone.
export const formattedDate = (time: Date) => `${MONTHS[time.getUTCMonth()]} ${time.getUTCDate()}, ${time.getUTCFullYear()}`;

// `current_seller.followers.active`
const active = (sellerId: bigint) =>
  Prisma.sql`${column(FOLLOWERS, "followed_id")} = ${sellerId} AND ${column(FOLLOWERS, "deleted_at")} IS NULL AND ${column(FOLLOWERS, "confirmed_at")} IS NOT NULL`;

export type FollowersParams = { email: string; page: number };

// FollowersController#index: `params[:email].to_s.strip`, `[string_param(:page).to_i, 1].max`
export function followersParams(query: QuerySource): FollowersParams {
  return { email: stringParam(query, "email").trim(), page: Math.max(paramToI(stringParam(query, "page")), 1) };
}

export async function totalCount(seller: User): Promise<number> {
  const [row] = await selectRows<{ count: bigint | number }>(Prisma.sql`SELECT COUNT(*) AS count FROM ${table(FOLLOWERS)} WHERE ${active(seller.id)}`);
  return Number(row?.count ?? 0);
}

// Follower#as_json(pundit_user:)
export function followerJson(follower: FollowerRow, sellerContext: SellerContext) {
  return {
    id: externalId(follower.id),
    email: follower.email,
    created_at: follower.created_at ? follower.created_at.toISOString() : null,
    source: follower.source,
    formatted_confirmed_on: formattedDate(follower.confirmed_at!),
    can_update: audienceFollowerPolicy.update(sellerContext),
  };
}

// The followers of a page and Pagy::Countless' view of it (`overflow: :empty_page`).
export async function pagedFollowers(seller: User, { email, page }: FollowersParams, sellerContext: SellerContext) {
  const search = email === "" ? Prisma.empty : Prisma.sql` AND email LIKE ${`%${email}%`}`;
  const rows = await selectRows<FollowerRow>(
    Prisma.sql`SELECT ${table(FOLLOWERS)}.* FROM ${table(FOLLOWERS)} WHERE ${active(seller.id)}${search} ORDER BY ${column(FOLLOWERS, "confirmed_at")} DESC, ${column(FOLLOWERS, "id")} DESC LIMIT ${FOLLOWERS_PER_PAGE + 1} OFFSET ${(page - 1) * FOLLOWERS_PER_PAGE}`,
  );
  return {
    followers: rows.slice(0, FOLLOWERS_PER_PAGE).map((row) => followerJson(row, sellerContext)),
    page,
    hasMore: rows.length > FOLLOWERS_PER_PAGE,
  };
}
