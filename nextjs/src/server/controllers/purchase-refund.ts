// PurchasesController#refund (app/controllers/concerns/process_refund.rb, Purchase::Refundable#refund_and_save!) up to the
// first thing that can move money. Every refusal Rails reaches before it calls the processor is answered here from reads
// alone; a request that gets past them hands back to Rails whole, so no Stripe call and no write happens in Node.
//
// The success path is not ported: it is a Stripe charge read, a refund create and two reads, then the ledger (refund,
// balance transactions, credit, balance, purchase) and eight jobs. `purchases_refund_parity_spec.rb` records that order
// (all four calls, then the writes) for whoever ports it.
import { Prisma, type Purchase } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { UserFlags } from "../models/user.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { type MutationInput } from "./mutation.ts";
import { authorizeJson, json, notFoundJson } from "./seller-json.ts";

const STRIPE = "stripe";
// ChargeProcessor.charge_processor_ids
const CHARGE_PROCESSORS = ["stripe", "paypal", "braintree"];
const PAYPAL_CARD_TYPE = "paypal";

// Purchase::Refundable
const NOTHING_TO_REFUND = "This purchase has already been refunded or has nothing left to refund.";
const ACTIVE_DISPUTE =
  "This purchase has an active dispute. The funds have already been returned to the buyer. No additional refund is needed.";
const REFUNDS_DISABLED = "Refunds are temporarily disabled in your account.";
const BALANCE_INSUFFICIENT = "Your balance is insufficient to process this refund.";
const COMMAS_NOT_SUPPORTED = "Commas not supported in refund amount.";

const failure = (message: string): ActionResult => json({ success: false, message });

// `seller.sales.paid.find_by_external_id(id)`: successful, priced, and not (fully) refunded.
async function paidSale(sellerId: bigint | number, externalId: string): Promise<Purchase | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${sellerId} AND ${column("purchases", "id")} = ${id} AND ${column("purchases", "purchase_state")} = 'successful' AND ${column("purchases", "price_cents")} > 0 AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) LIMIT 1`,
  );
  return (row as Purchase | undefined) ?? null;
}

async function exists(sql: Prisma.Sql): Promise<boolean> {
  return (await selectRows(sql)).length > 0;
}

// User::MoneyBalance#unpaid_balance_cents
async function unpaidBalanceCents(userId: bigint | number): Promise<bigint> {
  const [row] = await selectRows(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) AS total FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${userId} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const total = (row as { total: bigint | number | Prisma.Decimal | null } | undefined)?.total;
  return total == null ? 0n : BigInt(total.toString());
}

// `merchant_account` is a gumroad-managed row (no owner): the only account whose Purchase-side checks are all reads here.
async function heldByGumroad(merchantAccountId: bigint | number | null): Promise<boolean> {
  if (merchantAccountId === null) return false;
  return exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "id")} = ${merchantAccountId} AND ${column("merchant_accounts", "user_id")} IS NULL LIMIT 1`,
  );
}

const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export async function refundPurchase(input: MutationInput): Promise<ActionResult> {
  const user = railsLoggedInUser(input.context);
  const seller = input.context.currentSeller;
  if (user === null || seller === null) throw new HandBackToRails("a signed-out request");
  const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.refund, context));
  if (denied) return denied;

  const amount = input.params.amount;
  // `amount&.include?(",")` raises on anything but a String.
  if (amount !== undefined && amount !== null && typeof amount !== "string")
    throw new HandBackToRails("a refund amount that is not text");
  if (typeof amount === "string" && amount.includes(",")) return failure(COMMAS_NOT_SUPPORTED);

  const purchase = await paidSale(seller.id, input.routeParams.id!);
  if (purchase === null) return notFoundJson();
  // paypal_refund_expired? compares against six calendar months.
  if (purchase.card_type === PAYPAL_CARD_TYPE)
    throw new HandBackToRails("a PayPal refund, whose expiry depends on the calendar");

  // A partial refund parses the amount in the product's currency and short-circuits to a full refund in several cases.
  if (!blank(amount)) throw new HandBackToRails("a refund with an amount, which is converted and may be partial");

  if (!CHARGE_PROCESSORS.includes(purchase.charge_processor_id ?? ""))
    throw new HandBackToRails("a purchase of a removed processor");
  // refund_and_save!: Purchase#refunds are summed with the `effective` scope, so a purchase with refunds hands back.
  if (
    await exists(
      Prisma.sql`SELECT 1 FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchase.id} LIMIT 1`,
    )
  )
    throw new HandBackToRails("a purchase that already has refunds");
  if (purchase.stripe_transaction_id === null || purchase.stripe_transaction_id === "")
    return failure(NOTHING_TO_REFUND);

  const chargedBack = purchase.chargeback_date !== null;
  if (chargedBack && !PurchaseFlags.isSet(purchase.flags, "chargeback_reversed")) return failure(ACTIVE_DISPUTE);

  // The disconnected-account check reads the merchant account and the seller's PayPal setup; only Gumroad's own Stripe account is read here.
  if (purchase.charge_processor_id !== STRIPE || !(await heldByGumroad(purchase.merchant_account_id)))
    throw new HandBackToRails("a purchase charged on a seller's own processor account");

  // A Gumroad team member refunding for a seller needs a reason, skips the balance checks and sends the seller a mail.
  if (UserFlags.isSet(user.flags, "is_team_member")) throw new HandBackToRails("a refund by a Gumroad team member");

  if (UserFlags.isSet(seller.flags, "refunds_disabled")) return failure(REFUNDS_DISABLED);
  if (purchase.price_cents === null) throw new HandBackToRails("a purchase with no price");
  if (BigInt(purchase.price_cents) > (await unpaidBalanceCents(seller.id))) return failure(BALANCE_INSUFFICIENT);

  throw new HandBackToRails("a refund, which moves money through the processor");
}
