// Subscription#as_json (app/models/subscription.rb), the subscriber object of the v2 API, from batched row reads.
// An installment plan, a card mandate flag, a gifted membership and a licensed product with per-variant content are Rails'.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { LinkFlags } from "./link.ts";
import { column, selectRows, table } from "./sql.ts";
import { SubscriptionFlags } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const notPorted = (what: string) => new NotPortedError(what, "Subscription#as_json");
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const timeJson = (time: Date | null | undefined): string | null =>
  time == null ? null : time.toISOString().replace(/\.\d{3}Z$/u, "Z");
const inList = (ids: readonly unknown[]) => Prisma.join(ids as (bigint | number)[]);

async function rowsBy(tableName: string, columnName: string, ids: readonly unknown[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  return selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, columnName)} IN (${inList(ids)}) ORDER BY ${column(tableName, "id")} ASC`,
  );
}
const byId = (rows: Row[]) => new Map(rows.map((row) => [String(row.id), row]));

export async function subscriptionsAsJson(
  subscriptions: Row[],
  now: Date = new Date(),
): Promise<Record<string, unknown>[]> {
  if (subscriptions.length === 0) return [];
  for (const subscription of subscriptions) {
    if (
      SubscriptionFlags.isSet(subscription.flags, "is_installment_plan") ||
      SubscriptionFlags.isSet(subscription.flags, "renewal_disabled_due_to_indian_card_mandate")
    )
      throw notPorted("an installment plan or a card mandate");
  }
  const ids = subscriptions.map((subscription) => subscription.id);
  const links = byId(
    await rowsBy("links", "id", [...new Set(subscriptions.map((subscription) => subscription.link_id))]),
  );
  const users = byId(
    await rowsBy("users", "id", [
      ...new Set(subscriptions.map((subscription) => subscription.user_id).filter((id) => id != null)),
    ]),
  );
  const purchases = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} IN (${inList(ids)}) ORDER BY ${column("purchases", "id")} ASC`,
  );
  const bySubscription = new Map<string, Row[]>();
  for (const purchase of purchases)
    bySubscription.set(String(purchase.subscription_id), [
      ...(bySubscription.get(String(purchase.subscription_id)) ?? []),
      purchase,
    ]);

  const paymentOptions = await rowsBy("payment_options", "subscription_id", ids);
  const lastOptions = byId(
    await rowsBy(
      "payment_options",
      "id",
      subscriptions.map((subscription) => subscription.last_payment_option_id).filter((id) => id != null),
    ),
  );
  const optionOf = (subscription: Row): Row => {
    const chosen =
      subscription.last_payment_option_id == null
        ? [...paymentOptions]
            .reverse()
            .find((option) => String(option.subscription_id) === String(subscription.id) && option.deleted_at == null)
        : lastOptions.get(String(subscription.last_payment_option_id));
    if (chosen === undefined || chosen.product_installment_plan_id != null)
      throw notPorted("a subscription with no plain payment option");
    return chosen;
  };
  const priceRows = byId(
    await rowsBy(
      "prices",
      "id",
      subscriptions.map((subscription) => optionOf(subscription).price_id).filter((id) => id != null),
    ),
  );
  const originals = new Map<string, Row>();
  const trueOriginals = new Map<string, Row>();
  for (const [id, list] of bySubscription) {
    // original_purchase: is_original_subscription_purchase and not archived; true_original_purchase: the first original, by id
    const flagged = list.filter((purchase) => PurchaseFlags.isSet(purchase.flags, "is_original_subscription_purchase"));
    const original = flagged.find(
      (purchase) => !PurchaseFlags.isSet(purchase.flags, "is_archived_original_subscription_purchase"),
    );
    if (original !== undefined) originals.set(id, original);
    if (flagged[0] !== undefined) trueOriginals.set(id, flagged[0]);
  }
  for (const purchase of trueOriginals.values())
    if (PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")) throw notPorted("a gifted membership");
  const licenses = new Map(
    (
      await rowsBy(
        "licenses",
        "purchase_id",
        [...originals.values()].map((purchase) => purchase.id),
      )
    )
      .map((license) => [String(license.purchase_id), license] as const)
      .reverse(),
  );
  const variantJoins = await rowsBy(
    "base_variants_purchases",
    "purchase_id",
    [...originals.values()].map((purchase) => purchase.id),
  );

  return subscriptions.map((subscription) => {
    const id = String(subscription.id);
    const link = links.get(String(subscription.link_id))!;
    const user = subscription.user_id == null ? null : (users.get(String(subscription.user_id)) ?? null);
    const original = originals.get(id);
    const list = bySubscription.get(id) ?? [];
    const price = priceRows.get(String(optionOf(subscription).price_id));
    if (price === undefined) throw notPorted("a subscription with no price");
    const formEmail =
      user === null
        ? undefined
        : present(user.unconfirmed_email)
          ? user.unconfirmed_email
          : present(user.email)
            ? user.email
            : undefined;
    const email = formEmail ?? original?.email;
    if (email === undefined) throw notPorted("a subscription with no email");

    const alive =
      subscription.failed_at == null &&
      subscription.ended_at == null &&
      (subscription.cancelled_at == null || subscription.cancelled_at.getTime() > now.getTime());
    const lastPurchase = list.reduce<Row | undefined>(
      (latest, purchase) =>
        latest === undefined || purchase.created_at.getTime() > latest.created_at.getTime() ? purchase : latest,
      undefined,
    );
    let status = "alive";
    if (subscription.deactivated_at != null)
      status =
        subscription.failed_at != null
          ? "failed_payment"
          : subscription.ended_at != null
            ? "fixed_subscription_period_ended"
            : subscription.cancelled_at != null
              ? "cancelled"
              : (null as never);
    else if (alive && lastPurchase?.purchase_state === "failed") status = "pending_failure";
    else if (alive && subscription.cancelled_at != null) status = "pending_cancellation";

    const json: Record<string, unknown> = {
      id: encrypt(subscription.id),
      email,
      product_id: encrypt(link.id),
      product_name: link.name,
      user_id: user === null ? null : user.external_id,
      user_email: user === null ? null : user.email,
      // purchases.for_sales_api
      purchase_ids: list
        .filter(
          (purchase) =>
            ["successful", "not_charged"].includes(purchase.purchase_state) &&
            (purchase.purchase_state !== "not_charged" ||
              PurchaseFlags.isSet(purchase.flags, "is_free_trial_purchase")),
        )
        .map((purchase) => encrypt(purchase.id)),
      created_at: timeJson(subscription.created_at),
      user_requested_cancellation_at: timeJson(subscription.user_requested_cancellation_at),
      charge_occurrence_count: subscription.charge_occurrence_count,
      recurrence: price.recurrence,
      cancelled_at: timeJson(subscription.cancelled_at),
      ended_at: timeJson(subscription.ended_at),
      failed_at: timeJson(subscription.failed_at),
      free_trial_ends_at: timeJson(subscription.free_trial_ends_at),
      status,
    };
    // original_purchase.license_key: the license's serial for a licensed product (per-variant content decides otherwise)
    if (original !== undefined && LinkFlags.isSet(link.flags, "is_licensed")) {
      if (
        !LinkFlags.isSet(link.flags, "is_physical") &&
        variantJoins.some((join) => String(join.purchase_id) === String(original.id))
      )
        throw notPorted("variant-level license key content");
      const license = licenses.get(String(original.id));
      if (present(license?.serial)) json.license_key = license!.serial;
    }
    return json;
  });
}

// Subscription.active
export const ACTIVE_SUBSCRIPTION = (now: Date) =>
  Prisma.sql`(${column("subscriptions", "flags")} & ${SubscriptionFlags.bit("is_test_subscription")}) = 0 AND ${column("subscriptions", "failed_at")} IS NULL AND ${column("subscriptions", "ended_at")} IS NULL AND (${column("subscriptions", "cancelled_at")} IS NULL OR ${column("subscriptions", "cancelled_at")} > ${now})`;
