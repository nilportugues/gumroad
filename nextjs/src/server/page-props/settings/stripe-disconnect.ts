// User#stripe_disconnect_allowed? for a seller whose Stripe Connect account routes sales: the disconnect is
// refused while a subscription or preorder still charges a card through that account (User#active_subscribers?
// and #active_preorders? in app/modules/user/stats.rb, called with the Stripe processor and the Connect account).
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";

const STRIPE_CHARGE_PROCESSOR_ID = "stripe";
// FlagShihTzu bit values: Subscription 1 => is_test_subscription; Link 2 => is_recurring_billing, 4 => is_in_preorder_state.
const SUBSCRIPTION_IS_TEST_FLAG = 1;
const LINK_IS_RECURRING_BILLING_FLAG = 2;
const LINK_IS_IN_PREORDER_STATE_FLAG = 8;

const aliveLink = Prisma.sql`${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL`;

async function exists(sql: Prisma.Sql): Promise<boolean> {
  return (await selectRows(sql)).length > 0;
}

// A guest subscription is judged by its own card, a signed-in subscriber's by the card saved on their user.
async function activeSubscribers(sellerId: unknown, merchantAccountId: unknown): Promise<boolean> {
  const active = Prisma.sql`
    FROM ${table("subscriptions")}
    INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("subscriptions", "link_id")}
    INNER JOIN ${table("purchases")} ON ${column("purchases", "subscription_id")} = ${column("subscriptions", "id")}
    WHERE ${column("links", "user_id")} = ${sellerId}
      AND ${aliveLink}
      AND ${column("links", "flags")} & ${LINK_IS_RECURRING_BILLING_FLAG} != 0
      AND ${column("subscriptions", "flags")} & ${SUBSCRIPTION_IS_TEST_FLAG} = 0
      AND ${column("subscriptions", "failed_at")} IS NULL
      AND ${column("subscriptions", "ended_at")} IS NULL
      AND ${column("subscriptions", "cancelled_at")} IS NULL
      AND ${column("purchases", "total_transaction_cents")} != 0
      AND ${column("purchases", "merchant_account_id")} = ${merchantAccountId}`;
  return (
    (await exists(Prisma.sql`SELECT 1 AS present ${active}
      AND ${column("subscriptions", "user_id")} IS NULL
      AND EXISTS (SELECT 1 FROM ${table("credit_cards")} WHERE ${column("credit_cards", "id")} = ${column("subscriptions", "credit_card_id")} AND ${column("credit_cards", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID})
      LIMIT 1`)) ||
    (await exists(Prisma.sql`SELECT 1 AS present ${active}
      AND ${column("subscriptions", "user_id")} IS NOT NULL
      AND EXISTS (SELECT 1 FROM ${table("users")} INNER JOIN ${table("credit_cards")} ON ${column("credit_cards", "id")} = ${column("users", "credit_card_id")} WHERE ${column("users", "id")} = ${column("subscriptions", "user_id")} AND ${column("credit_cards", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID})
      LIMIT 1`))
  );
}

async function activePreorders(sellerId: unknown, merchantAccountId: unknown): Promise<boolean> {
  const active = Prisma.sql`
    FROM ${table("preorders")}
    INNER JOIN ${table("preorder_links")} ON ${column("preorder_links", "id")} = ${column("preorders", "preorder_link_id")}
    INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("preorder_links", "link_id")}
    INNER JOIN ${table("purchases")} ON ${column("purchases", "preorder_id")} = ${column("preorders", "id")}
    WHERE ${column("links", "user_id")} = ${sellerId}
      AND ${aliveLink}
      AND ${column("links", "flags")} & ${LINK_IS_IN_PREORDER_STATE_FLAG} != 0
      AND ${column("preorder_links", "state")} != 'released'
      AND ${column("preorders", "state")} = 'authorization_successful'
      AND ${column("purchases", "total_transaction_cents")} != 0
      AND ${column("purchases", "merchant_account_id")} = ${merchantAccountId}`;
  return (
    (await exists(Prisma.sql`SELECT 1 AS present ${active}
      AND ${column("preorders", "purchaser_id")} IS NULL
      AND EXISTS (SELECT 1 FROM ${table("credit_cards")} WHERE ${column("credit_cards", "preorder_id")} = ${column("preorders", "id")} AND ${column("credit_cards", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID})
      LIMIT 1`)) ||
    (await exists(Prisma.sql`SELECT 1 AS present ${active}
      AND ${column("preorders", "purchaser_id")} IS NOT NULL
      AND EXISTS (SELECT 1 FROM ${table("users")} INNER JOIN ${table("credit_cards")} ON ${column("credit_cards", "id")} = ${column("users", "credit_card_id")} WHERE ${column("users", "id")} = ${column("preorders", "purchaser_id")} AND ${column("credit_cards", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID})
      LIMIT 1`))
  );
}

export async function stripeDisconnectAllowed(sellerId: unknown, connectAccountId: unknown): Promise<boolean> {
  return !(await activeSubscribers(sellerId, connectAccountId)) && !(await activePreorders(sellerId, connectAccountId));
}
