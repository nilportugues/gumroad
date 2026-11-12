// CommentsController#index (app/controllers/comments_controller.rb): the page of comments a post's "load more" fetches on its
// seller's host, for a signed-out visitor or a signed-in one. PaginatedCommentsPresenter is the one the post page uses.
//
// Left to Rails, before anything is read: a request that is not JSON when it is refused (Rails redirects), a purchase (a
// `purchase_id` that names one, or one the visitor made of the post's product), a signed-in visitor who follows the seller, bought
// from them or is their affiliate (`User#visible_posts_for` weighs the filters of each post), a post without a seller, a page
// params that Ruby cannot `to_i`, and a page past the last (Pagy raises).
import { Prisma, type Installment, type User } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { paginatedComments } from "../page-props/storefront/post.ts";
import { commentContextPolicy, type CommentContextRecord } from "../policies/comment-context.ts";
import { loadSellerContext, MembershipNotFoundError } from "../policies/seller-context.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { one, visibleToVisitor } from "./comment-post-visibility.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const NOT_ALLOWED = "You are not allowed to perform this action.";

// String#to_i: an optional sign and leading digits (underscores between digits), anything else is 0.
const rubyToI = (value: string): number => {
  const match = /^\s*([+-]?\d+(?:_\d+)*)/u.exec(value);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
};

// `Installment.published.find_by_external_id(id)`
async function findPost(externalId: string): Promise<Installment | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows<Installment>(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// set_purchase: the post author needs none. Any purchase, or what could lead to one, goes to Rails: it picks the purchase that
// counts (success states, not refunded, subscriptions' original purchase) and the policy then asks the post whether it is eligible.
async function assertNoPurchase(input: MutationInput, user: User | null, post: Installment): Promise<void> {
  const seller = input.context.currentSeller;
  if (seller !== null && seller.id === BigInt(post.seller_id ?? -1)) return;
  const purchaseId = input.params.purchase_id;
  // `if params[:purchase_id]`: an empty string is truthy, a missing value is not.
  if (purchaseId !== undefined && purchaseId !== null) {
    if (typeof purchaseId !== "string") throw new HandBackToRails("a purchase_id that is not text");
    // Purchase.find_by_external_id
    const id = decrypt(purchaseId);
    if (
      id !== null &&
      (await one(
        Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
      ))
    )
      throw new HandBackToRails("a purchase_id that names a purchase");
    return;
  }
  if (user === null || post.link_id === null) return;
  if (
    await one(
      Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${user.id} AND ${column("purchases", "link_id")} = ${post.link_id} LIMIT 1`,
    )
  )
    throw new HandBackToRails("a visitor who bought the post's product");
}

async function index(input: MutationInput): Promise<ActionResult> {
  const { context, params, routeParams } = input;
  const user = railsLoggedInUser(context);
  // set_post
  const post = await findPost(routeParams.post_id!);
  if (post === null) return { ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND, true), rescued: true };
  if (!post.seller_id) throw new HandBackToRails("a post without a seller");
  await assertNoPurchase(input, user, post);

  const page = params.page;
  if (page !== undefined && page !== null && typeof page !== "string")
    throw new HandBackToRails("a page that is not text");

  const sellerContext = await loadSellerContext(context);
  const sellerId = Number(post.seller_id);
  const record: CommentContextRecord = {
    comment: null,
    commentable: { seller_id: sellerId },
    purchase: null,
  };
  let allowed: boolean;
  try {
    // The roles of the seller settle it first; the visibility query only runs for the other visitors.
    try {
      allowed = commentContextPolicy.index(sellerContext, record);
    } catch (error) {
      if (!(error instanceof NotPortedError)) throw error;
      allowed = commentContextPolicy.index(sellerContext, {
        ...record,
        postVisible: await visibleToVisitor(sellerContext, post),
      });
    }
  } catch (error) {
    if (error instanceof MembershipNotFoundError) throw new HandBackToRails("a role the seller context cannot resolve");
    throw error;
  }
  if (!allowed) {
    // PunditAuthorization#default_user_not_authorized redirects a request that is not JSON.
    if (requestFormat(input.request) !== "json") throw new HandBackToRails("a refused request that is not JSON");
    const error = user === null || sellerContext.user === null ? NOT_ALLOWED : notAllowedMessage(sellerContext);
    return { ...jsonResponse({ success: false, error }, UNAUTHORIZED, true), rescued: true };
  }

  const commentRecord = (comment: { author_id: bigint | null }): CommentContextRecord => ({
    comment: { author_id: comment.author_id, purchase_id: null, commentable_seller_id: sellerId },
    commentable: null,
    purchase: null,
  });
  const permits = (check: (record: CommentContextRecord) => boolean) => (comment: { author_id: bigint | null }) => {
    try {
      return check(commentRecord(comment));
    } catch (error) {
      if (error instanceof MembershipNotFoundError)
        throw new HandBackToRails("a role the seller context cannot resolve");
      throw error;
    }
  };
  const pageNumber = Math.max(typeof page === "string" ? rubyToI(page) : 0, 1);
  return jsonResponse(
    await paginatedComments(post, pageNumber, {
      editable: permits((record) => commentContextPolicy.update(sellerContext, record)),
      deletable: permits((record) => commentContextPolicy.destroy(sellerContext, record)),
    }),
    200,
    true,
  );
}

registerMutations({ method: "GET", pattern: "/posts/:post_id/comments", skipForgeryProtection: true, run: index });
