// Api::V2::ProductReviewsController (app/controllers/api/v2/product_reviews_controller.rb)
import type { Link } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { error400, loadProduct, PUBLIC_READ_SCOPES, registerApiV2, renderResponse } from "./base.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";

const RESULTS_PER_PAGE = 100;

type ReviewRow = {
  id: bigint;
  rating: number | null;
  message: string | null;
  anonymous: boolean | number | null;
  purchase_id: bigint | null;
  created_at: Date;
  created_usec: string;
  purchaser_name: string | null;
  purchaser_username: string | null;
  purchaser_id: bigint | null;
  gift_receiver: bigint | number | null;
  street_address: string | null;
};

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const iso8601 = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;

registerApiV2({
  method: "GET",
  pattern: "/v2/products/:link_id/reviews",
  scopes: PUBLIC_READ_SCOPES,
  before: loadProduct("link_id"),
  async run(input) {
    const product: Link = input.state.product;
    const conditions: Prisma.Sql[] = [
      Prisma.sql`${column("product_reviews", "link_id")} = ${product.id}`,
      Prisma.sql`${column("product_reviews", "deleted_at")} IS NULL`,
      Prisma.sql`(product_reviews.has_message = true OR product_review_videos.id IS NOT NULL)`,
    ];
    const pageKey = input.params.page_key;
    if (pageKey !== undefined && pageKey !== null && pageKey !== "") {
      const decoded = typeof pageKey === "string" ? decodePageKey(pageKey) : null;
      if (decoded === null) return error400("Invalid page_key.");
      conditions.push(Prisma.sql`(product_reviews.created_at < ${decoded.at}) OR (product_reviews.created_at = ${decoded.at} AND product_reviews.id < ${decoded.id})`);
    }

    const rows = await selectRows<ReviewRow>(Prisma.sql`
      SELECT ${column("product_reviews", "id")}, product_reviews.rating, product_reviews.message, product_reviews.anonymous, product_reviews.purchase_id, product_reviews.created_at,
        DATE_FORMAT(product_reviews.created_at, ${USEC_FORMAT}) AS created_usec,
        purchasers.name AS purchaser_name, purchasers.username AS purchaser_username, purchasers.id AS purchaser_id,
        (CASE WHEN ${PurchaseFlags.condition("is_gift_receiver_purchase", true)} THEN 1 ELSE 0 END) AS gift_receiver, purchases.street_address
      FROM ${table("product_reviews")}
      LEFT OUTER JOIN product_review_videos ON product_review_videos.product_review_id = product_reviews.id AND product_review_videos.deleted_at IS NULL AND product_review_videos.approval_status = 'approved'
      LEFT OUTER JOIN purchases ON purchases.id = product_reviews.purchase_id
      LEFT OUTER JOIN users purchasers ON purchasers.id = purchases.purchaser_id
      WHERE ${Prisma.join(conditions.map((condition) => Prisma.sql`(${condition})`), " AND ")}
      ORDER BY product_reviews.created_at DESC, product_reviews.id DESC
      LIMIT ${RESULTS_PER_PAGE + 1}`);

    const page = rows.slice(0, RESULTS_PER_PAGE);
    const additional = rows.length > RESULTS_PER_PAGE ? paginationInfo(input.request, page.at(-1)!) : {};
    const responses = await selectRows<{ product_review_id: bigint; message: string | null; created_at: Date }>(
      page.length === 0
        ? Prisma.sql`SELECT NULL AS product_review_id, NULL AS message, NULL AS created_at FROM dual WHERE 1 = 0`
        : Prisma.sql`SELECT product_review_id, message, created_at FROM product_review_responses WHERE product_review_id IN (${Prisma.join(page.map((row) => row.id))}) ORDER BY id`,
    );

    const reviews = page.map((review) => {
      // ProductReview#rater_name: the account name unless the buyer chose to be anonymous (or has no account, or got it as a gift to ship).
      const giftReceiverWithShipping = Number(review.gift_receiver) === 1 && present(review.street_address);
      const accountName = review.purchaser_id !== null && !giftReceiverWithShipping ? (present(review.purchaser_name) ? review.purchaser_name : present(review.purchaser_username) ? review.purchaser_username : null) : null;
      const response = responses.find((candidate) => candidate.product_review_id === review.id);
      return {
        id: encrypt(review.id),
        rating: review.rating,
        message: review.message,
        created_at: iso8601(review.created_at),
        purchase_id: review.purchase_id === null ? null : encrypt(review.purchase_id),
        rater_name: !review.anonymous && accountName !== null ? accountName : "Anonymous",
        response: response ? { message: response.message, created_at: iso8601(response.created_at) } : null,
      };
    });
    return renderResponse(true, { product_reviews: reviews, ...additional });
  },
});
