// StripeChargeProcessor.handle_stripe_event as HandleStripeEventWorker reaches it, for the events that end before
// `ChargeProcessor.handle_event` (the ledger) and before any Stripe call: the ones the processor drops, the ones it raises on,
// and the payment_intent lifecycle events that match no client-confirmed charge. Everything else throws NotPortedError, before
// any statement that writes.
// Golden: worker/jobs/__fixtures__/stripe-event-routing.golden.json (scripts/golden/stripe-event-routing.rb).
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import { ChargeFlags } from "./charge-record.ts";
// Evaluated before merchant-account.ts: that module reaches subscription.ts through the mailers, which needs PURCHASES already defined.
import "./purchase.ts";
import { findMerchantAccountByProcessorMerchantId, isStripeConnectAccountRecord } from "./merchant-account.ts";
import { findOneBy } from "./row-reads.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { type EventObject, isObject, railsIntegerCast } from "./stripe-event-values.ts";
import { NotPortedError } from "./user.ts";

const SOURCE = "stripe_charge_processor.rb handle_stripe_event";
const COMBINED_CHARGE_PREFIX = "CH-";
const HANDLED_REFUND_EVENTS = ["refund.updated", "refund.failed"];
const PAYMENT_INTENT_LIFECYCLE_EVENTS = ["payment_intent.processing", "payment_intent.succeeded"];
const RADAR_EVENTS = ["radar.early_fraud_warning.created", "radar.early_fraud_warning.updated"];
const CAPITAL_PAYMENT_EVENT = "capital.financing_transaction.created";

// `Purchase.find_by(id:)`; a nil id still sends the statement.
const findPurchaseById = (id: bigint | null) => findOneBy("Purchase", "id", id, true);

const notPorted = (what: string) => new NotPortedError(what, SOURCE);

// `"Stripe Event #{stripe_event['id']} ..."`: nil interpolates as an empty string.
function eventIdText(event: EventObject): string {
  const id = event.id;
  if (id === null || id === undefined) return "";
  if (typeof id === "string" || typeof id === "number") return String(id);
  throw notPorted("an event id that is not a String or an Integer");
}

// `stripe_event["data"]["object"]`: a missing level is a NoMethodError in Ruby, which Node leaves to Rails.
function dataObject(event: EventObject): EventObject {
  const data = event.data;
  const object = isObject(data) ? data.object : undefined;
  if (!isObject(object)) throw notPorted("an event whose data.object is not a Hash");
  return object;
}

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

// `Model.where(<column>: value).last`
async function lastBy(tableName: string, columnName: string, value: unknown): Promise<Record<string, unknown> | null> {
  const bound = value === null ? Prisma.sql`NULL` : Prisma.sql`${value}`;
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star(tableName)} FROM ${table(tableName)} WHERE ${column(tableName, columnName)} = ${bound} ORDER BY ${column(tableName, "id")} DESC LIMIT 1`,
  );
  return row ?? null;
}

type Chargeable = { kind: "charge"; flags: unknown } | { kind: "purchase" };

function stringOrNil(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw notPorted(`${what} that is not a String`);
  return value;
}

// get_charge_reference(payment_intent)
function chargeReference(intent: EventObject): string | null {
  const transferGroup = stringOrNil(intent.transfer_group, "a transfer_group");
  if (transferGroup !== null && transferGroup.startsWith(COMBINED_CHARGE_PREFIX)) return transferGroup;
  const metadata = intent.metadata;
  if (!isObject(metadata)) throw notPorted("a payment_intent whose metadata is not a Hash");
  return stringOrNil(metadata.purchase, "a purchase reference");
}

// Charge::Chargeable.find_by_stripe_event
async function findByStripeEvent(
  reference: string | null,
  chargeId: string | null,
  intentId: string,
): Promise<Chargeable | null> {
  const asCharge = (row: Record<string, unknown> | null): Chargeable | null =>
    row ? { kind: "charge", flags: row.flags } : null;
  if (reference?.startsWith(COMBINED_CHARGE_PREFIX)) {
    const id = railsIntegerCast(reference.slice(COMBINED_CHARGE_PREFIX.length));
    let chargeable = asCharge(await lastBy("charges", "id", id));
    if (!chargeable && chargeId !== null)
      chargeable = asCharge(await lastBy("charges", "processor_transaction_id", chargeId));
    if (!chargeable && !isBlank(intentId))
      chargeable = asCharge(await lastBy("charges", "stripe_payment_intent_id", intentId));
    return chargeable;
  }
  if (reference !== null) {
    const decoded = decrypt(reference);
    if (await findPurchaseById(decoded === null ? null : BigInt(decoded))) return { kind: "purchase" };
  }
  if (chargeId !== null) {
    const charge = asCharge(await lastBy("charges", "processor_transaction_id", chargeId));
    if (charge) return charge;
    if (await lastBy("purchases", "stripe_transaction_id", chargeId)) return { kind: "purchase" };
  }
  if (!isBlank(intentId)) {
    const link = await lastBy("processor_payment_intents", "intent_id", intentId);
    if (link && (await findPurchaseById(BigInt(String(link.purchase_id))))) return { kind: "purchase" };
  }
  return null;
}

// payment_intent.processing / payment_intent.succeeded: `return unless chargeable.is_a?(Charge) && chargeable.client_confirmed?`,
// `return if ProcessedStripeEvent.processed?`. A client-confirmed charge the event was not yet recorded for goes to the ledger.
async function handlePaymentIntentLifecycle(event: EventObject): Promise<void> {
  const intent = dataObject(event);
  if (intent.object !== "payment_intent")
    throw new Error(`Stripe Event ${eventIdText(event)} does not contain a 'payment_intent' object.`);
  const intentId = intent.id;
  if (typeof intentId !== "string") throw notPorted("a payment_intent whose id is not a String");
  const chargeId = stringOrNil(intent.latest_charge, "a latest_charge");
  const chargeable = await findByStripeEvent(chargeReference(intent), chargeId, intentId);
  if (
    chargeable?.kind !== "charge" ||
    !ChargeFlags.isSet(chargeable.flags as bigint | number | null, "client_confirmed")
  )
    return;
  if (typeof event.id !== "string") throw notPorted("an event id that is not a String");
  const [processed] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("processed_stripe_events")} WHERE ${column("processed_stripe_events", "event_id")} = ${event.id} LIMIT 1`,
  );
  if (processed) return;
  throw notPorted("a payment_intent event of a client-confirmed charge (ChargeProcessor.handle_event)");
}

