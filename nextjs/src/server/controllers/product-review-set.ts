// ProductReviewsController#set (app/controllers/product_reviews_controller.rb): the buyer's review form.
//
// Ported: the refusals (a product the seller removed, a purchase that does not exist, a wrong email digest, a suspended purchaser, a
// purchase older than a year for a seller who closed reviews after one, a purchase that no longer allows a review) and `post_review`
// for a review without video that belongs to a purchase that is its own original.
// Handed to Rails before any write: a subscription or gift-sender purchase (the review lives on another purchase), video options, an
// existing review that carries a video, and parameters whose Ruby casts the port does not reproduce.
import { timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { findReviewOfPurchase, postReview, RestrictedOperationError } from "../models/product-review.ts";
import { allowsReview } from "../models/purchase.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isSuspended, Users, UserFlags } from "../models/user.ts";
import { emailDigest } from "../page-props/buyer/reviews.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { json } from "./seller-json.ts";

const NOT_AUTHORIZED = "Sorry, you are not authorized to review this product.";
const SOMETHING_WENT_WRONG = "Sorry, something went wrong.";
const PRODUCT_REMOVED = "Sorry, this product was removed by the seller.";

// `1.year.ago`
function oneYearAgo(): Date {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date;
}

// `ActiveSupport::SecurityUtils.secure_compare`
function secureCompare(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isEmptyObject = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;

// `set_params[:rating].to_i`
function submittedRating(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*[+-]?\d+(?!\d)/u.test(value)) return Number.parseInt(value, 10);
  throw new HandBackToRails("a rating Ruby's to_i reads differently");
}

function submittedMessage(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new HandBackToRails("a message that is not text");
}

// `ActiveModel::Type::Boolean.new.cast(set_params[:anonymous]) || false`, or :unchanged when the client omits the key.
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
function submittedAnonymous(params: MutationInput["params"]): boolean | "unchanged" {
  if (!("anonymous" in params)) return "unchanged";
  const value = params.anonymous;
  if (value === null || value === "") return false;
  if (typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isInteger(value)))
    return !FALSE_VALUES.has(value);
  throw new HandBackToRails("an anonymous flag Rails would filter out or cast differently");
}

// PUT /product_reviews/set
async function set(input: MutationInput): Promise<ActionResult> {
  const { link_id: permalink, purchase_id: purchaseId, purchase_email_digest: digest } = input.params;
  if (typeof permalink !== "string") throw new HandBackToRails("a link_id that is not text");
  // `Link.fetch(params[:link_id])`: a visible product by permalink.
  const [product] = await selectRows<{ id: bigint; user_id: bigint | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} AND ${column("links", "deleted_at")} IS NULL LIMIT 1`,
  );
  // fetch_visible_product is a before_action, so its answer skips the after_actions.
  if (product === undefined) return { ...json({ success: false, message: PRODUCT_REMOVED }), rescued: true };

  if (typeof purchaseId !== "string") throw new HandBackToRails("a purchase_id that is not text");
  if (digest !== undefined && digest !== null && typeof digest !== "string")
    throw new HandBackToRails("a digest that is not text");
  // `@product.sales.find_by_external_id!`: the action's own rescue turns the miss into the generic message.
  const id = decrypt(purchaseId);
  const purchase = id === null ? null : await db.purchase.findFirst({ where: { id: BigInt(id), link_id: product.id } });
  if (purchase === null) return json({ success: false, message: SOMETHING_WENT_WRONG });

  const expected = emailDigest(purchase);
  if (expected === null) throw new HandBackToRails("a purchase without an email, whose digest comparison raises");
  if (!secureCompare(expected, digest ?? "")) return json({ success: false, message: NOT_AUTHORIZED });

  if (purchase.purchaser_id !== null) {
    const purchaser = await db.user.findFirst({ where: { id: purchase.purchaser_id } });
    if (purchaser !== null && isSuspended(Users.load(purchaser)))
      return json({ success: false, message: NOT_AUTHORIZED });
  }

  const seller = product.user_id === null ? null : await db.user.findFirst({ where: { id: product.user_id } });
  if (seller === null) throw new HandBackToRails("a product without a seller");
  if (purchase.created_at === null) throw new HandBackToRails("a purchase without a creation time");
  if (purchase.created_at < oneYearAgo() && UserFlags.isSet(seller.flags, "disable_reviews_after_year"))
    return json({ success: false, message: SOMETHING_WENT_WRONG });

  if (purchase.subscription_id !== null || PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase"))
    throw new HandBackToRails("a purchase whose review lives on another purchase");
  const rating = submittedRating(input.params.rating);
  const message = submittedMessage(input.params.message);
  const anonymous = submittedAnonymous(input.params);
  if (
    input.params.video_options !== undefined &&
    input.params.video_options !== null &&
    !isEmptyObject(input.params.video_options)
  )
    throw new HandBackToRails("video options, which create or remove a review video");

  // `purchase.original_product_review`
  const existing = await findReviewOfPurchase(purchase.id);
  if (existing !== null) {
    const [video] = await selectRows(
      Prisma.sql`SELECT 1 AS present FROM ${table("product_review_videos")} WHERE ${column("product_review_videos", "product_review_id")} = ${existing.get("id")} AND ${column("product_review_videos", "deleted_at")} IS NULL LIMIT 1`,
    );
    if (video) throw new HandBackToRails("a review with a video");
  }
  // identity_only_change?: the form sends the same rating and message when the buyer only moves the identity radio.
  const identityOnly =
    existing !== null && rating === existing.get("rating") && (message ?? "") === (existing.get("message") ?? "");
  if (!allowsReview(purchase) && !identityOnly) {
    return json({
      success: false,
      message:
        existing !== null
          ? "You can no longer change this review, but you can still show it as Anonymous."
          : "This purchase is no longer eligible for a review.",
    });
  }

  try {
    const review = await postReview(purchase, product.id, { rating, message, anonymous });
    return json({ success: true, review });
  } catch (error) {
    if (error instanceof RecordInvalid) return json({ success: false, message: error.message });
    if (error instanceof RestrictedOperationError) return json({ success: false, message: SOMETHING_WENT_WRONG });
    throw error;
  }
}

registerMutations({ method: "PUT", pattern: "/product_reviews/set", json: true, run: set });
