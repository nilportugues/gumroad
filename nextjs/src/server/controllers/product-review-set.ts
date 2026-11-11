// ProductReviewsController#set (app/controllers/product_reviews_controller.rb): the buyer's review form.
//
// Ported: the refusals that come before the review is touched: a product the seller removed, a purchase that does not exist, a wrong
// email digest, a suspended purchaser and a purchase older than a year for a seller who closed reviews after one.
// Handed to Rails before any write: everything after them (the eligibility verdicts and `post_review`, which saves the review, its
// videos and the product's review stats).
import { timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isSuspended, Users, UserFlags } from "../models/user.ts";
import { emailDigest } from "../page-props/buyer/reviews.ts";

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

  throw new HandBackToRails("posting a review, which saves it and the product's review stats");
}

registerMutations({ method: "PUT", pattern: "/product_reviews/set", json: true, run: set });
