// Checkout::UpsellsController (app/controllers/checkout/upsells_controller.rb): #paged, #statistics and #destroy run in Node, and #index
// as a page (page-props/checkout-pages.ts). Checkout::Upsells::PausesController (pause and unpause) runs in Node too; an upsell that no
// longer validates is handed back whole, since update! would raise.
//
// #cart_item runs in Node through presenters/checkout-product.ts, which hands back what it cannot prove (rentals,
// physical products, PPP, merchant accounts).
//
// Handed to Rails: #create and #update (SaveUpsellService builds offer codes and rewrites variants and selected products), and #destroy of an upsell that has an offer code (OfferCode's save callbacks
// reindex products and clear caches). A sort by revenue or uses, a page past the last and a non-text parameter hand back as well.
import { Prisma, type Upsell, type UpsellVariant } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { UpsellDeletable, Upsells, UpsellVariantDeletable, UpsellVariants } from "../models/upsell.ts";
import { NotPortedError } from "../models/user.ts";
import { fetchUpsells, listParams } from "../page-props/checkout/upsells.ts";
import { authorize } from "../policies/authorize.ts";
import { checkoutUpsellPolicy } from "../policies/checkout-upsell.ts";
import { upsellsCartItem, checkoutProduct } from "../presenters/checkout-product.ts";
import { findLink } from "../presenters/product-reads.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, noContent } from "./seller-json.ts";

const UPSELLS = "upsells";
const queryString = (input: MutationInput) => input.url.search.replace(/^\?/u, "");

// `current_seller.upsells.find_by_external_id!(params[:id])`
export async function findUpsell(input: MutationInput, { alive }: { alive: boolean }, param = "id"): Promise<Upsell> {
  const id = decrypt(input.routeParams[param] ?? "");
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${table(UPSELLS)}.* FROM ${table(UPSELLS)} WHERE ${column(UPSELLS, "seller_id")} = ${input.context.currentSeller!.id} AND ${column(UPSELLS, "id")} = ${id}${alive ? Prisma.sql` AND ${column(UPSELLS, "deleted_at")} IS NULL` : Prisma.empty} LIMIT 1`,
        );
  if (row === undefined) throw new RoutingError("Not Found");
  return castRow<Upsell>("Upsell", row);
}

async function paged(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    (context) => checkoutUpsellPolicy.paged(context),
    async () => {
      const { upsells, pagination } = await fetchUpsells(
        input.context.currentSeller!.id,
        listParams(queryString(input)),
      );
      return json({ upsells, pagination });
    },
    { paramsRead: true },
  );
}

async function statistics(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (context) => {
      const upsell = await findUpsell(input, { alive: true });
      const denied = await authorizeJson(input, () => authorize(checkoutUpsellPolicy.statistics, context));
      if (denied) return denied;
      // Purchase.counts_towards_volume through upsell_purchases
      const records = await selectRows<{
        selected_product_id: bigint | null;
        upsell_variant_id: bigint | null;
        total_quantity: bigint | number;
        total_price_cents: bigint | number;
      }>(
        Prisma.sql`SELECT ${column("upsell_purchases", "selected_product_id")}, ${column("upsell_purchases", "upsell_variant_id")}, SUM(${column("purchases", "quantity")}) AS total_quantity, SUM(${column("purchases", "price_cents")}) AS total_price_cents FROM ${table("purchases")} INNER JOIN ${table("upsell_purchases")} ON ${column("purchases", "id")} = ${column("upsell_purchases", "purchase_id")} WHERE ${column("upsell_purchases", "upsell_id")} = ${upsell.id} AND ${column("purchases", "purchase_state")} = 'successful' AND (${column("purchases", "stripe_refunded")} IS NULL OR ${column("purchases", "stripe_refunded")} = 0) AND (${column("purchases", "chargeback_date")} IS NULL OR (${column("purchases", "chargeback_date")} IS NOT NULL AND ${column("purchases", "flags")} & ${Prisma.raw(String(CHARGEBACK_REVERSED))} != 0)) GROUP BY ${column("upsell_purchases", "selected_product_id")}, ${column("upsell_purchases", "upsell_variant_id")}`,
      );
      const selectedProducts: Record<string, bigint> = {};
      const upsellVariants: Record<string, bigint> = {};
      let total = 0n;
      let revenue = 0n;
      for (const record of records) {
        // ObfuscateIds.encrypt(nil) encrypts the empty string.
        const productId = encrypt(record.selected_product_id ?? "");
        selectedProducts[productId] = (selectedProducts[productId] ?? 0n) + BigInt(record.total_quantity);
        if (record.upsell_variant_id !== null)
          upsellVariants[encrypt(record.upsell_variant_id)] = BigInt(record.total_quantity);
        total += BigInt(record.total_quantity);
        revenue += BigInt(record.total_price_cents);
      }
      const asNumbers = (values: Record<string, bigint>) =>
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]));
      return json({
        uses: {
          total: Number(total),
          selected_products: asNumbers(selectedProducts),
          upsell_variants: asNumbers(upsellVariants),
        },
        revenue_cents: Number(revenue),
      });
    },
  );
}

const CHARGEBACK_REVERSED = PurchaseFlags.bit("chargeback_reversed");

async function cartItem(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    (context) => checkoutUpsellPolicy.cart_item(context),
    async () => {
      const permalink = input.params.product_id;
      if (typeof permalink !== "string") throw new HandBackToRails("a product_id that is not text");
      const id = decrypt(permalink);
      const [product] =
        id === null
          ? []
          : await selectRows<{ id: bigint }>(
              Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${input.context.currentSeller!.id} AND ${column("links", "id")} = ${id} LIMIT 1`,
            );
      if (product === undefined) throw new RoutingError("Not Found");
      const row = await findLink(product.id);
      // A product the presenter cannot prove throws NotPortedError, which the action turns into a hand back.
      return json(await upsellsCartItem(row!));
    },
    { paramsRead: true },
  );
}

