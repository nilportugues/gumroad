// Port of app/services/merge_carts_service.rb as ApplicationController#merge_guest_cart_with_user_cart calls it after a sign-in: the
// guest cart of this browser (`Cart.fetch_by(user: nil, browser_guid:)`) goes into the user's alive cart, or becomes it.
//
// `planGuestCartMerge` reads and decides before the sign-in writes anything; `mergeGuestCart` writes in the order Rails does
// (copied lines, the target cart, then the source cart's soft delete) inside one transaction. Handed to Rails, whole, before any
// write: more than one candidate cart on either side, discount codes or cart lines that fail Cart's and CartProduct's validations
// (Rails would take its rescue path: log, notify, delete the guest cart), and a line that would collide with the target's unique
// (cart, product, deleted_at) index.
import { Prisma } from "@prisma/client";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";

type CartRow = {
  id: bigint;
  user_id: bigint | null;
  return_url: string | null;
  discount_codes: unknown;
  reject_ppp_discount: number | boolean;
  email: string | null;
  browser_guid: string | null;
};

type LineRow = {
  id: bigint;
  product_id: bigint;
  option_id: bigint | null;
  price: bigint | number;
  quantity: number;
  referrer: string;
  url_parameters: unknown;
  accepted_offer_details: unknown;
};

type DiscountCode = Record<string, unknown>;

export type GuestCartMerge = {
  source: CartRow;
  target: CartRow | null;
  userId: bigint;
  userEmail: string | null;
  browserGuid: string;
  copiedLineIds: bigint[];
  discountCodes: DiscountCode[];
};

const OFFER_DETAIL_KEYS = ["original_product_id", "original_variant_id"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A JSON column as Prisma hands it back: parsed, or still text.
function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new HandBackToRails("a JSON column that does not parse");
  }
}

// Cart::DISCOUNT_CODES_SCHEMA: an array of objects holding a text `code` and a boolean `fromUrl`.
function discountCodesOf(value: unknown): DiscountCode[] {
  const parsed = parsedJson(value) ?? [];
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => isObject(entry) && typeof entry.code === "string" && typeof entry.fromUrl === "boolean")
  )
    throw new HandBackToRails("discount codes that do not conform to the cart schema");
  return parsed as DiscountCode[];
}

// CartProduct validations on the copy: presence of price, quantity and referrer, their ranges, and the two JSON schemas.
function assertValidLine(line: LineRow): void {
  const urlParameters = parsedJson(line.url_parameters) ?? {};
  const offerDetails = parsedJson(line.accepted_offer_details) ?? {};
  const valid =
    line.referrer.trim() !== "" &&
    Number.isInteger(line.quantity) &&
    line.quantity > 0 &&
    BigInt(line.price) >= 0n &&
    isObject(urlParameters) &&
    Object.values(urlParameters).every((value) => typeof value === "string") &&
    isObject(offerDetails) &&
    Object.entries(offerDetails).every(
      ([key, value]) => OFFER_DETAIL_KEYS.includes(key) && (value === null || typeof value === "string"),
    );
  if (!valid) throw new HandBackToRails("a cart line that fails CartProduct validations");
}

const aliveLines = (cartId: bigint) =>
  selectRows<LineRow>(
    Prisma.sql`SELECT * FROM ${table("cart_products")} WHERE ${column("cart_products", "cart_id")} = ${cartId} AND ${column("cart_products", "deleted_at")} IS NULL ORDER BY ${column("cart_products", "id")} ASC`,
  );

const blank = (value: string | null): boolean => value === null || value.trim() === "";
const presence = (value: string | null): string | null => (blank(value) ? null : value);

