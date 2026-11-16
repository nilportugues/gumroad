// Checkout::FormController#update (app/controllers/checkout/form_controller.rb).
//
// Whatever the port cannot prove goes to Rails whole, before the first write: a `user` or `custom_fields` that is not a hash or a list,
// a flag that is not a boolean, a float for a string attribute, product ids that are not strings.
import type { CustomField } from "@prisma/client";
import { Prisma } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt, encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { CustomFieldFlags, CustomFields, type CustomFieldRecord } from "../models/custom-field.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { transaction, type Tx } from "../models/runtime/transaction.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { findUserBang, setFlag, Users, type UserFlag, type UserRecord } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { checkoutFormPolicy } from "../policies/checkout-form.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { isPermittedScalar, stringValue, toSentence } from "./settings-mutations.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const FLASH_CHANGES_SAVED = "Changes saved!";
// FlagShihTzu::TRUE_VALUES
const TRUE_VALUES: unknown[] = [true, 1, "1", "t", "T", "true", "TRUE"];
const USER_FLAGS: UserFlag[] = [
  "display_offer_code_field",
  "tipping_enabled",
  "ach_payments_enabled",
  "gifting_disabled",
  "link_disabled",
  "paypal_card_funding_disabled",
];
const FIELD_KEYS = ["id", "type", "name", "required", "global", "collect_per_product", "products"];

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type FieldParams = {
  id: unknown;
  // `field.except(:id, :products)`, in the order the params arrive.
  attributes: [string, unknown][];
  global: boolean;
  products: string[];
};

// A boolean attribute: JSON true, false or null. Rails would cast any other type in ways the port does not follow.
function booleanValue(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new HandBackToRails("a custom field flag that is not a boolean");
}

// `permit(custom_fields: [[:id, :type, :name, :required, :global, :collect_per_product, { products: [] }]])`
function permittedField(entry: unknown): FieldParams {
  if (!isHash(entry)) throw new HandBackToRails("a custom field that is not a hash");
  const field: FieldParams = { id: undefined, attributes: [], global: false, products: [] };
  for (const [key, value] of Object.entries(entry)) {
    if (!FIELD_KEYS.includes(key)) continue;
    if (key === "products") {
      // An array of scalars is permitted; anything else under it is dropped.
      if (!Array.isArray(value)) continue;
      if (!value.every((id) => typeof id === "string")) throw new HandBackToRails("product ids that are not strings");
      field.products = value as string[];
      continue;
    }
    if (!isPermittedScalar(value)) continue;
    if (key === "id") field.id = value;
    else if (key === "type") field.attributes.push(["field_type", stringValue(value)]);
    else if (key === "name") field.attributes.push(["name", stringValue(value)]);
    else {
      const flag = booleanValue(value);
      field.attributes.push([key, flag]);
      if (key === "global") field.global = flag === true;
    }
  }
  return field;
}

export function permittedParams(params: MutationInput["params"]): {
  user: Record<string, unknown> | null;
  customFields: FieldParams[] | null;
} {
  const { user, custom_fields: customFields } = params;
  if (user !== undefined && user !== null && !isHash(user)) throw new HandBackToRails("a user that is not a hash");
  if (customFields !== undefined && customFields !== null && !Array.isArray(customFields))
    throw new HandBackToRails("custom fields that are not a list");
  return {
    user: user ?? null,
    customFields: customFields === undefined || customFields === null ? null : customFields.map(permittedField),
  };
}

// `current_seller.update!(permitted_params[:user])`: the permitted scalars, in the order they arrive.
async function updateUser(seller: UserRecord, user: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(user)) {
    if (!isPermittedScalar(value)) continue;
    if (USER_FLAGS.includes(key as UserFlag)) setFlag(seller, key as UserFlag, TRUE_VALUES.includes(value));
    else if (key === "recommendation_type") seller.set("recommendation_type", stringValue(value) as never);
  }
  await Users.saveBang(seller);
}