// `@upsell.upsell_variants.each(&:mark_deleted)` then `@upsell.mark_deleted`. An upsell with a discount code goes to Rails whole, before any write.
export async function softDeleteUpsell(row: Upsell): Promise<void> {
  if (row.offer_code_id !== null) throw new HandBackToRails("an upsell with an offer code");

  const upsell = Upsells.load(row);
  // Rails deletes the variants before it learns the upsell no longer validates; check first so a hand-back writes nothing.
  upsell.set("deleted_at", new Date());
  if (!(await Upsells.valid(upsell))) throw new HandBackToRails("an upsell that no longer validates");
  upsell.set("deleted_at", row.deleted_at);

  const variants = await selectRows(
    Prisma.sql`SELECT ${table("upsell_variants")}.* FROM ${table("upsell_variants")} WHERE ${column("upsell_variants", "upsell_id")} = ${row.id} ORDER BY ${column("upsell_variants", "id")}`,
  );
  for (const variant of variants)
    await UpsellVariantDeletable.markDeleted(UpsellVariants.load(castRow<UpsellVariant>("UpsellVariant", variant)));
  if (!(await UpsellDeletable.markDeleted(upsell)))
    throw new NotPortedError("An upsell that fails to delete", "Checkout::UpsellsController#destroy");
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (context) => {
      const row = await findUpsell(input, { alive: false });
      const denied = await authorizeJson(input, () => authorize(checkoutUpsellPolicy.destroy, context, row));
      if (denied) return denied;
      await softDeleteUpsell(row);

      const { upsells, pagination } = await fetchUpsells(
        input.context.currentSeller!.id,
        listParams(queryString(input)),
      );
      return json({ success: true, upsells, pagination });
    },
  );
}

// `@upsell.update!(paused:)`; `pause?` and `unpause?` are both `update?`.
async function setPaused(input: MutationInput, paused: boolean): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async (context) => {
      const row = await findUpsell(input, { alive: true }, "upsell_id");
      const check = paused ? checkoutUpsellPolicy.pause : checkoutUpsellPolicy.unpause;
      const denied = await authorizeJson(input, () => authorize(check, context, row));
      if (denied) return denied;
      try {
        await Upsells.updateBang(Upsells.load(row), { paused });
      } catch (error) {
        // Validations run before the first statement, so Rails can take the request whole.
        if (error instanceof RecordInvalid) throw new HandBackToRails("an upsell that no longer validates");
        throw error;
      }
      return noContent();
    },
  );
}

registerMutations(
  { method: "GET", pattern: "/checkout/upsells/paged", skipForgeryProtection: true, run: paged },
  { method: "GET", pattern: "/checkout/upsells/cart_item", skipForgeryProtection: true, run: cartItem },
  { method: "GET", pattern: "/checkout/upsells/:id/statistics", skipForgeryProtection: true, run: statistics },
  { method: "DELETE", pattern: "/checkout/upsells/:id", json: true, run: destroy },
  { method: "POST", pattern: "/checkout/upsells/:upsell_id/pause", json: true, run: (input) => setPaused(input, true) },
  {
    method: "DELETE",
    pattern: "/checkout/upsells/:upsell_id/pause",
    json: true,
    run: (input) => setPaused(input, false),
  },
);
