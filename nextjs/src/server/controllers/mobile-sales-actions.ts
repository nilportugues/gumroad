// The rest of Api::Mobile::SalesController: the member and collection actions that are not a plain read of one sale.
//
// Each action runs the checks that answer without writing, sending mail or calling a processor, and hands the request to Rails whole
// (before any write) once it gets past them. Served here: the 404 of `fetch_purchase` for every member action,
// `product_purchases` of a sale that is not a bundle, `missed_posts` (the posts the customer has not been sent), `blob_url`'s 404, `update`'s two gift 422s, `variant`'s 404s, `send_post`'s 401/404/422 and `update_review_response`'s 404.
// Handed back: refund (moves money), mark_as_shipped (mail), resend_ping (webhook), a change_can_contact that Node
// cannot prove (models/purchase-contact-writes.ts) and update's saves (Purchase callbacks that mirror the opt-out into the newsletter cutover and the audience), a variant swap, a post
// email, a review reply on a subscription or gift sale, and blob_url's success (a CDN URL for the blob's storage service).
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { findResponseOfReview, ProductReviewResponses } from "../models/product-review-response.ts";
import { changeCanContact } from "../models/purchase-contact-writes.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { eligibleToSendEmails } from "../models/user-email-eligibility.ts";
import { missedPosts as missedPostsOf } from "../page-props/customers/customer-details.ts";
import type { Row } from "../page-props/customers/customers.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { present } from "../search/ruby-params.ts";

import { toSentence } from "./api-v2/base.ts";
import { HandBackToRails } from "./application-controller.ts";
import {
  fetchError,
  registerMobile,
  renderJson,
  UNAUTHORIZED,
  UNPROCESSABLE_ENTITY,
  NOT_FOUND,
  type MobileAuth,
  type MobileInput,
} from "./mobile-api.ts";
import { setPurchase } from "./purchase-access-writes.ts";
import { resendReceipt } from "./purchase-resend-receipt.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const SKUS_ENABLED_FLAG = 1n << 9n;
const SALE_PING_DELAY_SECONDS = 10;

type Sale = {
  id: bigint;
  link_id: bigint | null;
  seller_id: bigint | null;
  subscription_id: bigint | null;
  flags: bigint | number | null;
  can_contact: boolean | number | bigint | null;
};

const isTrue = (value: unknown) => value === true || value === 1 || value === 1n;
const isString = (value: unknown): value is string => typeof value === "string";

// before_action :fetch_purchase: current_resource_owner.sales.find_by_external_id
async function findSale(input: MobileInput, auth: MobileAuth | null): Promise<Sale | null> {
  const id = isString(input.params.id) ? decrypt(input.params.id) : null;
  if (id === null) return null;
  const [sale] = await selectRows<Sale>(
    Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "link_id")}, ${column("purchases", "seller_id")}, ${column("purchases", "subscription_id")}, ${column("purchases", "flags")}, ${column("purchases", "can_contact")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${BigInt(id)} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
  );
  return sale ?? null;
}

// A member action: fetch_purchase, then `run`. The before_action's render halts the chain.
const memberAction =
  (run: (sale: Sale, input: MobileInput, auth: MobileAuth) => Promise<ReturnType<typeof renderJson>>) =>
  async (input: MobileInput, auth: MobileAuth | null) => {
    const sale = await findSale(input, auth);
    if (sale === null) return fetchError("Could not find purchase");
    return run(sale, input, auth!);
  };

const handBack = (what: string) =>
  memberAction(() => {
    throw new HandBackToRails(what);
  });

// SalesController#resend_receipt: a sale with no email to send to is `Could not find receipt`; the enqueue is the only write.
const resendSaleReceipt = memberAction(async (_sale, input) => {
  const outcome = await resendReceipt(await setPurchase(input.params.id as string), { rescueEnqueueError: false });
  return outcome === "missing" ? fetchError("Could not find receipt") : renderJson({ success: true });
});

// SalesController#change_can_contact: no authorization beyond `fetch_purchase`; the save is Node's for a plain purchase.
const changeSaleCanContact = memberAction(async (_sale, input) => {
  await changeCanContact(await setPurchase(input.params.id as string), input.params.can_contact);
  return renderJson({ success: true });
});

const rowExists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;

// Purchase#product_purchases is the bundle's `BundleProductPurchase` records: a sale that is not a bundle has none.
const productPurchases = memberAction((sale) => {
  if (PurchaseFlags.isSet(sale.flags, "is_bundle_purchase"))
    throw new HandBackToRails("the customers of a bundle's product purchases");
  return Promise.resolve(renderJson({ success: true, product_purchases: [] }));
});

