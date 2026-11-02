// app/models/product_review_response.rb, for the seller's edits (ProductReviewResponsesController). Creating a response
// sends the reviewer an email (after_create_commit: CustomerMailer.review_response.deliver_later), which stays in Ruby.
import { Prisma, type ProductReviewResponse } from "@prisma/client";

import { defineModel, type Callback } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

// `belongs_to :user` and `belongs_to :product_review` are required: "must exist".
const belongsToRequired = (name: "user" | "product_review", tableName: string, foreignKey: "user_id" | "product_review_id"): Callback<ProductReviewResponse> => ({
  name: `belongs_to ${name}`,
  async run(record) {
    const key = record.get(foreignKey);
    const [row] = key === null ? [] : await selectRows(Prisma.sql`SELECT 1 AS present FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${key} LIMIT 1`);
    if (!row) record.errors.add(name, "required");
  },
});

export const ProductReviewResponses = defineModel<ProductReviewResponse>({
  rubyClass: "ProductReviewResponse",
  prismaModel: "ProductReviewResponse",
  delegate: (tx) => tx.productReviewResponse as never,
  validations: [belongsToRequired("user", "users", "user_id"), belongsToRequired("product_review", "product_reviews", "product_review_id"), validatesPresenceOf<ProductReviewResponse>(["message"])],
});

// `product_review.response`: has_one with no ORDER BY.
export async function findResponseOfReview(productReviewId: bigint | number): Promise<ReturnType<typeof ProductReviewResponses.load> | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_review_responses`.*")} FROM ${table("product_review_responses")} WHERE ${column("product_review_responses", "product_review_id")} = ${productReviewId} LIMIT 1`,
  );
  return row ? ProductReviewResponses.load(castRow<ProductReviewResponse>("ProductReviewResponse", row)) : null;
}