function assign(field: CustomFieldRecord, attributes: [string, unknown][]): void {
  for (const [name, value] of attributes) {
    if (name === "collect_per_product")
      field.set("flags", CustomFieldFlags.set(field.get("flags"), name, TRUE_VALUES.includes(value)));
    else field.set(name as keyof CustomField, value as never);
  }
}

// `current_seller.products.by_external_ids(ids)`: the seller's products, deleted ones included, by id.
async function sellerProductIds(sellerId: bigint, externalIds: string[]): Promise<bigint[]> {
  const ids = externalIds.map((id) => decrypt(id)).filter((id): id is number => id !== null);
  if (ids.length === 0) return [];
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "id")} IN (${Prisma.join(ids)}) ORDER BY ${column("links", "id")} ASC`,
  );
  return rows.map((row) => row.id);
}

// `field.products = products`: delete the join rows of products that left, insert those that arrived, in order.
async function replaceProducts(tx: Tx, fieldId: bigint, productIds: bigint[]): Promise<void> {
  const current = await selectRows<{ product_id: bigint }>(
    Prisma.sql`SELECT ${column("custom_fields_products", "product_id")} FROM ${table("custom_fields_products")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("custom_fields_products", "product_id")} WHERE ${column("custom_fields_products", "custom_field_id")} = ${fieldId} ORDER BY ${column("custom_fields_products", "id")} ASC`,
  );
  const present = new Set(current.map((row) => row.product_id));
  const wanted = new Set(productIds);
  const removed = [...present].filter((id) => !wanted.has(id));
  if (removed.length > 0)
    await tx.customFieldsProduct.deleteMany({ where: { custom_field_id: fieldId, product_id: { in: removed } } });
  const now = new Date();
  for (const productId of productIds.filter((id) => !present.has(id))) {
    await tx.customFieldsProduct.create({
      data: { custom_field_id: fieldId, product_id: productId, created_at: now, updated_at: now },
    });
  }
}

async function updateCustomFields(tx: Tx, sellerId: bigint, fields: FieldParams[]): Promise<void> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`custom_fields`.*")} FROM ${table("custom_fields")} WHERE ${column("custom_fields", "seller_id")} = ${sellerId} ORDER BY ${column("custom_fields", "id")} ASC`,
  );
  const remaining = rows.map((row) => CustomFields.load(castRow<CustomField>("CustomField", row)));
  for (const params of fields) {
    // `all_fields.extract! { _1.external_id == field[:id] }[0]`
    const index =
      typeof params.id === "string"
        ? remaining.findIndex((candidate) => externalId(candidate.get("id")) === params.id)
        : -1;
    const existing = index === -1 ? CustomFields.build({ seller_id: sellerId }) : remaining.splice(index, 1)[0]!;
    assign(existing, params.attributes);
    await CustomFields.saveBang(existing);
    await replaceProducts(
      tx,
      existing.get("id"),
      params.global ? [] : await sellerProductIds(sellerId, params.products),
    );
  }
  for (const leftover of remaining) {
    await tx.customFieldsProduct.deleteMany({ where: { custom_field_id: leftover.get("id") } });
    await CustomFields.destroy(leftover);
  }
}

async function update(input: MutationInput): Promise<ActionResult> {
  const denied = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (context) => authorize(checkoutFormPolicy.update, context),
  );
  if (denied) return denied;

  const { user, customFields } = permittedParams(input.params);
  const seller = await findUserBang(input.context.currentSeller!.id);
  try {
    await transaction(async (tx) => {
      if (user) await updateUser(seller, user);
      if (customFields) await updateCustomFields(tx, seller.get("id"), customFields);
    });
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    const messages = error.errors.fullMessages();
    return {
      status: FOUND,
      location: Routes.checkout_form_path(),
      flash: { alert: toSentence(messages) },
      inertiaErrors: { base: messages },
    };
  }
  return { status: SEE_OTHER, location: Routes.checkout_form_path(), flash: { notice: FLASH_CHANGES_SAVED } };
}

registerMutations(...["PUT", "PATCH"].map((method) => ({ method, pattern: "/checkout/form", run: update })));
