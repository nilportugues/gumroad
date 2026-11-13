// What OrdersController#confirm, #finalize and #confirm_error and BraintreeController#generate_transient_customer_token answer before
// they reach a processor:
//   - an order token that is not an order's (`Order.find_by_secure_external_id(params[:id], scope: "confirm")`, then `e404`);
//   - a blank Braintree nonce, which answers `{ transient_customer_store_key: null }`.
//
// Everything else hands back whole before any write: confirming, finalizing or reporting on a real order reads or moves money at
// Stripe, and a Braintree nonce is tokenized with Braintree. `GET /braintree/client_token` and `POST /stripe/setup_intents` call the
// processor on every path that is not a card-parameter refusal, so they are not registered.
import { Prisma } from "@prisma/client";

import { isBlank } from "../models/runtime/validators.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const ORDER_CONFIRM_SCOPE = "confirm";

// `Order.find_by_secure_external_id(params[:id], scope: "confirm")`: a token that does not decrypt, or an order that is gone, is a 404.
function orderGuard(action: string) {
  return async (input: MutationInput): Promise<ActionResult> => {
    const id = decryptSecureExternalId("Order", input.routeParams.id!, ORDER_CONFIRM_SCOPE, input.chain.now);
    const [order] =
      id === null
        ? []
        : await selectRows(
            Prisma.sql`SELECT ${column("orders", "id")} FROM ${table("orders")} WHERE ${column("orders", "id")} = ${BigInt(id)} LIMIT 1`,
          );
    if (!order) throw new RoutingError("Not Found");
    throw new HandBackToRails(`${action} of an order, which reads or moves money at the processor`);
  };
}

export async function generateTransientCustomerToken({ params }: MutationInput): Promise<ActionResult> {
  const nonce = params.braintree_nonce;
  if (nonce !== undefined && nonce !== null && typeof nonce !== "string")
    throw new HandBackToRails("a Braintree nonce that is not text");
  if (!isBlank(nonce)) throw new HandBackToRails("a Braintree nonce, which is tokenized with Braintree");
  return json({ transient_customer_store_key: null });
}

registerMutations(
  ...["confirm", "finalize", "confirm_error"].map((action) => ({
    method: "POST",
    pattern: `/orders/:id/${action}`,
    formats: ["any" as const],
    run: orderGuard(action),
  })),
  {
    method: "POST",
    pattern: "/braintree/generate_transient_customer_token",
    formats: ["any"],
    run: generateTransientCustomerToken,
  },
);
