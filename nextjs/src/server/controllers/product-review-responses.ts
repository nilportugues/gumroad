// ProductReviewResponsesController#update and #destroy (app/controllers/product_review_responses_controller.rb): the seller's reply to a review.
// The first reply of a review is created here too and queues the reviewer's email.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { findResponseOfReview, ProductReviewResponses } from "../models/product-review-response.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { productReviewResponsePolicy } from "../policies/product-review-response.ts";

import { type ActionResult, HandBackToRails, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, noContent, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const GIFT_SENDER_FLAG = 64;

type Loaded = { reviewId: bigint; productSellerId: bigint | null };

// before_actions: authenticate_user!, set_purchase (e404), set_product_review! (e404_json)
async function load(input: MutationInput): Promise<Loaded | ActionResult> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const id = decrypt(input.routeParams.id!);
  const [purchase] =
    id === null
      ? []
      : await selectRows<{ id: bigint; subscription_id: bigint | null; flags: bigint | number | null }>(
          Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!purchase) throw new RoutingError("Not Found");
  // original_product_review: a subscription's or a gift's review lives on another purchase.
  if (purchase.subscription_id !== null || (BigInt(purchase.flags ?? 0) & BigInt(GIFT_SENDER_FLAG)) !== 0n)
    throw new NotPortedError("Purchase#original_product_review", "a subscription or gift purchase");
  const [review] = await selectRows<{ id: bigint; link_id: bigint | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`product_reviews`.*")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  if (!review) return { ...notFoundJson(), rescued: true };
  const [product] =
    review.link_id === null
      ? []
      : await selectRows<{ user_id: bigint | null }>(
          Prisma.sql`SELECT ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} = ${review.link_id} LIMIT 1`,
        );
  if (!product) throw new NotPortedError("ProductReviewResponsePolicy", "a review without a product");
  return { reviewId: review.id, productSellerId: product.user_id };
}

const halted = (loaded: Loaded | ActionResult): loaded is ActionResult => "status" in loaded;

async function update(input: MutationInput): Promise<ActionResult> {
  const loaded = await load(input);
  if (halted(loaded)) return loaded;
  const denied = await authorizeJson(input, (context) =>
    authorize(productReviewResponsePolicy.update, context, loaded.productSellerId),
  );
  if (denied) return denied;

  const message = input.params.message;
  if (message !== undefined && message !== null && typeof message !== "string")
    throw new HandBackToRails("a message that is not a string");
  const response = await findResponseOfReview(loaded.reviewId);
  if (response === null) {
    // `@product_review.build_response`, saved by `update`.
    const created = await ProductReviewResponses.create({
      product_review_id: loaded.reviewId,
      user_id: BigInt(railsLoggedInUser(input.context)!.id),
      ...(message === undefined ? {} : { message }),
    });
    if (created.persisted) return noContent();
    return json({ error: created.errors.fullMessages().join(", ") }, UNPROCESSABLE_ENTITY);
  }
  const attributes = {
    user_id: BigInt(railsLoggedInUser(input.context)!.id),
    ...(message === undefined ? {} : { message }),
  };
  if (await ProductReviewResponses.update(response, attributes)) return noContent();
  return json({ error: response.errors.fullMessages().join(", ") }, UNPROCESSABLE_ENTITY);
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  const loaded = await load(input);
  if (halted(loaded)) return loaded;
  const denied = await authorizeJson(input, (context) =>
    authorize(productReviewResponsePolicy.destroy, context, loaded.productSellerId),
  );
  if (denied) return denied;

  const response = await findResponseOfReview(loaded.reviewId);
  if (response !== null) await ProductReviewResponses.destroyBang(response);
  return noContent();
}

registerMutations(
  ...["PUT", "PATCH"].map((method) => ({ method, pattern: "/product_review_responses/:id", json: true, run: update })),
  { method: "DELETE", pattern: "/product_review_responses/:id", json: true, run: destroy },
);
