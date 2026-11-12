// Write side of app/models/price.rb and base_price.rb, for what `Product::Prices#price_cents=` saves on a persisted product through
// BasePrice::Shared#create_or_update_new_price!: the one live buy price (no recurrence, no rental) of a USD product that is not a
// membership, tier, rental, call, coffee or commission product. `planBuyPriceWrite` runs before the first statement and throws
// NotPortedError for anything else, so a product outside that shape goes to Rails with nothing written.
//
// Rails-recorded proof: spec/requests/api/v2/products_throttled_parity_spec.rb ("the price"), replayed by api-v2-throttled.replay; the
// order of the statements is pinned by link-update-writes.test.ts against the fixtures' `timeline`.
import { Prisma, type BasePrice, type Link } from "@prisma/client";

import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { enqueueLinkIndexUpdate, findLinkBang, invalidateProductCache, Links, LinkFlags } from "./link.ts";
import { defineModel } from "./runtime/define-model.ts";
import { participate } from "./runtime/transaction.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const PRICES = "prices";
// BasePrice::Shared::MAX_PRICE_CENTS
export const MAX_PRICE_CENTS = 2_147_483_647;
export const PRICE_TOO_LARGE = "Sorry, the price entered is too large.";
const RENTAL_BIT = 1n;
// Native types with their own price rules (a tier, a suggested-amount variant, a duration price, a quoted price) or no plain Price.
const NATIVE_TYPES_WITH_OWN_PRICES = ["membership", "coffee", "call", "commission", "bundle"];
const DIGITS = /^\d{1,15}$/u;

const notPorted = (what: string): never => {
  throw new NotPortedError(what, "app/modules/product/prices.rb:76");
};

const paperTrail = hasPaperTrail<BasePrice>("BasePrice", { itemType: "BasePrice" });

export const BasePrices = defineModel<BasePrice>({
  rubyClass: "Price",
  prismaModel: "BasePrice",
  delegate: (tx) => tx.basePrice as never,
  validations: [
    validatesPresenceOf<BasePrice>(["price_cents", "currency"]),
    {
      name: "validates :link, presence: true",
      async run(price) {
        const linkId = price.get("link_id");
        const rows =
          linkId == null
            ? []
            : await selectRows(
                Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "id")} = ${linkId} LIMIT 1`,
              );
        if (rows.length === 0) price.errors.add("link", "blank");
      },
    },
    // recurrence_validation only checks the prices of a recurring product, which planBuyPriceWrite refuses.
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [
    ...paperTrail.afterUpdate,
    {
      // belongs_to :link, touch: true is touch_later: the UPDATE of links.updated_at runs just before the outermost transaction commits.
      name: "touch_link",
      if: (price) => Object.keys(price.savedChanges).length > 0,
      run(price, ctx) {
        const linkId = price.get("link_id");
        if (linkId == null) return;
        participate({}, "update", () => ({
          prepare: async () => {
            await Links.touch(await findLinkBang(linkId), { now: ctx.now, deferred: true });
          },
          commit: async () => {},
          rollback: async () => {},
          restore: () => {},
        }));
      },
    },
  ],
  afterCommit: [
    {
      name: "invalidate_product_cache",
      async run(price, ctx) {
        const linkId = price.get("link_id");
        if (linkId != null) await invalidateProductCache(linkId, ctx.now);
      },
    },
  ],
});

export type BuyPricePlan = { cents: number } | { tooLarge: true };

// `price_cents.to_i` for a JSON integer or a text of digits; `price_cents.present?` is false for "", and everything else
// (fractions, signs, exponents, lists, null) casts in ways ActiveModel and String#to_i differ on.
export async function planBuyPriceWrite(product: Link, value: unknown): Promise<BuyPricePlan> {
  let cents: number;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) cents = value;
  else if (typeof value === "string" && DIGITS.test(value)) cents = Number(value);
  else return notPorted("a price that is not a whole number of cents");
  if (cents > MAX_PRICE_CENTS) return { tooLarge: true };

  if (product.price_currency_type !== "usd") notPorted("the price of a product that is not priced in USD");
  if (LinkFlags.isSet(product.flags, "is_recurring_billing") || LinkFlags.isSet(product.flags, "is_tiered_membership"))
    notPorted("the price of a membership");
  if (product.native_type !== null && NATIVE_TYPES_WITH_OWN_PRICES.includes(product.native_type))
    notPorted(`the price of a ${product.native_type} product`);
  if ((product.purchase_type ?? 0) !== 0) notPorted("the price of a product that is rented");
  if (LinkFlags.isSet(product.flags, "is_in_preorder_state") || LinkFlags.isSet(product.flags, "is_physical"))
    notPorted("the price of a preorder or physical product");
  // One live row, the buy price, which is the row create_or_update_new_price! updates; any other row changes what the product reads.
  const rows = await selectRows<{ id: number; recurrence: string | null; currency: string | null; flags: number }>(
    Prisma.sql`SELECT ${column(PRICES, "id")}, ${column(PRICES, "recurrence")}, ${column(PRICES, "currency")}, ${column(PRICES, "flags")} FROM ${table(PRICES)} WHERE ${column(PRICES, "link_id")} = ${product.id} AND ${column(PRICES, "deleted_at")} IS NULL`,
  );
  const [only] = rows;
  if (
    rows.length !== 1 ||
    only === undefined ||
    only.recurrence !== null ||
    only.currency !== "usd" ||
    (BigInt(only.flags) & RENTAL_BIT) !== 0n
  )
    notPorted("a product whose live prices are not a single buy price");
  return { cents };
}

// create_or_update_new_price!(price_cents:, recurrence: nil, is_rental: false) on a persisted product, inside the caller's transaction.
export async function writeBuyPrice(
  product: { id: bigint | number; price_currency_type: string | null },
  cents: number,
  now?: () => Date,
): Promise<void> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table(PRICES)} WHERE ${column(PRICES, "link_id")} = ${product.id} AND ${column(PRICES, "deleted_at")} IS NULL AND ${column(PRICES, "flags")} & 1 = 0 AND ${column(PRICES, "currency")} = ${product.price_currency_type} AND ${column(PRICES, "recurrence")} IS NULL ORDER BY ${column(PRICES, "id")} DESC LIMIT 1`,
  );
  if (row === undefined) return notPorted("a product with no live buy price");
  const price = BasePrices.load(castRow<BasePrice>("BasePrice", row));
  price.set("price_cents", cents);
  price.set("suggested_price_cents", null);
  const changed = price.hasChangesToSave();
  await BasePrices.saveBang(price, { now });
  if (changed) await enqueueLinkIndexUpdate(product.id, ["price_cents", "available_price_cents"], now);
}
