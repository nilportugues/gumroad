// CheckoutController#update (PATCH and PUT /checkout), the cart save, for the lines Node can prove (checkout_cart_parity_spec.rb).
//
// Answered here: the three redirects with an alert (a cart that is not an object, more than Cart::MAX_ALLOWED_CART_PRODUCTS lines,
// a line without a product id), and a save of plain lines: the buyer's cart (by account, else by the browser guid) is created or
// updated, each line is created, updated or soft deleted, and only the columns that changed are written, as ActiveRecord does.
//
// Handed back whole before the first write: a line with an affiliate, an accepted offer, a call start time or installments, a
// product or variant that is not found (404 or a nil option), any value Rails would validate or cast in a way this does not follow
// (a quantity or price that is not a plain non-negative integer, url parameters that are not strings, a missing referrer, discount
// codes outside Cart::DISCOUNT_CODES_SCHEMA), a request without the guid cookie, and a cart holding two rows for one line.
import { Prisma } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { remoteIp, registerMutations, type MutationInput } from "./mutation.ts";
import { requestParams } from "./rails-body.ts";

const SEE_OTHER = 303;
const FOUND = 302;
// Cart::MAX_ALLOWED_CART_PRODUCTS, CartProduct::MAX_QUANTITY
const MAX_ALLOWED_CART_PRODUCTS = 50;
const MAX_QUANTITY = 2_147_483_647;
// Longest value of a varchar(255) column.
const MAX_VARCHAR_LENGTH = 255;
// Digits that stay exact as a JS number.
const MAX_SAFE_DIGITS = 15;
const GENERIC_ALERT = "Sorry, something went wrong. Please try again.";
const MISSING_PRODUCT_ALERT = "A product in your cart is missing. Refresh the page and try again.";
const TOO_MANY_PRODUCTS_ALERT = `You cannot add more than ${MAX_ALLOWED_CART_PRODUCTS} products to the cart.`;

type Json = Record<string, unknown>;
type Assignments = [string, unknown][];

export type CartRow = {
  id: bigint;
  return_url: string | null;
  discount_codes: unknown;
  reject_ppp_discount: number | boolean;
  email: string | null;
  browser_guid: string | null;
  ip_address: string | null;
};

export type LineRow = {
  id: bigint;
  product_id: bigint;
  option_id: bigint | null;
  affiliate_id: bigint | null;
  accepted_offer_id: bigint | null;
  price: bigint | number;
  quantity: number;
  recurrence: string | null;
  recommended_by: string | null;
  rent: number | boolean;
  url_parameters: unknown;
  referrer: string;
  recommender_model_name: string | null;
  call_start_time: Date | null;
  accepted_offer_details: unknown;
  pay_in_installments: number | boolean;
};

type DiscountCode = { code: string; fromUrl: boolean };

// One `items` entry, checked and cast without touching the database. `url_parameters` and `referrer` are undefined when the line
// leaves them alone.
export type PlannedLine = {
  productId: bigint;
  optionId: bigint | null;
  price: bigint;
  quantity: number;
  recurrence: string | null;
  recommendedBy: string | null;
  rent: boolean;
  urlParameters: Record<string, string> | undefined;
  referrer: string | undefined;
  recommenderModelName: string | null;
  externalProductId: string;
  externalOptionId: string | null;
};

type Plan = {
  email: string | null;
  returnUrl: string | null;
  rejectPppDiscount: boolean;
  discountCodes: DiscountCode[];
  lines: PlannedLine[];
};

const handBack = (reason: string): never => {
  throw new HandBackToRails(`checkout cart save ${reason}`);
};

const isObject = (value: unknown): value is Json =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

// `value.blank?` for a JSON scalar or list.
const blank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  (typeof value === "string" && /^[\s\u0085]*$/u.test(value)) ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);

// A varchar value: JSON text or null. Rails would cast anything else.
function text(value: unknown, what: string, limit?: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return handBack(`with ${what} that is not text`);
  if (limit !== undefined && [...value].length > limit) return handBack(`with ${what} longer than its column`);
  return value;
}

