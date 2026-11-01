// Installment::Searchable and AudienceMember::Searchable: documents built from the row alone.
import type { Row } from "../../models/runtime/record.ts";
import type { JsonValue } from "../es-json.ts";
import { INSTALLMENT_FLAG_MAPPING, selectedFlags } from "../flags.ts";
import { attributeAsJson, findById, jsonColumn } from "../rows.ts";

export const INSTALLMENT_SEARCH_FIELDS = ["id", "message", "name", "seller_id", "workflow_id", "created_at", "deleted_at", "published_at", "selected_flags"] as const;

export const INSTALLMENT_ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string | string[]> = {
  id: "id",
  name: "name",
  message: "message",
  seller_id: "seller_id",
  workflow_id: "workflow_id",
  created_at: "created_at",
  deleted_at: "deleted_at",
  published_at: "published_at",
  flags: "selected_flags",
};

export const AUDIENCE_MEMBER_SEARCH_FIELDS = [
  "seller_id", "email", "customer", "follower", "affiliate", "min_paid_cents", "max_paid_cents", "min_created_at", "max_created_at",
  "min_purchase_created_at", "max_purchase_created_at", "follower_id", "follower_created_at", "min_affiliate_created_at",
  "max_affiliate_created_at", "purchases", "affiliates",
] as const;

export const AUDIENCE_MEMBER_ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string | string[]> = {
  seller_id: "seller_id",
  email: "email",
  customer: "customer",
  follower: "follower",
  affiliate: "affiliate",
  min_paid_cents: "min_paid_cents",
  max_paid_cents: "max_paid_cents",
  min_created_at: "min_created_at",
  max_created_at: "max_created_at",
  min_purchase_created_at: "min_purchase_created_at",
  max_purchase_created_at: "max_purchase_created_at",
  follower_created_at: "follower_created_at",
  min_affiliate_created_at: "min_affiliate_created_at",
  max_affiliate_created_at: "max_affiliate_created_at",
  details: ["purchases", "follower_id", "affiliates"],
};

const PURCHASE_DETAIL_KEYS = ["id", "product_id", "variant_ids", "price_cents", "created_at", "country", "subscription_cancelled", "license_uses"];
const AFFILIATE_DETAIL_KEYS = ["id", "product_id", "created_at"];

export class InstallmentRecord {
  readonly row: Row;
  constructor(row: Row) {
    this.row = row;
  }

  static async find(id: unknown): Promise<InstallmentRecord | null> {
    const row = await findById("Installment", "installments", id);
    return row ? new InstallmentRecord(row) : null;
  }

  async searchFieldValue(field: string): Promise<JsonValue> {
    if (field === "selected_flags") return selectedFlags(INSTALLMENT_FLAG_MAPPING, this.row.flags as bigint);
    return attributeAsJson(this.row[field]);
  }

  async asIndexedJson(only?: readonly string[]): Promise<Record<string, JsonValue>> {
    const document: Record<string, JsonValue> = {};
    for (const field of only ?? INSTALLMENT_SEARCH_FIELDS) document[field] = await this.searchFieldValue(field);
    return document;
  }
}

// Array.wrap
const wrap = (value: JsonValue | undefined): JsonValue[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

// Hash#slice: the given keys that are present, in the order given.
function slice(hash: JsonValue, keys: string[]): JsonValue {
  if (hash === null || typeof hash !== "object" || Array.isArray(hash)) throw new TypeError("undefined method 'slice'");
  const record = hash as Record<string, JsonValue>;
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]!]));
}

export class AudienceMemberRecord {
  readonly row: Row;
  constructor(row: Row) {
    this.row = row;
  }

  static async find(id: unknown): Promise<AudienceMemberRecord | null> {
    const row = await findById("AudienceMember", "audience_members", id);
    return row ? new AudienceMemberRecord(row) : null;
  }

  async searchFieldValue(field: string): Promise<JsonValue> {
    const details = (jsonColumn(this.row.details) ?? {}) as Record<string, JsonValue>;
    switch (field) {
      case "purchases":
        return wrap(details.purchases).map((entry) => slice(entry, PURCHASE_DETAIL_KEYS));
      case "affiliates":
        return wrap(details.affiliates).map((entry) => slice(entry, AFFILIATE_DETAIL_KEYS));
      case "follower_id": {
        const follower = details.follower;
        return follower && typeof follower === "object" && !Array.isArray(follower) ? ((follower as Record<string, JsonValue>).id ?? null) : null;
      }
      default:
        return attributeAsJson(this.row[field]);
    }
  }

  async asIndexedJson(only?: readonly string[]): Promise<Record<string, JsonValue>> {
    const document: Record<string, JsonValue> = {};
    for (const field of only ?? AUDIENCE_MEMBER_SEARCH_FIELDS) document[field] = await this.searchFieldValue(field);
    return document;
  }
}
