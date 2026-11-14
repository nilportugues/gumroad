// The Api::Mobile writes that move money, send mail, delete a product or sign a session in: refund, commission completion, subscription
// cancel, product destroy, the session sign-in and the confirmation resend.
//
// Each answers what Rails answers before its first write (the 404 lookups, the comma refusal of a refund amount, an already confirmed
// address) and hands every other request back whole.
import { Prisma } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt } from "../../lib/obfuscate-ids.ts";
import { completionOutcome } from "../models/commission-completion.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { present } from "../search/ruby-params.ts";

import { HandBackToRails } from "./application-controller.ts";
import {
  fetchError,
  NOT_FOUND,
  registerMobile,
  renderJson,
  UNPROCESSABLE_ENTITY, type MobileAuth, type MobileInput } from "./mobile-api.ts";

const MOBILE_API_SCOPES = ["mobile_api"];

const rowExists = async (statement: Prisma.Sql) => (await selectRows(statement)).length > 0;

// `Model.find_by_external_id(params[:id])` of a route segment, which is always text
function idOf(input: MobileInput): bigint | null {
  const id = typeof input.params.id === "string" ? decrypt(input.params.id) : null;
  return id === null ? null : BigInt(id);
}

// ProcessRefund#process_refund. The refund moves money through Stripe or PayPal and writes balances, so past the lookup it is Rails'.
async function refund(input: MobileInput, auth: MobileAuth | null) {
  const { amount } = input.params;
  // `amount&.include?(",")`: text and a list answer, a number is a NoMethodError.
  if (amount !== undefined && amount !== null && typeof amount !== "string")
    throw new HandBackToRails("a refund amount that is not text");
  if (typeof amount === "string" && amount.includes(","))
    return renderJson({ success: false, message: "Commas not supported in refund amount." });

  // `seller.sales.paid.find_by_external_id`
  const id = idOf(input);
  const paid =
    id !== null &&
    (await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} AND ${column("purchases", "seller_id")} = ${auth!.owner.id} AND ${column("purchases", "purchase_state")} = 'successful' AND ${column("purchases", "price_cents")} > 0 AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) LIMIT 1`,
    ));
  if (!paid) return renderJson({ success: false, error: "Not found" }, NOT_FOUND);
  throw new HandBackToRails("a refund");
}

// Api::Mobile::CommissionsController#complete. The completion purchase is a charge, so what Node answers is what Commission#create_completion_purchase!
// does before it (nothing to do, or a RecordInvalid the action renders as a 422); the charge itself is Rails'.
async function completeCommission(input: MobileInput, auth: MobileAuth | null) {
  const id = idOf(input);
  const commission = id === null ? null : await db.commission.findUnique({ where: { id } });
  const deposit =
    commission?.deposit_purchase_id == null
      ? null
      : await db.purchase.findUnique({ where: { id: commission.deposit_purchase_id } });
  if (commission === null || deposit === null || deposit.seller_id !== auth!.owner.id)
    return fetchError("Could not find commission");

  const outcome = await completionOutcome(commission, deposit);
  if (outcome === "done") return renderJson({ success: true });
  if (outcome !== null) return renderJson({ success: false, message: outcome }, UNPROCESSABLE_ENTITY);
  throw new HandBackToRails("a commission completion");
}

// SubscriptionsController#cancel: `Subscription.find_by_external_id` of any state, owned by the token's seller. The cancel mails both parties.
async function cancelSubscription(input: MobileInput, auth: MobileAuth | null) {
  const id = idOf(input);
  const owned =
    id !== null &&
    (await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${id} AND ${column("subscriptions", "seller_id")} = ${auth!.owner.id} LIMIT 1`,
    ));
  if (!owned) return fetchError("Could not find subscription");
  throw new HandBackToRails("a subscription cancel");
}

// ProductsController#destroy: `current_resource_owner.products.visible.find_by(unique_permalink: params[:id])`. The delete itself
// unpublishes, reindexes and records a user event.
async function destroyProduct(input: MobileInput, auth: MobileAuth | null) {
  const permalink = input.params.id;
  const found =
    typeof permalink === "string" &&
    (await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${auth!.owner.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
    ));
  if (!found) return fetchError("Product not found");
  throw new HandBackToRails("a product delete");
}

// UrlRedirectsController#url_redirect_attributes: `fetch_url_redirect_by_external_id`, a before_action whose 404 halts the chain. The
// payload (`UrlRedirect#product_json_data`) is Rails'.
async function urlRedirectAttributes(input: MobileInput) {
  const id = idOf(input);
  const found =
    id !== null &&
    (await rowExists(
      Prisma.sql`SELECT 1 FROM ${table("url_redirects")} WHERE ${column("url_redirects", "id")} = ${id} LIMIT 1`,
    ));
  if (!found) return fetchError("Could not find url redirect");
  throw new HandBackToRails("the payload of a url redirect");
}

// SessionsController#create signs the bearer's user in: a session cookie Node does not mint.
// eslint-disable-next-line @typescript-eslint/require-await
async function signIn(): Promise<never> {
  throw new HandBackToRails("a web sign-in");
}

// SessionsController#resend_confirmation_email: `has_unconfirmed_email?` is `unconfirmed_email.present? || !confirmed?`. Anything else
// claims a send slot and enqueues the mail.
// eslint-disable-next-line @typescript-eslint/require-await
async function resendConfirmationEmail(_input: MobileInput, auth: MobileAuth | null) {
  const { unconfirmed_email: unconfirmedEmail, confirmed_at: confirmedAt } = auth!.owner;
  if (present(unconfirmedEmail) || confirmedAt === null) throw new HandBackToRails("a confirmation email");
  return renderJson({ success: true, status: "already_confirmed" });
}

registerMobile(
  { method: "PATCH", pattern: "/mobile/sales/:id/refund", scopes: MOBILE_API_SCOPES, run: refund },
  { method: "POST", pattern: "/mobile/commissions/:id/complete", scopes: MOBILE_API_SCOPES, run: completeCommission },
  { method: "POST", pattern: "/mobile/subscriptions/:id/cancel", scopes: MOBILE_API_SCOPES, run: cancelSubscription },
  { method: "DELETE", pattern: "/mobile/products/:id", scopes: MOBILE_API_SCOPES, run: destroyProduct },
  {
    method: "GET",
    pattern: "/mobile/url_redirects/get_url_redirect_attributes/:id",
    scopes: null,
    run: urlRedirectAttributes,
  },
  { method: "POST", pattern: "/mobile/sessions", scopes: MOBILE_API_SCOPES, skipForgeryProtection: true, run: signIn },
  {
    method: "POST",
    pattern: "/mobile/sessions/resend_confirmation_email",
    scopes: MOBILE_API_SCOPES,
    run: resendConfirmationEmail,
  },
);