// ActiveModel::Type::Boolean#cast, for the values Node follows: JSON booleans, null and the blank string.
function booleanValue(value: unknown, what: string): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (value === true) return true;
  return handBack(`with ${what} that is not a boolean`);
}

// A whole number the way a client writes it: a JSON integer, or the digits of one without a leading zero (Integer("010") is octal).
function wholeNumber(value: unknown, what: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && new RegExp(`^(0|[1-9]\\d{0,${MAX_SAFE_DIGITS - 1}})$`, "u").test(value))
    return BigInt(value);
  return handBack(`with ${what} that is not a plain whole number`);
}

// `permit(discountCodes: [:code, :fromUrl])` followed by the schema Cart validates.
function discountCodesOf(value: unknown): DiscountCode[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return handBack("with discount codes that are not a list");
  return value.map((entry) => {
    if (!isObject(entry) || typeof entry.code !== "string" || typeof entry.fromUrl !== "boolean")
      return handBack("with discount codes that fail the cart schema");
    return { code: entry.code, fromUrl: entry.fromUrl };
  });
}

// `item[:product].blank? || item[:product][:id].blank?` after `permit(product: [:id])`, which drops a product that is not a hash and an
// id that is not a scalar.
function productMissing(item: Json): boolean {
  const { product } = item;
  if (!isObject(product)) return true;
  const { id } = product;
  return blank(id) || Array.isArray(id) || isObject(id);
}

// One line, or null for a quantity of zero (the frontend's way to remove it).
function plannedLine(item: Json): PlannedLine | null {
  const { product } = item;
  if (!isObject(product)) return handBack("with a product that is not an object");
  const externalProductId = product.id;
  if (typeof externalProductId !== "string") return handBack("with a product id that is not text");

  const quantity = wholeNumber(item.quantity, "a quantity");
  if (quantity === 0n) return null;
  if (quantity > BigInt(MAX_QUANTITY)) return handBack("with a quantity above the column");

  const affiliate = item.affiliate_id;
  if (!(affiliate === undefined || affiliate === null || affiliate === 0 || affiliate === "" || affiliate === "0"))
    return handBack("with an affiliate");
  const offer = item.accepted_offer;
  if (!(offer === undefined || offer === null || (isObject(offer) && blank(offer.id))))
    return handBack("with an accepted offer");
  if (!blank(item.call_start_time)) return handBack("with a call start time");
  if (
    !(item.pay_in_installments === undefined || item.pay_in_installments === null || item.pay_in_installments === false)
  )
    return handBack("paid in installments");

  const externalOptionId = item.option_id;
  if (!blank(externalOptionId) && typeof externalOptionId !== "string")
    return handBack("with an option id that is not text");
  const price = wholeNumber(item.price, "a price");

  const rawParameters = item.url_parameters;
  let urlParameters: Record<string, string> | undefined;
  if (rawParameters !== undefined && rawParameters !== null) {
    if (!isObject(rawParameters) || !Object.values(rawParameters).every((entry) => typeof entry === "string"))
      return handBack("with url parameters that are not a hash of strings");
    urlParameters = rawParameters as Record<string, string>;
  }
  const referrer = text(item.referrer, "a referrer") ?? undefined;
  if (referrer !== undefined && blank(referrer)) return handBack("with a blank referrer");

  return {
    productId: BigInt(0),
    optionId: null,
    price,
    quantity: Number(quantity),
    recurrence: text(item.recurrence, "a recurrence", MAX_VARCHAR_LENGTH),
    recommendedBy: text(item.recommended_by, "a recommender", MAX_VARCHAR_LENGTH),
    rent: booleanValue(item.rent, "a rent flag"),
    urlParameters,
    referrer,
    recommenderModelName: text(item.recommender_model_name, "a recommender model name", MAX_VARCHAR_LENGTH),
    externalProductId,
    externalOptionId: blank(externalOptionId) ? null : (externalOptionId as string),
  };
}

