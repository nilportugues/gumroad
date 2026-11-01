// ReviewsPresenter#reviews_props for ReviewsController#index. A review with a video is not ported
// (ProductReviewVideo#video_file.thumbnail_url goes through Active Storage).
import { createHmac } from "node:crypto";

import { Prisma, type Link, type Purchase, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { getRequiredConfig } from "../../infra/config.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { LinkFlags } from "../../models/link.ts";
import { UserFlags } from "../../models/user.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { thumbnailUrl } from "./products.ts";
import { productLongUrl, profileUrl } from "./users.ts";

const PURCHASES = "purchases";
const COUNTS_REVIEWS_STATES = ["successful", "gift_receiver_purchase_successful", "not_charged"];
const LIBRARY_RECOMMENDER = "library";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// Purchase#email_digest: an HMAC of "id:email" under OBFUSCATE_IDS_CIPHER_KEY, urlsafe base64 with padding.
export function emailDigest(purchase: Pick<Purchase, "id" | "email">): string | null {
  if (!present(purchase.email)) return null;
  return createHmac("sha256", getRequiredConfig("OBFUSCATE_IDS_CIPHER_KEY")).update(`${purchase.id}:${purchase.email}`).digest("base64url").padEnd(44, "=");
}

// Purchase#rater_account_name
export function raterAccountName(purchase: Purchase, purchaser: User | null): string | null {
  const giftReceiverWithShippingAddress = PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase") && present(purchase.street_address);
  if (!purchaser || giftReceiverWithShippingAddress) return null;
  return present(purchaser.name) ? purchaser.name : present(purchaser.username) ? purchaser.username : null;
}

// `Purchase.allowing_reviews_to_be_counted`
const allowingReviewsToBeCounted = Prisma.sql`${column(PURCHASES, "purchase_state")} IN (${Prisma.join(COUNTS_REVIEWS_STATES)})
  AND (purchases.purchase_state != 'not_charged' OR ${PurchaseFlags.condition("is_free_trial_purchase", true)})
  AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)
  AND ((purchases.stripe_partially_refunded IS NULL OR purchases.stripe_partially_refunded = false) OR ${PurchaseFlags.condition("is_bundle_product_purchase", false)})
  AND purchases.chargeback_date IS NULL
  AND (purchases.subscription_id IS NULL OR ${PurchaseFlags.condition("is_original_subscription_purchase", true)} OR ${PurchaseFlags.condition("is_gift_receiver_purchase", true)})
  AND ${PurchaseFlags.condition("is_gift_sender_purchase", false)}
  AND ${PurchaseFlags.condition("should_exclude_product_review", false)}
  AND (${PurchaseFlags.condition("is_access_revoked", false)} OR (purchases.purchase_state = 'successful' AND purchases.price_cents > 0 AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)))
  AND ${PurchaseFlags.condition("is_commission_completion_purchase", false)}`;

async function productProps(product: Link, seller: User) {
  return {
    name: product.name,
    url: productLongUrl(product, seller, { recommendedBy: LIBRARY_RECOMMENDER }),
    permalink: product.unique_permalink,
    thumbnail_url: await thumbnailUrl(product.id),
    native_type: product.native_type,
    // A bundle buyer sees the bundle itself plus each bundled product as separate
    // reviewable rows; the flag lets the page label the bundle row so the list
    // doesn't look like duplicates.
    is_bundle: LinkFlags.isSet(product.flags, "is_bundle"),
    available: product.deleted_at === null,
    seller: { name: sellerDisplayName(seller), url: profileUrl(seller) },
  };
}

// User#display_name
function sellerDisplayName(user: User): string | null {
  if (present(user.name)) return user.name;
  const handle = present(user.username) ? user.username : user.external_id;
  if (present(handle)) return handle;
  return present(user.unconfirmed_email) ? user.unconfirmed_email : present(user.email) ? user.email : null;
}

export async function reviewsProps(user: User, now = new Date()) {
  const reviewRows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_reviews`.*")} FROM ${table("product_reviews")} INNER JOIN ${table(PURCHASES)} ON ${column("product_reviews", "purchase_id")} = ${column(PURCHASES, "id")} WHERE ${column(PURCHASES, "purchaser_id")} = ${user.id} AND ${column("product_reviews", "deleted_at")} IS NULL ORDER BY ${column(PURCHASES, "id")} ASC, ${column("product_reviews", "id")} ASC`,
  );
  const reviews = [];
  for (const row of reviewRows) {
    const review = castRow<import("@prisma/client").ProductReview>("ProductReview", row);
    const [purchase, product, video] = await Promise.all([
      db.purchase.findUniqueOrThrow({ where: { id: review.purchase_id! } }),
      db.link.findUniqueOrThrow({ where: { id: review.link_id! } }),
      db.productReviewVideo.findFirst({ where: { product_review_id: review.id, deleted_at: null } }),
    ]);
    if (video) throw new NotPortedError("ProductReviewPresenter#video_props (Active Storage)");
    const seller = await db.user.findUniqueOrThrow({ where: { id: product.user_id! } });
    reviews.push({
      anonymous: review.anonymous === true,
      rating: review.rating,
      message: review.message,
      video: null,
      id: encrypt(review.id),
      purchase_id: encrypt(review.purchase_id!),
      purchase_email_digest: emailDigest(purchase),
      account_name: raterAccountName(purchase, user),
      product: await productProps(product, seller),
    });
  }

  const purchaseRows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table(PURCHASES)} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column(PURCHASES, "link_id")} LEFT OUTER JOIN ${table("product_reviews")} ON ${column("product_reviews", "purchase_id")} = ${column(PURCHASES, "id")} WHERE ${column(PURCHASES, "purchaser_id")} = ${user.id} AND ${PurchaseFlags.condition("is_deleted_by_buyer", false)} AND ${allowingReviewsToBeCounted} AND ${column("links", "deleted_at")} IS NULL AND ${column("product_reviews", "id")} IS NULL ORDER BY ${column(PURCHASES, "created_at")} DESC, ${column(PURCHASES, "id")} DESC`,
  );
  const purchases = [];
  for (const row of purchaseRows) {
    const purchase = castRow<Purchase>("Purchase", row);
    const [product, seller] = await Promise.all([db.link.findUniqueOrThrow({ where: { id: purchase.link_id! } }), db.user.findUniqueOrThrow({ where: { id: purchase.seller_id! } })]);
    if (UserFlags.isSet(seller.flags, "disable_reviews_after_year") && !((purchase.created_at?.getTime() ?? 0) > now.getTime() - ONE_YEAR_MS)) continue;
    const productSeller = await db.user.findUniqueOrThrow({ where: { id: product.user_id! } });
    purchases.push({
      id: encrypt(purchase.id),
      email_digest: emailDigest(purchase),
      account_name: raterAccountName(purchase, user),
      product: await productProps(product, productSeller),
    });
  }
  return { reviews, purchases };
}