// CustomerPresenter#missed_posts, which the customers page reads too (page-props/customers/customer-details.ts): it hands back what
// its filters cannot evaluate.
const missedPosts = memberAction(async (sale) => {
  const [purchase] = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${sale.id} LIMIT 1`,
  );
  if (purchase === undefined) throw new HandBackToRails("a sale that vanished");
  return renderJson({ success: true, missed_posts: await missedPostsOf(purchase) });
});

// `Purchase#gift`: the sender's gift for a sender's purchase, the receiver's for a receiver's.
async function giftOf(sale: Sale) {
  const owner = PurchaseFlags.isSet(sale.flags, "is_gift_sender_purchase")
    ? "gifter_purchase_id"
    : PurchaseFlags.isSet(sale.flags, "is_gift_receiver_purchase")
      ? "giftee_purchase_id"
      : null;
  if (owner === null) return null;
  const [gift] = await selectRows<{ giftee_purchase_id: bigint | null }>(
    Prisma.sql`SELECT ${column("gifts", "giftee_purchase_id")} FROM ${table("gifts")} WHERE ${column("gifts", owner)} = ${sale.id} LIMIT 1`,
  );
  return gift ?? null;
}

// SalesController#update. The assignments before the gift checks stay in memory, so only a request that fails a check is answered here.
const update = memberAction(async (sale, input) => {
  const { email, country, giftee_email: gifteeEmail } = input.params;
  for (const value of [email, country, gifteeEmail]) {
    if (present(value) && !isString(value)) throw new HandBackToRails("a param that is not a string");
  }
  if (!present(gifteeEmail)) throw new HandBackToRails("an update that saves the purchase");
  const gift = await giftOf(sale);
  if (gift === null) return renderJson({ success: false, message: "This sale is not a gift" }, UNPROCESSABLE_ENTITY);
  const giftee =
    gift.giftee_purchase_id === null
      ? false
      : await rowExists(
          Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${gift.giftee_purchase_id} LIMIT 1`,
        );
  if (!giftee)
    return renderJson({ success: false, message: "This gift is missing a giftee purchase" }, UNPROCESSABLE_ENTITY);
  throw new HandBackToRails("an update of a gift");
});

// SalesController#variant: the lookups of Purchase::VariantUpdaterService#perform that end in `false` (a 404) before it writes.
const variant = memberAction(async (sale, input) => {
  if (sale.link_id === null) return renderJson({ success: false, message: "Could not find product" }, NOT_FOUND);
  const variantId = input.params.variant_id;
  if (variantId !== undefined && variantId !== null && !isString(variantId))
    throw new HandBackToRails("a variant_id that is not a string");
  const notFound = renderJson({ success: false, message: "Variant not found" }, NOT_FOUND);
  const id = isString(variantId) ? decrypt(variantId) : null;
  if (id === null) return notFound;

  const [product] = await selectRows<{ flags: bigint | number | null }>(
    Prisma.sql`SELECT ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${sale.link_id} LIMIT 1`,
  );
  if (product === undefined) throw new HandBackToRails("a sale whose product row is missing");
  const skusEnabled = (BigInt(product.flags ?? 0) & SKUS_ENABLED_FLAG) !== 0n;
  const [row] = await selectRows<{ link_id: bigint | null; variant_category_id: bigint | null }>(
    Prisma.sql`SELECT ${column("base_variants", "link_id")}, ${column("base_variants", "variant_category_id")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${BigInt(id)} AND ${column("base_variants", "type")} = ${skusEnabled ? "Sku" : "Variant"} LIMIT 1`,
  );
  if (row === undefined) return notFound;
  if (skusEnabled) {
    if (row.link_id === null || BigInt(row.link_id) !== BigInt(sale.link_id)) return notFound;
    throw new HandBackToRails("a variant swap");
  }
  if (row.variant_category_id === null) throw new HandBackToRails("a variant without a category");
  const [category] = await selectRows<{ link_id: bigint | null }>(
    Prisma.sql`SELECT ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "id")} = ${row.variant_category_id} LIMIT 1`,
  );
  if (category === undefined) throw new HandBackToRails("a variant whose category row is missing");
  // `variant_category.link != product`
  if (category.link_id === null || BigInt(category.link_id) !== BigInt(sale.link_id)) return notFound;
  throw new HandBackToRails("a variant swap");
});

// SalesController#send_post
const sendPost = memberAction(async (sale, input, auth) => {
  if (!(await eligibleToSendEmails(auth.owner)))
    return renderJson({ success: false, message: "You are not eligible to resend this email." }, UNAUTHORIZED);
  const postId = input.params.post_id;
  if (postId !== undefined && postId !== null && !isString(postId))
    throw new HandBackToRails("a post_id that is not a string");
  const id = isString(postId) ? decrypt(postId) : null;
  const postExists =
    id !== null &&
    (await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "id")} = ${BigInt(id)} AND ${column("installments", "seller_id")} = ${auth.owner.id} AND ${column("installments", "deleted_at")} IS NULL LIMIT 1`,
    ));
  if (!postExists) return renderJson({ success: false, message: "Could not find post" }, NOT_FOUND);
  if (!isTrue(sale.can_contact))
    return renderJson(
      { success: false, message: "This customer has unsubscribed from your emails." },
      UNPROCESSABLE_ENTITY,
    );
  throw new HandBackToRails("a post email");
});

