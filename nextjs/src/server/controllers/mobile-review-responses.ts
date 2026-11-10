// Api::Mobile::SalesController#destroy_review_response: the seller removes their reply to a review from the app.
// PUT on the same path (update_review_response) stays in Rails: its first reply emails the reviewer.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { findResponseOfReview, ProductReviewResponses } from "../models/product-review-response.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { fetchError, registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];

async function destroyReviewResponse(input: MobileInput, auth: MobileAuth | null) {
  // before_action :fetch_purchase: current_resource_owner.sales.find_by_external_id
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  const [purchase] =
    id === null
      ? []
      : await selectRows<{ id: bigint; subscription_id: bigint | null; flags: bigint | number | null }>(
          Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "subscription_id")}, ${column("purchases", "flags")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
        );
  if (!purchase) return fetchError("Could not find purchase");

  // Purchase#original_product_review reads the review of another purchase for a subscription's recurrence or a gift's sender.
  if (purchase.subscription_id !== null || PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase"))
    throw new NotPortedError("Purchase#original_product_review", "a subscription or gift sale");

  const [review] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("product_reviews", "id")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  const response = review ? await findResponseOfReview(review.id) : null;
  if (response === null) return fetchError("Could not find review response");

  // ProductReviewResponse has no before_destroy, so Rails' 422 branch for a refused destroy cannot happen.
  await ProductReviewResponses.destroyBang(response);
  return renderJson({ success: true });
}

registerMobile({
  method: "DELETE",
  pattern: "/mobile/sales/:id/review_response",
  scopes: MOBILE_API_SCOPES,
  run: destroyReviewResponse,
});