// Null when there is nothing to merge: no guest cart, or one without live lines (Rails skips the service then).
export async function planGuestCartMerge(
  guid: string | null | undefined,
  user: { id: bigint; email: string | null },
): Promise<GuestCartMerge | null> {
  if (!guid) return null;
  const guests = await selectRows<CartRow>(
    Prisma.sql`SELECT * FROM ${table("carts")} WHERE ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL AND ${column("carts", "deleted_at")} IS NULL LIMIT 2`,
  );
  if (guests.length === 0) return null;
  if (guests.length > 1) throw new HandBackToRails("more than one guest cart for a browser");
  const source = guests[0]!;
  const sourceLines = await aliveLines(source.id);
  if (sourceLines.length === 0) return null;

  const targets = await selectRows<CartRow>(
    Prisma.sql`SELECT * FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${user.id} AND ${column("carts", "deleted_at")} IS NULL LIMIT 2`,
  );
  if (targets.length > 1) throw new HandBackToRails("more than one alive cart for a user");
  const target = targets[0] ?? null;

  const sourceCodes = discountCodesOf(source.discount_codes);
  const targetLines = target === null ? [] : await aliveLines(target.id);
  const targetCodes = target === null ? [] : discountCodesOf(target.discount_codes);
  const owned = new Set(targetLines.map((line) => `${line.product_id}:${line.option_id ?? ""}`));
  const ownedProducts = new Set(targetLines.map((line) => line.product_id));
  const copied = target === null ? [] : sourceLines.filter((line) => !owned.has(`${line.product_id}:${line.option_id ?? ""}`));
  for (const line of copied) {
    if (ownedProducts.has(line.product_id)) throw new HandBackToRails("a line that collides with the target cart's index");
    assertValidLine(line);
  }
  const codes = [...targetCodes];
  for (const code of sourceCodes) if (!codes.some((existing) => existing.code === code.code)) codes.push(code);

  return {
    source,
    target,
    userId: user.id,
    userEmail: user.email,
    browserGuid: guid,
    copiedLineIds: copied.map((line) => line.id),
    discountCodes: target === null ? sourceCodes : codes,
  };
}

// MergeCartsService#process, in one transaction.
export async function mergeGuestCart(plan: GuestCartMerge, now: Date): Promise<void> {
  const { source, target, userId, userEmail, browserGuid } = plan;
  await transaction(async () => {
    if (target === null) {
      // `source_cart.update!(user:, browser_guid:, email:)` with the target cart nil
      const email = presence(source.email) ?? userEmail;
      await updateCart(source, [["user_id", userId], ["browser_guid", browserGuid], ["email", email]], now);
      return;
    }
    for (const id of plan.copiedLineIds) {
      await execute(
        Prisma.sql`INSERT INTO ${table("cart_products")} (cart_id, product_id, option_id, affiliate_id, accepted_offer_id, price, quantity, recurrence, recommended_by, rent, url_parameters, referrer, recommender_model_name, created_at, updated_at, deleted_at, call_start_time, accepted_offer_details, pay_in_installments) SELECT ${target.id}, product_id, option_id, affiliate_id, accepted_offer_id, price, quantity, recurrence, recommended_by, rent, IFNULL(url_parameters, JSON_OBJECT()), referrer, recommender_model_name, ${now}, ${now}, deleted_at, call_start_time, IFNULL(accepted_offer_details, JSON_OBJECT()), pay_in_installments FROM ${table("cart_products")} WHERE id = ${id}`,
      );
    }
    const assignments: [string, unknown][] = [];
    const targetCodes = target.discount_codes === null ? null : JSON.stringify(parsedJson(target.discount_codes));
    const mergedCodes = JSON.stringify(plan.discountCodes);
    if (targetCodes !== mergedCodes) assignments.push(["discount_codes", mergedCodes]);
    if (blank(target.return_url) && source.return_url !== target.return_url) assignments.push(["return_url", source.return_url]);
    if (Boolean(source.reject_ppp_discount) && !Boolean(target.reject_ppp_discount)) assignments.push(["reject_ppp_discount", true]);
    if (target.user_id !== userId) assignments.push(["user_id", userId]);
    if (target.browser_guid !== browserGuid) assignments.push(["browser_guid", browserGuid]);
    const email = presence(target.email) ?? presence(source.email) ?? userEmail;
    if (target.email !== email) assignments.push(["email", email]);
    // belongs_to :cart, touch: true bumps the target for every copied line, and save! writes the changes with updated_at.
    if (assignments.length > 0 || plan.copiedLineIds.length > 0) await updateCart(target, assignments, now);
    await updateCart(source, [["deleted_at", now]], now);
  });
}

// Cart's after_initialize turns a NULL `discount_codes` into [], which every save of that cart then writes.
async function updateCart(cart: CartRow, assignments: [string, unknown][], now: Date): Promise<void> {
  const columns: [string, unknown][] = [...assignments];
  if (cart.discount_codes === null && !columns.some(([name]) => name === "discount_codes"))
    columns.push(["discount_codes", "[]"]);
  columns.push(["updated_at", now]);
  const jsonColumns = new Set(["discount_codes"]);
  const sets = Prisma.join(
    columns.map(([name, value]) =>
      jsonColumns.has(name)
        ? Prisma.sql`${column("carts", name)} = CAST(${value} AS JSON)`
        : Prisma.sql`${column("carts", name)} = ${value}`,
    ),
    ", ",
  );
  await execute(Prisma.sql`UPDATE ${table("carts")} SET ${sets} WHERE ${column("carts", "id")} = ${cart.id}`);
}
