// GET /checkout/returns/:id (Checkout::ReturnsController#show): where Stripe sends the buyer back after a client-confirmed payment.
// Node answers the 404 guards, which are decided before the PaymentIntent is read. A request that passes them goes to Rails whole:
// finalizing reads the PaymentIntent from Stripe and charges, records and mails the purchases, and the "Processing your payment"
// page it can render is not ported.
import { Prisma } from "@prisma/client";

import { decryptSecureExternalId, SecureExternalIdError } from "../models/secure-external-id.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const CONFIRM_SCOPE = "confirm";

async function orderExists(id: string | null): Promise<boolean> {
  if (id === null) return false;
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("orders")} WHERE ${column("orders", "id")} = ${id} LIMIT 1`,
  );
  return row !== undefined;
}

// `order.charges.find { _1.stripe_payment_intent_id.present? }`: the first charge, by id, that holds a PaymentIntent.
async function paymentIntentOf(orderId: string): Promise<string | null> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${column("charges", "stripe_payment_intent_id")} AS pi FROM ${table("charges")} WHERE ${column("charges", "order_id")} = ${orderId} ORDER BY ${column("charges", "id")}`,
  );
  for (const row of rows) {
    const value = row.pi;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

async function show({ routeParams, params }: MutationInput): Promise<ActionResult> {
  let orderId: string | null;
  try {
    orderId = decryptSecureExternalId("Order", routeParams.id, CONFIRM_SCOPE);
  } catch (error) {
    if (error instanceof SecureExternalIdError) throw new HandBackToRails(error.message);
    throw error;
  }
  if (orderId === null || !(await orderExists(orderId))) throw new RoutingError("Not Found");

  // No charge with a PaymentIntent is a 404 too: `null` never equals the param.
  const paymentIntent = await paymentIntentOf(orderId);

  // `params[:payment_intent].to_s`: only a plain string (or none) is read the way Rails reads it.
  const given = params.payment_intent;
  if (given !== undefined && typeof given !== "string")
    throw new HandBackToRails("a payment_intent that is not a string");
  if ((given ?? "") !== paymentIntent) throw new RoutingError("Not Found");

  throw new HandBackToRails("a return from Stripe, which reads the PaymentIntent and finalizes the order");
}

registerMutations({ method: "GET", pattern: "/checkout/returns/:id", skipForgeryProtection: true, run: show });
