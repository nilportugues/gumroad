// PurchaseCustomFieldsController#create (app/controllers/purchase_custom_fields_controller.rb): the download page saves a buyer's answer
// to a post-purchase text or long text field on blur, authorised by the token of one of the purchase's URL redirects.
//
// Handed to Rails whole, before any write: an id that is a number or a boolean, a file field (Active Storage attach), a value that is
// not text or an integer, and a value over the TEXT column's size.
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

import { RecordInvalid } from "../models/runtime/errors.ts";

import {
  HandBackToRails,
  ParameterMissing,
  RoutingError,
  type ActionResult,
  type Rendered,
} from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestParams } from "./rails-body.ts";
import { noContent } from "./seller-json.ts";

// MySQL TEXT
const MAX_VALUE_BYTES = 65_535;
// CustomField::FIELD_TYPE_TO_NODE_TYPE_MAPPING.keys
const ANSWERABLE_TYPES = ["text", "long_text", "file"];

// `head :not_found`, for a request that asked for JSON.
const headNotFound = (): Rendered => ({ status: 404, body: "", contentType: "application/json", paramsRead: true });

// `permitted_params.require(key)`: a blank string is as missing as an absent one, and `permit` drops what is not a scalar, so an
// array or a hash is missing too (ParameterMissing, a 400). A number or a boolean is a scalar Rails would look up as such.
function required(input: MutationInput, key: string): string {
  const value = input.params[key];
  if (value === undefined || value === null || (typeof value === "string" && isBlank(value)) || typeof value === "object")
    throw new ParameterMissing();
  if (typeof value !== "string") throw new HandBackToRails(`a ${key} that is not text`);
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

// `value=` casts an Integer to its decimal text; a float, a boolean or a number past 2**53 is cast differently, and `permit` drops
// an array or a hash (the answer is then nil).
function answerOf(input: MutationInput): string | null {
  const submitted = input.params.value ?? null;
  if (submitted === null || typeof submitted === "string") return submitted;
  const exact = requestParams(input.url, input.request.headers.get("content-type"), input.rawBody, true).value;
  if (typeof exact === "number" && Number.isSafeInteger(exact)) return String(exact);
  throw new HandBackToRails("a value that is not text or an integer");
}

async function create(input: MutationInput): Promise<ActionResult> {
  const purchase = await findPurchase(required(input, "purchase_id"));
  if (!(await buyerCanWrite(input, purchase.id))) return headNotFound();

  const customField = await findCustomField(purchase.link_id, required(input, "custom_field_id"));
  if (customField.field_type === "file") throw new HandBackToRails("a file custom field");

  const submitted = answerOf(input);
  const value = normalizeValue(submitted);
  if (value !== null && Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new HandBackToRails("a value over the column's size");

  const existing = await findForCustomField(purchase.id, customField.id);
  const record = existing ?? buildFromCustomField(purchase.id, customField, value);
  if (existing) existing.set("value", value);
  // `save!` on a required field left blank
  if (!(await PurchaseCustomFields.save(record))) throw new RecordInvalid(record.errors);
  return noContent();
}

registerMutations({ method: "POST", pattern: "/purchase_custom_fields", json: true, run: create });