// The request's `cart` as CheckoutController#update reads it, or the alert it redirects with.
export function readPlan(params: MutationInput["params"]): Plan | { alert: string } {
  const cart = params.cart;
  if (!isObject(cart)) {
    // A scalar or list is refused with the alert; `{}` is a ParameterMissing (400) in Rails.
    if (
      Array.isArray(cart) ||
      cart === undefined ||
      cart === null ||
      typeof cart === "string" ||
      typeof cart === "number" ||
      typeof cart === "boolean"
    )
      return { alert: GENERIC_ALERT };
    return handBack("with a cart of an unknown type");
  }
  if (Object.keys(cart).length === 0) return handBack("with an empty cart object");

  const rawItems = cart.items;
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems))
    return handBack("with items that are not a list");
  const items = rawItems ?? [];
  if (!items.every(isObject)) return handBack("with an item that is not an object");
  if (items.length > MAX_ALLOWED_CART_PRODUCTS) return { alert: TOO_MANY_PRODUCTS_ALERT };
  if (items.some((item) => Array.isArray(item.product))) return handBack("with a product that is a list");
  if (items.some(productMissing)) return { alert: MISSING_PRODUCT_ALERT };

  const email = text(cart.email, "an email", MAX_VARCHAR_LENGTH);
  const lines = items.map(plannedLine).filter((line): line is PlannedLine => line !== null);
  return {
    email: email === null || blank(email) ? null : email,
    returnUrl: text(cart.returnUrl, "a return url"),
    rejectPppDiscount: booleanValue(cart.rejectPppDiscount, "a PPP flag"),
    discountCodes: discountCodesOf(cart.discountCodes),
    lines,
  };
}

const parsedJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return handBack("with a JSON column that does not parse");
  }
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}

const flag = (value: number | boolean): boolean => Boolean(value);

async function liveCart(userId: bigint | null, guid: string): Promise<CartRow | null> {
  const scope =
    userId === null
      ? Prisma.sql`${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL`
      : Prisma.sql`${column("carts", "user_id")} = ${userId}`;
  // `user.carts.alive.first` orders by id; the guest lookup has no order and one row is all the port proves.
  const rows = await selectRows<CartRow>(
    Prisma.sql`SELECT * FROM ${table("carts")} WHERE ${scope} AND ${column("carts", "deleted_at")} IS NULL ORDER BY ${column("carts", "id")} ASC LIMIT 2 FOR UPDATE`,
  );
  if (userId === null && rows.length > 1) return handBack("with two carts for one browser");
  return rows[0] ?? null;
}

