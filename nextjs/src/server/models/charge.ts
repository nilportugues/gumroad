// Read side of Charge::Chargeable (app/models/concerns/charge/chargeable.rb), the part of Charge it
// reaches, and AutoInvoiceEligibility (app/services/auto_invoice_eligibility.rb). Nothing writes.
import { Prisma, type BillingDetail, type Charge, type Purchase, type Subscription, type User } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";
import { PURCHASES } from "./purchase.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { castRow, column, inList, quoteName, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

// Purchase::ALL_SUCCESS_STATES_INCLUDING_TEST, in the constant's order.
const ALL_SUCCESS_STATES_INCLUDING_TEST = ["preorder_authorization_successful", "successful", "not_charged", "gift_receiver_purchase_successful", "test_successful"];

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export type Chargeable = { kind: "purchase"; purchase: Purchase } | { kind: "charge"; charge: Charge };

// `Purchase.find_by(id:)` and `Charge.find_by(id:)`: a nil id still sends `WHERE id IS NULL`.
export const findPurchaseOrNil = (id: bigint | null) => findOneBy<Purchase>("Purchase", "id", id, true);
export const findChargeOrNil = (id: bigint | null) => findOneBy<Charge>("Charge", "id", id, true);

// `purchase.charge` (has_one :charge, through: :charge_purchase)
export async function chargeOfPurchase(purchase: Purchase): Promise<Charge | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName("charges")}.*`)} FROM ${table("charges")} INNER JOIN ${table("charge_purchases")} ON ${column("charges", "id")} = ${column("charge_purchases", "charge_id")} WHERE ${column("charge_purchases", "purchase_id")} = ${purchase.id} LIMIT 1`,
  );
  return row ? castRow<Charge>("Charge", row) : null;
}

// `Charge::Chargeable.find_by_purchase_or_charge!(purchase:, charge:)`
export async function findByPurchaseOrCharge(purchase: Purchase | null, charge: Charge | null): Promise<Chargeable> {
  if (purchase === null && charge === null) throw new ArgumentError("Either purchase or charge must be present");
  if (purchase !== null && charge !== null) throw new ArgumentError("Only one of purchase or charge must be present");
  if (charge !== null) return { kind: "charge", charge };

  // `uses_charge_receipt?`: a charge that belongs to an order (Order#seller_receipt_enabled? is `is_a?(Order)`).
  const purchaseCharge = await chargeOfPurchase(purchase!);
  const order = purchaseCharge === null ? null : await findById<Record<string, unknown>>("Order", purchaseCharge.order_id);
  if (purchaseCharge !== null && order !== null) return { kind: "charge", charge: purchaseCharge };
  return { kind: "purchase", purchase: purchase! };
}

// `charge.order.email`: `Order#purchase_as_orderable&.email`, the order's first purchase in a success state (by `purchases.id`).
export async function orderableEmail(charge: Charge): Promise<string | null> {
  const [row] = await selectRows<{ email: string | null }>(
    Prisma.sql`SELECT ${column(PURCHASES, "email")} FROM ${table(PURCHASES)} INNER JOIN ${table("order_purchases")} ON ${column(PURCHASES, "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${charge.order_id} AND ${column(PURCHASES, "purchase_state")} IN ${inList(ALL_SUCCESS_STATES_INCLUDING_TEST)} ORDER BY ${column(PURCHASES, "id")} ASC LIMIT 1`,
  );
  return row?.email ?? null;
}

function chargeSuccessfulPurchases(charge: Charge, options: { first: boolean }): Promise<Purchase[]> {
  const base = Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PURCHASES)}.*`)} FROM ${table(PURCHASES)} INNER JOIN ${table("charge_purchases")} ON ${column(PURCHASES, "id")} = ${column("charge_purchases", "purchase_id")} WHERE ${column("charge_purchases", "charge_id")} = ${charge.id} AND ${column(PURCHASES, "purchase_state")} IN ${inList(ALL_SUCCESS_STATES_INCLUDING_TEST)}`;
  const sql = options.first ? Prisma.sql`${base} ORDER BY ${column(PURCHASES, "id")} ASC LIMIT 1` : base;
  return selectRows(sql).then((rows) => rows.map((row) => castRow<Purchase>("Purchase", row)));
}

// `Purchase#has_invoice?`
async function purchaseHasInvoice(purchase: Purchase): Promise<boolean> {
  const subscription = await findById<Subscription>("Subscription", purchase.subscription_id);
  if (subscription !== null) return !PurchaseFlags.isSet(purchase.flags, "is_free_trial_purchase");
  return !(purchase.price_cents === 0 && purchase.shipping_cents === 0);
}

// `AutoInvoiceEligibility.eligible?(chargeable)`
export async function autoInvoiceEligible(chargeable: Chargeable): Promise<boolean> {
  let purchaser: User | null;
  if (chargeable.kind === "purchase") {
    purchaser = await findById<User>("User", chargeable.purchase.purchaser_id);
  } else {
    // Charge delegates `purchaser` to `purchase_as_chargeable` (the first successful purchase).
    const [first] = await chargeSuccessfulPurchases(chargeable.charge, { first: true });
    if (first === undefined) throw new NotPortedError("Charge#purchaser for a charge without a successful purchase", "charge.rb:25");
    purchaser = await findById<User>("User", first.purchaser_id);
  }
  const billingDetail = purchaser === null ? null : await findOneBy<BillingDetail>("BillingDetail", "purchaser_id", purchaser.id);
  if (!billingDetail?.auto_email_invoice_enabled) return false;

  if (chargeable.kind === "purchase") return purchaseHasInvoice(chargeable.purchase);
  for (const purchase of await chargeSuccessfulPurchases(chargeable.charge, { first: false })) {
    if (await purchaseHasInvoice(purchase)) return true;
  }
  return false;
}