// A gift sender's review is the giftee purchase's and a membership's is its original purchase's (Purchase#original_product_review). Only
// the absence of any review there is answered here: a gift with no giftee purchase, and a membership none of whose purchases has one.
async function isReviewMissingOnAnotherPurchase(sale: Sale): Promise<boolean> {
  if (PurchaseFlags.isSet(sale.flags, "is_gift_sender_purchase")) {
    const gifts = await selectRows<{ giftee_purchase_id: bigint | null }>(
      Prisma.sql`SELECT ${column("gifts", "giftee_purchase_id")} FROM ${table("gifts")} WHERE ${column("gifts", "gifter_purchase_id")} = ${sale.id} LIMIT 2`,
    );
    if (gifts.length > 1) return false;
    const giftee = gifts[0]?.giftee_purchase_id;
    if (giftee === undefined || giftee === null) return true;
    return !(await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${giftee} LIMIT 1`,
    ));
  }
  return !(await rowExists(
    Prisma.sql`SELECT 1 FROM ${table("product_reviews")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("product_reviews", "purchase_id")} WHERE ${column("purchases", "subscription_id")} = ${sale.subscription_id} LIMIT 1`,
  ));
}

// SalesController#update_review_response. `Purchase#original_product_review` reads another purchase's review for a subscription's
// recurrence or a gift's sender. The reply is `review.response || review.build_response`, saved with the acting user; only its
// creation mails the reviewer (ProductReviewResponse's after_create_commit).
const updateReviewResponse = memberAction(async (sale, input, auth) => {
  if (sale.subscription_id !== null || PurchaseFlags.isSet(sale.flags, "is_gift_sender_purchase")) {
    if (!(await isReviewMissingOnAnotherPurchase(sale)))
      throw new HandBackToRails("the review of a subscription or gift sale");
    return renderJson({ success: false, message: "Could not find review" }, NOT_FOUND);
  }
  const [review] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("product_reviews", "id")} FROM ${table("product_reviews")} WHERE ${column("product_reviews", "purchase_id")} = ${sale.id} LIMIT 1`,
  );
  if (review === undefined) return renderJson({ success: false, message: "Could not find review" }, NOT_FOUND);
  const { message } = input.params;
  if (message !== undefined && message !== null && !isString(message))
    throw new HandBackToRails("a message that is not a string");

  // acting_user: impersonated_user || account_holder
  const attributes = { user_id: (auth.impersonated ?? auth.accountHolder).id, message: message ?? null };
  const existing = await findResponseOfReview(review.id);
  const reply = existing ?? (await ProductReviewResponses.create({ product_review_id: review.id, ...attributes }));
  const saved = existing === null ? reply.persisted : await ProductReviewResponses.update(existing, attributes);
  if (saved) return renderJson({ success: true });
  return renderJson({ success: false, message: toSentence(reply.errors.fullMessages()) }, UNPROCESSABLE_ENTITY);
});

// Purchase#send_notification_webhook_from_ui: a gift's sender pings for the giftee's purchase (none yet: nothing), any other sale
// for itself. The sale's `url_parameters` reach the job as `url_params`.
const resendPing = memberAction(async (sale) => {
  let target = sale.id;
  if (PurchaseFlags.isSet(sale.flags, "is_gift_sender_purchase")) {
    const gift = await giftOf(sale);
    if (gift === null) throw new HandBackToRails("a gift sender without a gift");
    if (gift.giftee_purchase_id === null) return renderJson({ success: true });
    target = BigInt(gift.giftee_purchase_id);
  }
  // `PostToPingEndpointsWorker.perform_in(10.seconds, id, url_parameters)`
  await performAsync("PostToPingEndpointsWorker", [Number(target), await urlParametersOf(target)], {
    delaySeconds: SALE_PING_DELAY_SECONDS,
  });
  return renderJson({ success: true });
});

// `purchase.url_parameters`: the `params` of its row, nil without one. `has_one` reads an arbitrary row when there are several, and
// only a hash of text values is proven to reach the job as it is stored.
async function urlParametersOf(purchaseId: bigint): Promise<Record<string, string> | null> {
  const rows = await selectRows<{ params: unknown }>(
    Prisma.sql`SELECT ${column("purchase_url_parameters", "params")} FROM ${table("purchase_url_parameters")} WHERE ${column("purchase_url_parameters", "purchase_id")} = ${purchaseId} LIMIT 2`,
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new HandBackToRails("a sale with several URL parameter rows");
  const params: unknown = typeof rows[0]!.params === "string" ? JSON.parse(rows[0]!.params) : rows[0]!.params;
  const isTextHash =
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    Object.values(params).every((value) => typeof value === "string");
  if (!isTextHash) throw new HandBackToRails("URL parameters that are not a hash of text");
  return params as Record<string, string>;
}

// SalesController#blob_url, whose 404 is the seller_owns_blob? check: a blob attached to a commission or a custom field of the
// seller's sales. The found case builds a CDN URL from the blob's storage service.
export async function blobUrl(input: MobileInput, auth: MobileAuth | null) {
  const key = input.params.key;
  if (key !== undefined && key !== null && !isString(key)) throw new HandBackToRails("a key that is not a string");
  const [blob] = isString(key)
    ? await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("active_storage_blobs", "id")} FROM ${table("active_storage_blobs")} WHERE ${column("active_storage_blobs", "key")} = ${key} LIMIT 1`,
      )
    : [];
  const attached = (recordType: string) =>
    Prisma.sql`SELECT ${column("active_storage_attachments", "record_id")} FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "blob_id")} = ${blob?.id} AND ${column("active_storage_attachments", "record_type")} = ${recordType}`;
  const sellerSales = Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${auth!.owner.id}`;
  const owned =
    blob !== undefined &&
    ((await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("commissions")} WHERE ${column("commissions", "id")} IN (${attached("Commission")}) AND (${column("commissions", "deposit_purchase_id")} IN (${sellerSales}) OR ${column("commissions", "completion_purchase_id")} IN (${sellerSales})) LIMIT 1`,
    )) ||
      (await rowExists(
        Prisma.sql`SELECT 1 FROM ${table("purchase_custom_fields")} WHERE ${column("purchase_custom_fields", "id")} IN (${attached("PurchaseCustomField")}) AND ${column("purchase_custom_fields", "purchase_id")} IN (${sellerSales}) LIMIT 1`,
      )));
  if (!owned) return renderJson({ success: false, message: "Could not find file" }, NOT_FOUND);
  throw new HandBackToRails("the CDN URL of a blob");
}