const lastInsertId = async (): Promise<bigint> =>
  (await selectRows<{ id: bigint }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`))[0]!.id;

const jsonColumns = new Set(["discount_codes", "url_parameters", "accepted_offer_details"]);

function setClause(tableName: string, assignments: Assignments): Prisma.Sql {
  return Prisma.join(
    assignments.map(([name, value]) =>
      jsonColumns.has(name)
        ? Prisma.sql`${column(tableName, name)} = CAST(${JSON.stringify(value)} AS JSON)`
        : Prisma.sql`${column(tableName, name)} = ${value}`,
    ),
    ", ",
  );
}

const touchCart = (cartId: bigint, now: Date) =>
  execute(
    Prisma.sql`UPDATE ${table("carts")} SET ${column("carts", "updated_at")} = ${now} WHERE ${column("carts", "id")} = ${cartId}`,
  );

// The cart columns `save!` would write: the ones whose value differs from the row (a NULL `discount_codes` differs from [], which is
// Cart's after_initialize default).
export function cartChanges(
  row: CartRow,
  values: {
    email: string | null;
    returnUrl: string | null;
    rejectPppDiscount: boolean;
    discountCodes: DiscountCode[];
    ip: string;
    guid: string;
  },
): Assignments {
  const changes: Assignments = [];
  if (row.ip_address !== values.ip) changes.push(["ip_address", values.ip]);
  if (row.browser_guid !== values.guid) changes.push(["browser_guid", values.guid]);
  if (row.email !== values.email) changes.push(["email", values.email]);
  if (row.return_url !== values.returnUrl) changes.push(["return_url", values.returnUrl]);
  if (flag(row.reject_ppp_discount) !== values.rejectPppDiscount)
    changes.push(["reject_ppp_discount", values.rejectPppDiscount]);
  if (!sameJson(parsedJson(row.discount_codes), values.discountCodes))
    changes.push(["discount_codes", values.discountCodes]);
  return changes;
}

// CartProduct's after_initialize gives a NULL JSON column {}, which then counts as a change on any save of that row.
function defaultedJson(row: LineRow, changes: Assignments): void {
  for (const name of ["url_parameters", "accepted_offer_details"] as const) {
    if (row[name] === null && !changes.some(([changed]) => changed === name)) changes.push([name, {}]);
  }
}

export function lineChanges(row: LineRow, line: PlannedLine): Assignments {
  const changes: Assignments = [];
  if (row.affiliate_id !== null) changes.push(["affiliate_id", null]);
  if (row.accepted_offer_id !== null) changes.push(["accepted_offer_id", null]);
  if (row.accepted_offer_details !== null && !sameJson(parsedJson(row.accepted_offer_details), {}))
    changes.push(["accepted_offer_details", {}]);
  if (BigInt(row.price) !== line.price) changes.push(["price", line.price]);
  if (row.quantity !== line.quantity) changes.push(["quantity", line.quantity]);
  if (row.recurrence !== line.recurrence) changes.push(["recurrence", line.recurrence]);
  if (row.recommended_by !== line.recommendedBy) changes.push(["recommended_by", line.recommendedBy]);
  if (flag(row.rent) !== line.rent) changes.push(["rent", line.rent]);
  if (
    line.urlParameters !== undefined &&
    (row.url_parameters === null || !sameJson(parsedJson(row.url_parameters), line.urlParameters))
  )
    changes.push(["url_parameters", line.urlParameters]);
  if (line.referrer !== undefined && row.referrer !== line.referrer) changes.push(["referrer", line.referrer]);
  if (row.recommender_model_name !== line.recommenderModelName)
    changes.push(["recommender_model_name", line.recommenderModelName]);
  if (row.call_start_time !== null) changes.push(["call_start_time", null]);
  if (flag(row.pay_in_installments)) changes.push(["pay_in_installments", false]);
  defaultedJson(row, changes);
  return changes;
}

async function resolveReferences(lines: PlannedLine[]): Promise<void> {
  for (const line of lines) {
    const productId = decrypt(line.externalProductId);
    if (productId === null) handBack("with a product id that does not decode");
    line.productId = BigInt(productId!);
    if (line.externalOptionId !== null) {
      const optionId = decrypt(line.externalOptionId);
      if (optionId === null) handBack("with an option id that does not decode");
      line.optionId = BigInt(optionId!);
    }
  }
  const keys = new Set(lines.map((line) => `${line.productId}:${line.optionId ?? ""}`));
  if (keys.size !== lines.length) handBack("with a line repeated in one save");
  const productIds = [...new Set(lines.map((line) => line.productId))];
  if (productIds.length > 0) {
    const found = await selectRows(
      Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(productIds)})`,
    );
    if (found.length !== productIds.length) handBack("with a product that is not found");
  }
  const optionIds = [...new Set(lines.flatMap((line) => (line.optionId === null ? [] : [line.optionId])))];
  if (optionIds.length > 0) {
    const found = await selectRows(
      Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} IN (${Prisma.join(optionIds)})`,
    );
    if (found.length !== optionIds.length) handBack("with a variant that is not found");
  }
}

async function insertLine(cartId: bigint, line: PlannedLine, now: Date): Promise<void> {
  if (line.referrer === undefined) handBack("with a new line without a referrer");
  await execute(
    Prisma.sql`INSERT INTO ${table("cart_products")} (cart_id, product_id, option_id, affiliate_id, accepted_offer_id, price, quantity, recurrence, recommended_by, rent, url_parameters, referrer, recommender_model_name, created_at, updated_at, deleted_at, call_start_time, accepted_offer_details, pay_in_installments) VALUES (${cartId}, ${line.productId}, ${line.optionId}, NULL, NULL, ${line.price}, ${line.quantity}, ${line.recurrence}, ${line.recommendedBy}, ${line.rent}, CAST(${JSON.stringify(line.urlParameters ?? {})} AS JSON), ${line.referrer}, ${line.recommenderModelName}, ${now}, ${now}, NULL, NULL, CAST('{}' AS JSON), FALSE)`,
  );
}

async function save(input: MutationInput, plan: Plan): Promise<void> {
  const user = railsLoggedInUser(input.context);
  const guid = input.request.cookies.get("_gumroad_guid") ?? null;
  if (guid === null || guid === "") return handBack("without the browser guid");
  const ip = remoteIp(input.request);
  if (ip === null) return handBack("without a client address");
  await resolveReferences(plan.lines);

  await transaction(async () => {
    const now = new Date();
    // `logged_in_user&.email || params[:email].presence`
    const email = user?.email ?? plan.email;
    const values = {
      email,
      returnUrl: plan.returnUrl,
      rejectPppDiscount: plan.rejectPppDiscount,
      discountCodes: plan.discountCodes,
      ip,
      guid,
    };
    const existing = await liveCart(user?.id ?? null, guid);
    let cartId: bigint;
    let cartWritten = false;
    if (existing === null) {
      await execute(
        Prisma.sql`INSERT INTO ${table("carts")} (user_id, order_id, return_url, discount_codes, reject_ppp_discount, deleted_at, created_at, updated_at, email, browser_guid, ip_address) VALUES (${user?.id ?? null}, NULL, ${values.returnUrl}, CAST(${JSON.stringify(values.discountCodes)} AS JSON), ${values.rejectPppDiscount}, NULL, ${now}, ${now}, ${values.email}, ${guid}, ${ip})`,
      );
      cartId = await lastInsertId();
      cartWritten = true;
    } else {
      cartId = existing.id;
      const changes = cartChanges(existing, values);
      if (changes.length > 0) {
        await execute(
          Prisma.sql`UPDATE ${table("carts")} SET ${setClause("carts", changes)}, ${column("carts", "updated_at")} = ${now} WHERE ${column("carts", "id")} = ${cartId}`,
        );
        cartWritten = true;
      }
    }

    const alive = await selectRows<LineRow>(
      Prisma.sql`SELECT * FROM ${table("cart_products")} WHERE ${column("cart_products", "cart_id")} = ${cartId} AND ${column("cart_products", "deleted_at")} IS NULL ORDER BY ${column("cart_products", "id")} ASC`,
    );
    const keep = new Set<bigint>();
    let linesWritten = false;
    for (const line of plan.lines) {
      const matches = alive.filter(
        (row) => row.product_id === line.productId && (row.option_id ?? null) === line.optionId,
      );
      if (matches.length > 1) handBack("with two rows for one line");
      const row = matches[0];
      if (row === undefined) {
        await insertLine(cartId, line, now);
        linesWritten = true;
        continue;
      }
      keep.add(row.id);
      const changes = lineChanges(row, line);
      if (changes.length === 0) continue;
      await execute(
        Prisma.sql`UPDATE ${table("cart_products")} SET ${setClause("cart_products", changes)}, ${column("cart_products", "updated_at")} = ${now} WHERE ${column("cart_products", "id")} = ${row.id}`,
      );
      linesWritten = true;
    }
    // `mark_deleted(validate: false)` for every live row the request no longer carries, in id order.
    for (const row of alive.filter((candidate) => !keep.has(candidate.id))) {
      const changes: Assignments = [["deleted_at", now]];
      defaultedJson(row, changes);
      await execute(
        Prisma.sql`UPDATE ${table("cart_products")} SET ${setClause("cart_products", changes)}, ${column("cart_products", "updated_at")} = ${now} WHERE ${column("cart_products", "id")} = ${row.id}`,
      );
      linesWritten = true;
    }
    // belongs_to :cart, touch: true
    if (linesWritten && !cartWritten) await touchCart(cartId, now);
  });
}

async function update(input: MutationInput): Promise<ActionResult> {
  // Floats and integers past 2**53 stay distinguishable from the integers Rails would cast.
  const params = requestParams(input.url, input.request.headers.get("content-type"), input.rawBody, true);
  const plan = readPlan(params);
  if ("alert" in plan) return { status: FOUND, location: Routes.checkout_path(), flash: { alert: plan.alert } };
  await save(input, plan);
  return { status: SEE_OTHER, location: Routes.checkout_path() };
}

registerMutations(...["PUT", "PATCH"].map((method) => ({ method, pattern: "/checkout", run: update })));
