// app/models/product_review.rb and Purchase::Reviews#post_review (ProductReview::UpdateService), for a review without a video:
// the rating and message the buyer submits, the product's review stat that follows the rating, and the seller's notice.
// A review that carries video options is not ported (ProductReviewsController#set hands it to Rails).
import { Prisma, type ProductReview, type Purchase } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { isAdult } from "./adult-keyword-detector.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { bumpReputationSummaryVersion, enqueueIndexUpdateForProduct } from "./link.ts";
import { allowsReviewToBeCounted } from "./purchase.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { validatesInclusionOf, validatesUniquenessOf, isBlank } from "./runtime/validators.ts";
import { castRow, column, execute, quoteName, selectRows, table } from "./sql.ts";
import { UserFlags } from "./user.ts";

export const PRODUCT_RATING_RANGE = [1, 2, 3, 4, 5] as const;
// ProductReview::SELLER_NOTIFICATION_DELAY
const SELLER_NOTIFICATION_DELAY_SECONDS = 5 * 60;
// ProductReviewStat::RATING_COLUMN_MAP
const RATING_COLUMN: Record<number, string> = {
  1: "ratings_of_one_count",
  2: "ratings_of_two_count",
  3: "ratings_of_three_count",
  4: "ratings_of_four_count",
  5: "ratings_of_five_count",
};
const REVIEW_STAT_FEATURE_FIELDS = ["average_rating", "reviews_count", "is_recommendable"];

// ProductReview::RestrictedOperationError
export class RestrictedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedOperationError";
  }
}

async function rowExists(tableName: string, id: unknown): Promise<boolean> {
  if (id == null) return false;
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS present FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return row !== undefined;
}

// `validates_presence_of :purchase` and `:link`
const associationPresent = (
  name: "purchase" | "link",
  tableName: string,
  key: "purchase_id" | "link_id",
): Callback<ProductReview> => ({
  name: `validates_presence_of ${name}`,
  async run(record) {
    if (!(await rowExists(tableName, record.get(key)))) record.errors.add(name, "blank");
  },
});

async function purchaseOf(purchaseId: bigint | null): Promise<Purchase> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`,
  );
  return castRow<Purchase>("Purchase", row!);
}

// The ProductReviewStat row of a product, created on the first rating (`Product::ReviewStat#update_review_stat_via_rating_change`).
// The insert is a no-op upsert so that two first reviews queue on the row's lock instead of deadlocking on a shared one.
async function applyRatingChange(
  productId: bigint,
  sellerId: bigint | null,
  oldRating: number | null,
  newRating: number | null,
  now: Date,
): Promise<void> {
  const stamp = now.toISOString().slice(0, 19).replace("T", " ");
  const [existing] = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${column("product_review_stats", "id")} FROM ${table("product_review_stats")} WHERE ${column("product_review_stats", "link_id")} = ${productId} LIMIT 1`,
  );
  if (!existing) {
    await execute(
      Prisma.sql`INSERT INTO ${table("product_review_stats")} (${Prisma.raw("`link_id`, `created_at`, `updated_at`")}) VALUES (${productId}, ${stamp}, ${stamp}) ON DUPLICATE KEY UPDATE ${Prisma.raw("`link_id` = `link_id`")}`,
    );
  }
  const [stat] = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${column("product_review_stats", "id")} FROM ${table("product_review_stats")} WHERE ${column("product_review_stats", "link_id")} = ${productId} LIMIT 1${existing ? Prisma.empty : Prisma.raw(" FOR UPDATE")}`,
  );
  const assignment =
    oldRating === null
      ? `${RATING_COLUMN[newRating!]} = ${RATING_COLUMN[newRating!]} + 1`
      : newRating === null
        ? `${RATING_COLUMN[oldRating]} = ${RATING_COLUMN[oldRating]} - 1`
        : `${RATING_COLUMN[oldRating]} = ${RATING_COLUMN[oldRating]} - 1, ${RATING_COLUMN[newRating]} = ${RATING_COLUMN[newRating]} + 1`;
  const columns = Object.values(RATING_COLUMN);
  const total = Object.entries(RATING_COLUMN)
    .map(([value, name]) => `${name} * ${value}`)
    .join(" + ");
  await execute(
    Prisma.sql`UPDATE ${table("product_review_stats")} SET ${Prisma.raw(`${assignment}, reviews_count = ${columns.join(" + ")}, average_rating = ROUND((${total}) / reviews_count, 1)`)}, ${column("product_review_stats", "updated_at")} = ${stamp} WHERE ${column("product_review_stats", "id")} = ${stat!.id}`,
  );
  if (sellerId === null) throw new TypeError("undefined method 'bump_reputation_summary_version' for nil");
  await bumpReputationSummaryVersion(sellerId);
  await enqueueIndexUpdateForProduct(productId, REVIEW_STAT_FEATURE_FIELDS);
}

async function sellerOf(linkId: bigint | null): Promise<{ id: bigint; flags: bigint | null } | null> {
  const [row] = await selectRows<{ id: bigint; flags: bigint | null }>(
    Prisma.sql`SELECT ${column("users", "id")}, ${column("users", "flags")} FROM ${table("users")} INNER JOIN ${table("links")} ON ${column("links", "user_id")} = ${column("users", "id")} WHERE ${column("links", "id")} = ${linkId} LIMIT 1`,
  );
  return row ?? null;
}

