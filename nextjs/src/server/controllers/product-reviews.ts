// ProductReviewsController#index and #show with ProductReviewPresenter#product_review_props: the reviews the product page lists, ten to a page.
// Public; reads only. A review with an approved video hands back (its thumbnail comes from the video file's storage).
import { Prisma, type Purchase, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { raterAccountName } from "../page-props/buyer/reviews.ts";
import { assetHost, domainConfig } from "../page-props/domain.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { timeAsJson } from "../search/es-json.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { jsonAction, json } from "./json-actions.ts";
import type { MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";

const PER_PAGE = 10;
// Link flag 17
const DISPLAY_PRODUCT_REVIEWS_FLAG = 2n ** 16n;
const DEFAULT_AVATAR = "gumroad-default-avatar-5.png";

const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);
// `head :not_found` names the content type of the format asked for.
const head = (status: number): ActionResult => ({
  status,
  body: "",
  contentType: "application/json",
  paramsRead: true,
});

type ReviewRow = {
  id: bigint;
  link_id: bigint | null;
  purchase_id: bigint | null;
  rating: number;
  message: string | null;
  anonymous: boolean | number | null;
  created_at: Date;
  approved_video_id: bigint | null;
};

// `1.month.ago`: the same day of the month before, or that month's last day when it has no such day.
export function oneMonthBefore(now: Date): Date {
  const lastDayOfPreviousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  const moved = new Date(now);
  moved.setUTCDate(1);
  moved.setUTCMonth(moved.getUTCMonth() - 1);
  moved.setUTCDate(Math.min(now.getUTCDate(), lastDayOfPreviousMonth));
  return moved;
}

// `left_joins(:approved_video)`: the has_one's `alive.approved` conditions sit in the join, whose rows the listing keeps as they come.
const REVIEWS_WITH_APPROVED_VIDEO = Prisma.sql`FROM ${table("product_reviews")} LEFT OUTER JOIN ${table("product_review_videos")} ON ${column("product_review_videos", "product_review_id")} = ${column("product_reviews", "id")} AND ${column("product_review_videos", "deleted_at")} IS NULL AND ${column("product_review_videos", "approval_status")} = 'approved'`;
const VISIBLE_ON_PRODUCT_PAGE = Prisma.sql`(${column("product_reviews", "has_message")} = TRUE OR ${column("product_review_videos", "id")} IS NOT NULL)`;
const REVIEW_COLUMNS = Prisma.sql`${Prisma.raw("`product_reviews`.*")}, ${column("product_review_videos", "id")} AS approved_video_id`;

async function reviewProps(
  review: ReviewRow,
  productSellerId: bigint | null,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  if (review.approved_video_id !== null) throw new HandBackToRails("a review with an approved video");
  if (review.purchase_id === null) throw new HandBackToRails("a review without a purchase");
  const [purchaseRow] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${review.purchase_id} LIMIT 1`,
  );
  if (!purchaseRow) throw new HandBackToRails("a review whose purchase is missing");
  const purchase = castRow<Purchase>("Purchase", purchaseRow);
  const [purchaserRow] =
    purchase.purchaser_id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${purchase.purchaser_id} LIMIT 1`,
        );
  const purchaser = purchaserRow ? castRow<User>("User", purchaserRow) : null;

  // ProductReview#shows_account_identity?
  const accountName = raterAccountName(purchase, purchaser);
  const showsIdentity = !review.anonymous && present(accountName);
  const avatar = showsIdentity
    ? await avatarUrl(purchaser!)
    : `${assetHost(domainConfig(process.env)) ?? ""}/images/${DEFAULT_AVATAR}`;

  // ProductReviewPresenter#viewer_may_see_purchase_id?
  const viewer = railsLoggedInUser(input.context);
  const seller = input.context.currentSeller;
  const mayIdentify =
    (seller !== null && productSellerId !== null && seller.id === productSellerId) ||
    (viewer !== null && purchase.purchaser_id !== null && viewer.id === purchase.purchaser_id);

  const [response] = await selectRows<{ message: string | null }>(
    Prisma.sql`SELECT ${column("product_review_responses", "message")} FROM ${table("product_review_responses")} WHERE ${column("product_review_responses", "product_review_id")} = ${review.id} LIMIT 1`,
  );
  return {
    id: encrypt(review.id),
    rating: review.rating,
    message: review.message,
    rater: { avatar_url: avatar, name: showsIdentity ? accountName : "Anonymous" },
    purchase_id: mayIdentify ? encrypt(purchase.id) : null,
    created_at: timeAsJson(review.created_at),
    is_new: review.created_at.getTime() > oneMonthBefore(new Date()).getTime(),
    response: response ? { message: response.message } : null,
    video: null,
  };
}

