// PurchaseCustomFieldsController#create (app/controllers/purchase_custom_fields_controller.rb): the download page saves a buyer's answer
// to a post-purchase text or long text field on blur, authorised by the token of one of the purchase's URL redirects.
//
// Handed to Rails whole, before any write: a missing or non-text parameter (ParameterMissing, or a value `permit` drops), a file field
// (Active Storage attach), a value Rails would reject (a required field left blank) and a value over the TEXT column's size.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { CustomFieldFlags } from "../models/custom-field.ts";
import {
  buildFromCustomField,
  findForCustomField,
  normalizeValue,
  PurchaseCustomFields,
} from "../models/purchase-custom-field.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { column, selectRows, table } from "../models/sql.ts";

import { HandBackToRails, RoutingError, type ActionResult, type Rendered } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { noContent } from "./seller-json.ts";

// MySQL TEXT
const MAX_VALUE_BYTES = 65_535;
// CustomField::FIELD_TYPE_TO_NODE_TYPE_MAPPING.keys
const ANSWERABLE_TYPES = ["text", "long_text", "file"];

// `head :not_found`, for a request that asked for JSON.
const headNotFound = (): Rendered => ({ status: 404, body: "", contentType: "application/json", paramsRead: true });

// `permitted_params.require(key)`: a blank string is as missing as an absent one, and `permit` drops anything that is not a scalar.
function required(input: MutationInput, key: string): string {
  const value = input.params[key];
  if (typeof value !== "string" || isBlank(value)) throw new HandBackToRails(`a missing or non-text ${key}`);
  return value;
}

// `Purchase.find_by_external_id!`
async function findPurchase(externalId: string): Promise<{ id: bigint; link_id: bigint | null }> {
  const id = decrypt(externalId);
  const [purchase] =
    id === null
      ? []
      : await selectRows<{ id: bigint; link_id: bigint | null }>(
          Prisma.sql`SELECT ${column("purchases", "id")}, ${column("purchases", "link_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${id} LIMIT 1`,
        );
  if (!purchase) throw new RoutingError("Not Found");
  return purchase;
}

// `UrlRedirect.exists?(token:, purchase_id:)`: a purchase id is not a download capability.
async function buyerCanWrite(input: MutationInput, purchaseId: bigint): Promise<boolean> {
  const token = input.params.token;
  if (typeof token !== "string" || isBlank(token)) return false;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("url_redirects")} WHERE ${column("url_redirects", "token")} = ${token} AND ${column("url_redirects", "purchase_id")} = ${purchaseId} LIMIT 1`,
  );
  return rows.length > 0;
}

// `purchase.link.custom_fields.is_post_purchase.where(type: ...).find_by_external_id!(id)`
async function findCustomField(productId: bigint | null, externalId: string) {
  const id = decrypt(externalId);
  const [field] =
    id === null || productId === null
      ? []
      : await selectRows<{ id: bigint; name: string | null; field_type: string | null }>(
          Prisma.sql`SELECT ${column("custom_fields", "id")}, ${column("custom_fields", "name")}, ${column("custom_fields", "field_type")} FROM ${table("custom_fields")} INNER JOIN ${table("custom_fields_products")} ON ${column("custom_fields_products", "custom_field_id")} = ${column("custom_fields", "id")} WHERE ${column("custom_fields_products", "product_id")} = ${productId} AND ${CustomFieldFlags.condition("is_post_purchase")} AND ${column("custom_fields", "field_type")} IN (${Prisma.join(ANSWERABLE_TYPES)}) AND ${column("custom_fields", "id")} = ${id} LIMIT 1`,
        );
  if (!field) throw new RoutingError("Not Found");
  return field;
}

async function create(input: MutationInput): Promise<ActionResult> {
  const purchase = await findPurchase(required(input, "purchase_id"));
  if (!(await buyerCanWrite(input, purchase.id))) return headNotFound();

  const customField = await findCustomField(purchase.link_id, required(input, "custom_field_id"));
  if (customField.field_type === "file") throw new HandBackToRails("a file custom field");

  const submitted = input.params.value ?? null;
  if (submitted !== null && typeof submitted !== "string") throw new HandBackToRails("a value that is not text");
  const value = normalizeValue(submitted);
  if (value !== null && Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new HandBackToRails("a value over the column's size");

  const existing = await findForCustomField(purchase.id, customField.id);
  const record = existing ?? buildFromCustomField(purchase.id, customField, value);
  if (existing) existing.set("value", value);
  if (!(await PurchaseCustomFields.save(record))) throw new HandBackToRails("a record Rails would not save");
  return noContent();
}

registerMutations({ method: "POST", pattern: "/purchase_custom_fields", json: true, run: create });