async function notifySeller(reviewId: bigint, wait: boolean): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: "ContactingCreatorMailer",
      method: "review_submitted",
      args: [Number(reviewId)],
      ...(wait ? { waitSeconds: SELLER_NOTIFICATION_DELAY_SECONDS } : {}),
    },
    mailRoute("ContactingCreatorMailer", "review_submitted"),
  );
}

export const ProductReviews = defineModel<ProductReview>({
  rubyClass: "ProductReview",
  prismaModel: "ProductReview",
  delegate: (tx) => ({
    // `has_message` is generated by MySQL, which Prisma's create still demands a value for.
    async create({ data }) {
      const entries = Object.entries(data).filter(([name]) => name !== "has_message");
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ${table("product_reviews")} (${Prisma.join(entries.map(([name]) => Prisma.raw(quoteName(name))))}) VALUES (${Prisma.join(entries.map(([, value]) => value))})`,
      );
      const [inserted] = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
      return { id: inserted!.id } as ProductReview;
    },
    update: ({ where, data }) => tx.productReview.update({ where: { id: where.id as bigint }, data }),
    delete: ({ where }) => tx.productReview.delete({ where: { id: where.id as bigint } }),
  }),
  validations: [
    associationPresent("purchase", "purchases", "purchase_id"),
    associationPresent("link", "links", "link_id"),
    validatesUniquenessOf<ProductReview>("product_reviews", ["purchase_id"], {}),
    validatesInclusionOf<ProductReview>(["rating"], { in: PRODUCT_RATING_RANGE, message: "Invalid product rating." }),
    {
      name: "message_cannot_contain_adult_keywords",
      run(record) {
        if (record.attributeChanged("message") && isAdult(record.get("message")))
          record.errors.add("base", "Adult keywords are not allowed");
      },
    },
  ],
  beforeCreate: [
    {
      name: "creating a review needs a purchase that counts",
      async run(record) {
        if (allowsReviewToBeCounted(await purchaseOf(record.get("purchase_id")))) return;
        throw new RestrictedOperationError("Creating a review for an invalid purchase is not handled");
      },
    },
  ],
  beforeUpdate: [
    {
      name: "a rating needs a purchase that counts",
      async run(record) {
        if (!record.attributeChanged("rating") || allowsReviewToBeCounted(await purchaseOf(record.get("purchase_id"))))
          return;
        throw new RestrictedOperationError("A rating on a invalid purchase can't be changed");
      },
    },
  ],
  afterSave: [
    {
      name: "update_product_review_stat",
      async run(record, ctx) {
        const change = record.savedChanges.rating;
        if (!change) return;
        const seller = await sellerOf(record.get("link_id"));
        await applyRatingChange(
          record.get("link_id")!,
          seller?.id ?? null,
          change[0] as number | null,
          change[1] as number | null,
          (ctx.now ?? (() => new Date()))(),
        );
      },
    },
  ],
  afterCommit: [
    {
      name: "notify_seller_of_new_review",
      on: "create",
      async run(record) {
        const seller = await sellerOf(record.get("link_id"));
        if (seller === null) throw new TypeError("undefined method 'disable_reviews_email?' for nil");
        if (UserFlags.isSet(seller.flags, "disable_reviews_email")) return;
        await notifySeller(record.get("id"), isBlank(record.get("message")));
      },
    },
    {
      name: "notify_seller_of_arrived_message",
      on: "update",
      if: (record) => {
        const change = record.savedChanges.message;
        return change !== undefined && isBlank(change[0]) && !isBlank(record.get("message"));
      },
      async run(record) {
        const seller = await sellerOf(record.get("link_id"));
        if (seller === null) throw new TypeError("undefined method 'disable_reviews_email?' for nil");
        if (UserFlags.isSet(seller.flags, "disable_reviews_email")) return;
        // seller_notified?
        if (record.get("seller_notified_at") != null) return;
        await notifySeller(record.get("id"), false);
      },
    },
  ],
});

// `purchase.original_product_review`, for a purchase that is its own original: has_one, with deleted reviews included.
export async function findReviewOfPurchase(purchaseId: bigint) {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_reviews`.*")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${purchaseId} LIMIT 1`,
  );
  return row ? ProductReviews.load(castRow<ProductReview>("ProductReview", row)) : null;
}

export type PostedReview = { anonymous: boolean; rating: number | null; message: string | null; video: null };

// Purchase#post_review: `original_product_review || build_product_review(link:)`, saved under the review's row lock.
export async function postReview(
  purchase: { id: bigint },
  productId: bigint,
  attributes: { rating: number; message: string | null; anonymous: boolean | "unchanged" },
): Promise<PostedReview> {
  const { anonymous, ...submitted } = attributes;
  const assigned = anonymous === "unchanged" ? submitted : { ...submitted, anonymous };
  const saved = await transaction(async () => {
    const existing = await findReviewOfPurchase(purchase.id);
    if (existing === null)
      return ProductReviews.createBang({ purchase_id: purchase.id, link_id: productId, ...assigned });
    return ProductReviews.withLock(existing, () => ProductReviews.updateBang(existing, assigned));
  });
  const [row] = await selectRows<ProductReview>(
    Prisma.sql`SELECT ${Prisma.raw("`product_reviews`.*")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "id")} = ${saved.get("id")} LIMIT 1`,
  );
  return {
    anonymous: row!.anonymous != null && Number(row!.anonymous) !== 0,
    rating: row!.rating,
    message: row!.message,
    video: null,
  };
}