function handleDispute(event: EventObject): void {
  const dispute = dataObject(event);
  if (dispute.object !== "dispute")
    throw new Error(`Stripe Event ${eventIdText(event)} does not contain a 'dispute' object.`);
  if (dispute.charge === null || dispute.charge === undefined)
    throw new Error(`Stripe Event ${eventIdText(event)} has no charge id.`);
  if (event.created === null || event.created === undefined)
    throw new Error(`Stripe Event ${eventIdText(event)} has no created date.`);
  // The dispute can no longer be retrieved once the charge was refunded, so the event says nothing.
  if (event.type === "charge.dispute.closed" && dispute.status === "charge_refunded") return;
  throw notPorted("a dispute event (Stripe::Dispute.retrieve, ChargeProcessor.handle_event)");
}

function handleCharge(event: EventObject): void {
  const charge = dataObject(event);
  if (charge.object !== "charge")
    throw new Error(`Stripe Event ${eventIdText(event)} does not contain a 'charge' object.`);
  if (event.type === "charge.succeeded") {
    if (!isObject(charge.metadata)) throw notPorted("a charge whose metadata is not a Hash");
    // Charges Twitter created are unknown until captured.
    if (!isBlank(charge.metadata.twitter_username)) return;
  }
  if (charge.id === null || charge.id === undefined)
    throw new Error(`Stripe Event ${eventIdText(event)} has no charge id.`);
  if (event.created === null || event.created === undefined)
    throw new Error(`Stripe Event ${eventIdText(event)} has no created date.`);
  throw notPorted("a charge event (ChargeProcessor.handle_event)");
}

async function handleChargeEvent(event: EventObject, type: string): Promise<void> {
  if (type === "charge.failed") return;
  if (type.startsWith("charge.dispute.")) return handleDispute(event);
  if (type === "charge.refund.updated" || HANDLED_REFUND_EVENTS.includes(type))
    throw notPorted("a refund event (ChargeProcessor.handle_event)");
  if (type.startsWith("charge.")) return handleCharge(event);
  if (type.startsWith("payment_intent.payment_failed")) {
    if (dataObject(event).object !== "payment_intent")
      throw new Error(`Stripe Event ${eventIdText(event)} does not contain a 'payment_intent' object.`);
    throw notPorted("a payment_intent.payment_failed event (ChargeProcessor.handle_event)");
  }
  if (PAYMENT_INTENT_LIFECYCLE_EVENTS.includes(type)) return handlePaymentIntentLifecycle(event);
}

// handle_stripe_capital_loan_event: every branch that books a credit or calls Stripe throws.
async function handleCapital(event: EventObject, type: string): Promise<void> {
  if (type !== CAPITAL_PAYMENT_EVENT) return;
  const data = dataObject(event);
  if (data.type !== "payment") return;
  if (!isObject(data.details)) throw notPorted("a financing transaction without details");
  const currency = data.details.currency;
  const accountId = data.account;
  if (typeof currency !== "string" || typeof accountId !== "string")
    throw notPorted("a financing transaction whose currency or account is not a String");
  const account = await findMerchantAccountByProcessorMerchantId(accountId);
  if (account === null || account.get("currency") !== currency) return;
  if (isStripeConnectAccountRecord(account) || account.get("user_id") == null) return;
  throw notPorted("a capital financing transaction (Credit writes, Stripe::Charge.retrieve)");
}

/** `StripeChargeProcessor.handle_stripe_event(stripe_event)`. */
export async function handleStripeChargeProcessorEvent(event: EventObject, type: string): Promise<void> {
  if (
    type.startsWith("charge.") ||
    type.startsWith("payment_intent.payment_failed") ||
    type.startsWith("payment_intent.processing") ||
    type.startsWith("payment_intent.succeeded") ||
    HANDLED_REFUND_EVENTS.includes(type)
  )
    return handleChargeEvent(event, type);
  if (type.startsWith("capital.")) return handleCapital(event, type);
  if (type.startsWith("radar.")) {
    if (!RADAR_EVENTS.includes(type)) throw new Error(`Unsupported event type: ${type}`);
    throw notPorted("a radar event (EarlyFraudWarning#update_from_stripe!)");
  }
}