async function sellerIdOfProduct(productId: bigint | null): Promise<bigint | null> {
  if (productId === null) return null;
  const [row] = await selectRows<{ user_id: bigint | null }>(
    Prisma.sql`SELECT ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1`,
  );
  return row?.user_id ?? null;
}

// `params.permit(:product_id, :page, :id)`: a scalar, else dropped.
const scalarParam = (value: unknown): string | null => (typeof value === "string" ? value : null);

async function index(input: MutationInput): Promise<ActionResult> {
  if (requestFormat(input.request) !== "json")
    throw new HandBackToRails("a product reviews listing requested in another format");
  const id = decrypt(scalarParam(input.params.product_id) ?? "");
  const [product] =
    id === null
      ? []
      : await selectRows<{ id: bigint; user_id: bigint | null; flags: bigint | number | null }>(
          Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`,
        );
  if (!product) return head(404);
  const seller = input.context.currentSeller;
  const ownProduct = seller !== null && product.user_id !== null && seller.id === product.user_id;
  if ((BigInt(product.flags ?? 0) & DISPLAY_PRODUCT_REVIEWS_FLAG) === 0n && !ownProduct) return head(403);

  const [counted] = await selectRows<{ total: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS total ${REVIEWS_WITH_APPROVED_VIDEO} WHERE ${column("product_reviews", "link_id")} = ${product.id} AND ${column("product_reviews", "deleted_at")} IS NULL AND ${VISIBLE_ON_PRODUCT_PAGE}`,
  );
  const count = Number(counted!.total);
  // Pagy's `page:` is `to_i` of the parameter, at least 1; a page past the last is an empty one (`overflow: :empty_page`).
  const page = Math.max(rubyToI(scalarParam(input.params.page)), 1);
  const pages = Math.max(Math.ceil(count / PER_PAGE), 1);
  const rows =
    page > pages
      ? []
      : await selectRows<ReviewRow>(
          Prisma.sql`SELECT ${REVIEW_COLUMNS} ${REVIEWS_WITH_APPROVED_VIDEO} WHERE ${column("product_reviews", "link_id")} = ${product.id} AND ${column("product_reviews", "deleted_at")} IS NULL AND ${VISIBLE_ON_PRODUCT_PAGE}
            ORDER BY ${column("product_reviews", "rating")} DESC, ${column("product_reviews", "created_at")} DESC, ${column("product_reviews", "id")} DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
        );
  const reviews = [];
  for (const row of rows) reviews.push(await reviewProps(row, product.user_id, input));
  return json({ pagination: { pages, page }, reviews });
}

async function show(input: MutationInput): Promise<ActionResult> {
  if (requestFormat(input.request) !== "json")
    throw new HandBackToRails("a product review requested in another format");
  const id = decrypt(input.routeParams.id ?? "");
  const [review] =
    id === null
      ? []
      : await selectRows<ReviewRow>(
          Prisma.sql`SELECT ${REVIEW_COLUMNS} ${REVIEWS_WITH_APPROVED_VIDEO} WHERE ${column("product_reviews", "deleted_at")} IS NULL AND ${VISIBLE_ON_PRODUCT_PAGE} AND ${column("product_reviews", "id")} = ${id} LIMIT 1`,
        );
  // RecordNotFound: Rails answers it with its exception page, which the port does not render.
  if (!review) throw new HandBackToRails("a review that is not visible on the product page");
  if (review.link_id === null) throw new HandBackToRails("a review without a product");
  return json({ review: await reviewProps(review, await sellerIdOfProduct(review.link_id), input) });
}

const guarded = (run: (input: MutationInput) => Promise<ActionResult>) => async (input: MutationInput) => {
  try {
    return await run(input);
  } catch (error) {
    if (error instanceof NotPortedError || error instanceof PageNotPortedError)
      throw new HandBackToRails(error.message);
    throw error;
  }
};

export const productReviewsIndexResponse = (incoming: Request) => jsonAction(incoming, {}, {}, guarded(index));
export const productReviewResponse = (incoming: Request, routeParams: Record<string, string>) =>
  jsonAction(incoming, routeParams, {}, guarded(show));
