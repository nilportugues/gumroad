// The parts of PurchasesController (app/controllers/purchases_controller.rb) that Node answers without a model port behind
// them: the 404 and authorization guards of every action that sends mail, charges or refunds, or mints and reads signed tokens.
// Whatever passes a guard goes to Rails whole, before anything is written. revoke_access and undo_revoke_access are in
// purchase-access-writes.ts; search and export (Elasticsearch, a mobile token, a CSV mail) stay in Rails untouched.
import { Prisma } from "@prisma/client";

import { decrypt, encrypt, encryptNumeric } from "../../lib/obfuscate-ids.ts";
import { readEncryptedCookie } from "../auth/rails-cookies.ts";
import { railsCookieSecrets } from "../auth/rails-session-config.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { decryptSecureExternalId, SecureExternalIdError } from "../models/secure-external-id.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { setPurchase } from "./purchase-access-writes.ts";
import { authorizeJson, notFoundJson } from "./seller-json.ts";

const UNSUBSCRIBE_SCOPE = "unsubscribe";
const CONFIRM_SCOPE = "confirm";

async function rowExists(tableName: string, id: bigint | number | string | null): Promise<boolean> {
  if (id === null) return false;
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return row !== undefined;
}

// `Purchase.find_by_secure_external_id(params[:id], scope:)`. A missing SecureExternalId configuration is Rails' to answer.
async function secureLookup(token: string, scope: string): Promise<boolean> {
  try {
    return await rowExists("purchases", decryptSecureExternalId("Purchase", token, scope));
  } catch (error) {
    if (error instanceof SecureExternalIdError) throw new HandBackToRails(error.message);
    throw error;
  }
}

type Policy = (context: Parameters<typeof audiencePurchasePolicy.update>[0]) => boolean;

// ----- the seller's actions: authenticate_user!, set_purchase, verify_current_seller_is_seller_for_purchase, authorize

function sellerPurchaseAction(query: Policy, reason: string) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const seller = input.context.currentSeller;
    if (railsLoggedInUser(input.context) === null || seller === null) throw new HandBackToRails("a signed-out request");

    const purchase = await setPurchase(input.routeParams.id!);
    // A before_action halts the chain, so the after_actions (the XSRF cookie) do not run.
    if (purchase.seller_id !== seller.id) return { ...notFoundJson(), rescued: true };
    const denied = await authorizeJson(input, (context) => authorize(query, context));
    if (denied) return denied;
    throw new HandBackToRails(reason);
  };
}

// `authorize [:audience, Purchase]`: the action looks the purchase up itself.
async function refund(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.refund, context));
  if (denied) return denied;
  throw new HandBackToRails("a refund, which moves money through the processor");
}

// ----- the buyer's and the visitor's actions

// receipt, confirm_receipt_email, subscribe and resend_receipt: `Purchase.find_by_external_id(params[:id]) || e404`.
function publicPurchaseAction(reason: string) {
  return async (input: MutationInput): Promise<ActionResult> => {
    await setPurchase(input.routeParams.id!);
    throw new HandBackToRails(reason);
  };
}

async function unsubscribe(input: MutationInput): Promise<ActionResult> {
  const token = input.routeParams.id!;
  if (!(await secureLookup(token, UNSUBSCRIBE_SCOPE))) {
    // The legacy lookups behind the secure redirect: a purchase or a charge by external id, else 404.
    const id = decrypt(token);
    if (!(await rowExists("purchases", id)) && !(await rowExists("charges", id))) throw new RoutingError("Not Found");
  }
  throw new HandBackToRails("an unsubscribe, which locks the follow, or the signed redirect to the confirmation form");
}

async function confirm(input: MutationInput): Promise<ActionResult> {
  if (!(await secureLookup(input.routeParams.id!, CONFIRM_SCOPE))) throw new RoutingError("Not Found");
  throw new HandBackToRails("a purchase confirmation, which reads the processor");
}

// authenticate_subscription!: `Subscription.find_by_external_id!`, then the cookie the manage page set for this subscription.
async function updateSubscription(input: MutationInput): Promise<ActionResult> {
  const id = decrypt(input.routeParams.id!);
  if (!(await rowExists("subscriptions", id))) throw new RoutingError("Not Found");
  const cookieKey = `subscription_${encryptNumeric(Number(id))}`;
  const cookie = readEncryptedCookie(
    railsCookieSecrets(),
    cookieKey,
    input.request.cookies.get(cookieKey) ?? undefined,
  );
  if (cookie !== encrypt(id!)) throw new RoutingError("Not Found");
  throw new HandBackToRails("a subscription update, which charges or authorizes a card");
}

async function chargePreorder(input: MutationInput): Promise<ActionResult> {
  if (!(await rowExists("preorders", decrypt(input.routeParams.id!)))) throw new RoutingError("Not Found");
  throw new HandBackToRails("a preorder charge, which calls the processor");
}

registerMutations(
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/purchases/:id",
    json: true,
    run: sellerPurchaseAction(audiencePurchasePolicy.update, "a purchase update, which can re-send a gift receipt"),
  })),
  {
    method: "POST",
    pattern: "/purchases/:id/change_can_contact",
    json: true,
    run: sellerPurchaseAction(audiencePurchasePolicy.changeCanContact, "a can_contact change"),
  },
  {
    method: "POST",
    pattern: "/purchases/:id/cancel_preorder_by_seller",
    json: true,
    run: sellerPurchaseAction(audiencePurchasePolicy.cancelPreorderBySeller, "a preorder cancellation"),
  },
  { method: "PUT", pattern: "/purchases/:id/refund", json: true, run: refund },
  {
    method: "GET",
    pattern: "/purchases/:id/receipt",
    skipForgeryProtection: true,
    run: publicPurchaseAction("a receipt, rendered from the mailer"),
  },
  {
    method: "GET",
    pattern: "/purchases/:id/confirm_receipt_email",
    skipForgeryProtection: true,
    run: publicPurchaseAction("the receipt email confirmation page"),
  },
  {
    method: "GET",
    pattern: "/purchases/:id/subscribe",
    skipForgeryProtection: true,
    run: publicPurchaseAction("the resubscribe page"),
  },
  {
    method: "POST",
    pattern: "/purchases/:id/subscribe",
    run: publicPurchaseAction("a resubscribe, which writes every purchase of the buyer"),
  },
  { method: "POST", pattern: "/purchases/:id/resend_receipt", json: true, railsOnly: "/ip:resend_receipt", run: publicPurchaseAction("a receipt mail") },
  { method: "GET", pattern: "/purchases/:id/unsubscribe", skipForgeryProtection: true, run: unsubscribe },
  { method: "POST", pattern: "/purchases/:id/confirm", json: true, run: confirm },
  { method: "POST", pattern: "/preorders/:id/charge_preorder", json: true, run: chargePreorder },
  { method: "PUT", pattern: "/subscriptions/:id", json: true, run: updateSubscription },
);