registerMobile(
  { method: "GET", pattern: "/mobile/sales/blob_url", scopes: MOBILE_API_SCOPES, run: blobUrl },
  { method: "PUT", pattern: "/mobile/sales/:id", scopes: MOBILE_API_SCOPES, run: update },
  { method: "PATCH", pattern: "/mobile/sales/:id", scopes: MOBILE_API_SCOPES, run: update },
  {
    method: "POST",
    pattern: "/mobile/sales/:id/resend_receipt",
    scopes: MOBILE_API_SCOPES,
    run: resendSaleReceipt,
  },
  {
    method: "POST",
    pattern: "/mobile/sales/:id/change_can_contact",
    scopes: MOBILE_API_SCOPES,
    run: changeSaleCanContact,
  },
  {
    method: "POST",
    pattern: "/mobile/sales/:id/mark_as_shipped",
    scopes: MOBILE_API_SCOPES,
    run: handBack("a shipment email"),
  },
  {
    method: "POST",
    pattern: "/mobile/sales/:id/resend_ping",
    scopes: MOBILE_API_SCOPES,
    run: resendPing,
  },
  { method: "GET", pattern: "/mobile/sales/:id/missed_posts", scopes: MOBILE_API_SCOPES, run: missedPosts },
  { method: "GET", pattern: "/mobile/sales/:id/product_purchases", scopes: MOBILE_API_SCOPES, run: productPurchases },
  { method: "PUT", pattern: "/mobile/sales/:id/variant", scopes: MOBILE_API_SCOPES, run: variant },
  { method: "POST", pattern: "/mobile/sales/:id/send_post", scopes: MOBILE_API_SCOPES, run: sendPost },
  { method: "PUT", pattern: "/mobile/sales/:id/review_response", scopes: MOBILE_API_SCOPES, run: updateReviewResponse },
);
