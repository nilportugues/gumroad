// Port of the record side of app/models/audience_member.rb (callbacks, validations, derived columns) and of
// AudienceMember::Searchable's ElasticsearchModelAsyncCallbacks. The filter side lives in audience-member.ts.
//
// Not ported, and refused with NotPortedError: a stored row whose details are null (compact_details raises in Ruby),
// and `refresh!`.
import { Prisma, type AudienceMember } from "@prisma/client";

import { performAsync } from "./concerns/job-runtime.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { isValidEmailFormat, NotPortedError } from "./user.ts";

export type AudienceMemberRecord = ModelRecord<AudienceMember>;
export type Details = Record<string, unknown>;

const ELASTICSEARCH_INDEX_DELAY_SECONDS = 2;
const ELASTICSEARCH_UPDATE_DELAY_SECONDS = 4;
const COMMITTED = "attributesCommitted";
const CHANGED_IN_TRANSACTION = "attributesChangedInTransaction";

// AudienceMember::Searchable::ATTRIBUTE_TO_SEARCH_FIELDS
const ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string[]> = {
  seller_id: ["seller_id"],
  email: ["email"],
  customer: ["customer"],
  follower: ["follower"],
  affiliate: ["affiliate"],
  min_paid_cents: ["min_paid_cents"],
  max_paid_cents: ["max_paid_cents"],
  min_created_at: ["min_created_at"],
  max_created_at: ["max_created_at"],
  min_purchase_created_at: ["min_purchase_created_at"],
  max_purchase_created_at: ["max_purchase_created_at"],
  follower_created_at: ["follower_created_at"],
  min_affiliate_created_at: ["min_affiliate_created_at"],
  max_affiliate_created_at: ["max_affiliate_created_at"],
  details: ["purchases", "follower_id", "affiliates"],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// String#blank?: `[[:space:]]*`.
const BLANK_STRING = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

// Object#blank? for the values a details hash holds.
function blankValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return BLANK_STRING.test(value);
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

// `details.compact_blank`, then `compact_blank!` of each purchase and affiliate.
export function compactDetails(details: Details): Details {
  const compacted: Details = {};
  for (const [key, value] of Object.entries(details)) if (!blankValue(value)) compacted[key] = value;
  for (const key of ["purchases", "affiliates"]) {
    const list = compacted[key];
    if (!Array.isArray(list)) continue;
    compacted[key] = (list as unknown[]).map((element) =>
      isObject(element)
        ? Object.fromEntries(Object.entries(element).filter(([, value]) => !blankValue(value)))
        : element,
    );
  }
  return compacted;
}

const isInteger = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value);

function matches(value: unknown, properties: Record<string, (v: unknown) => boolean>, required: string[]): boolean {
  if (!isObject(value)) return false;
  if (!required.every((key) => key in value)) return false;
  return Object.entries(value).every(([key, item]) => properties[key]?.(item) === true);
}

// lib/json_schemas/audience_member_details.json (draft-06), as JSON::Validator.fully_validate judges it.
export function detailsValid(details: unknown): boolean {
  if (!isObject(details)) return false;
  const purchase = (v: unknown) =>
    matches(
      v,
      {
        id: isInteger,
        country: (x) => typeof x === "string",
        created_at: (x) => typeof x === "string",
        product_id: isInteger,
        variant_ids: (x) => Array.isArray(x) && x.length >= 1 && x.every(isInteger),
        price_cents: isInteger,
        subscription_cancelled: (x) => typeof x === "boolean",
        license_uses: isInteger,
      },
      ["id", "created_at", "product_id", "price_cents"],
    );
  const follower = (v: unknown) =>
    matches(v, { id: isInteger, created_at: (x) => typeof x === "string" }, ["id", "created_at"]);
  const affiliate = (v: unknown) =>
    matches(v, { id: isInteger, created_at: (x) => typeof x === "string", product_id: isInteger }, [
      "id",
      "created_at",
      "product_id",
    ]);
  const nonEmptyList = (item: (v: unknown) => boolean) => (v: unknown) =>
    Array.isArray(v) && v.length >= 1 && v.every(item);
  const checks: Record<string, (v: unknown) => boolean> = {
    purchases: nonEmptyList(purchase),
    follower,
    affiliates: nonEmptyList(affiliate),
  };
  if (!Object.entries(details).every(([key, item]) => checks[key]?.(item) === true)) return false;
  return "purchases" in details || "follower" in details || "affiliates" in details;
}

// Array#minmax over ISO strings (String#<=>), or over numbers.
function minmax<T extends string | number>(values: T[]): [T | null, T | null] {
  if (values.length === 0) return [null, null];
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [sorted[0]!, sorted.at(-1)!];
}

// A datetime(0) column casts an ISO string to a Time and drops the fraction.
function castTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : new Date(Math.floor(time.getTime() / 1000) * 1000);
}

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : value == null ? [] : [value as Record<string, unknown>];

function assignDerivedColumns(record: AudienceMemberRecord): void {
  const details = (record.get("details") ?? {}) as Details;
  const purchases = list(details.purchases);
  const affiliates = list(details.affiliates);
  const created = (items: Record<string, unknown>[]) =>
    items.map((item) => item.created_at).filter((v): v is string => v != null);
  record.set("customer", !blankValue(details.purchases));
  record.set("follower", !blankValue(details.follower));
  record.set("affiliate", !blankValue(details.affiliates));
  const [minPaid, maxPaid] = minmax(purchases.map((p) => p.price_cents).filter((v): v is number => v != null));
  record.set("min_paid_cents", minPaid);
  record.set("max_paid_cents", maxPaid);
  const [minPurchase, maxPurchase] = minmax(created(purchases));
  record.set("min_purchase_created_at", castTime(minPurchase));
  record.set("max_purchase_created_at", castTime(maxPurchase));
  const followerCreatedAt = isObject(details.follower)
    ? ((details.follower.created_at as string | undefined) ?? null)
    : null;
  record.set("follower_created_at", castTime(followerCreatedAt));
  const [minAffiliate, maxAffiliate] = minmax(created(affiliates));
  record.set("min_affiliate_created_at", castTime(minAffiliate));
  record.set("max_affiliate_created_at", castTime(maxAffiliate));
  const times = [
    "min_purchase_created_at",
    "max_purchase_created_at",
    "follower_created_at",
    "min_affiliate_created_at",
    "max_affiliate_created_at",
  ]
    .map((name) => record.get(name as "follower_created_at"))
    .filter((value): value is Date => value != null)
    .map((value) => value.getTime());
  const [minAll, maxAll] = minmax(times);
  record.set("min_created_at", minAll === null ? null : new Date(minAll));
  record.set("max_created_at", maxAll === null ? null : new Date(maxAll));
}

export const AudienceMembers = defineModel<AudienceMember>({
  rubyClass: "AudienceMember",
  prismaModel: "AudienceMember",
  delegate: (tx) => tx.audienceMember as never,
  beforeValidation: [
    {
      name: "compact_details",
      run(record) {
        const details = record.get("details");
        if (!isObject(details))
          throw new NotPortedError(
            "An audience member whose details are not a hash",
            "app/models/audience_member.rb compact_details",
          );
        record.set("details", compactDetails(details) as AudienceMember["details"]);
      },
    },
    {
      name: "normalize_email",
      if: (record) => !isBlank(record.get("email")),
      run(record) {
        record.set("email", record.get("email").trim().toLowerCase());
      },
    },
  ],
  validations: [
    {
      name: "validates :email, email_format: true, presence: true",
      run(record) {
        const email = record.get("email");
        if (!isValidEmailFormat(email)) record.errors.add("email", "invalid");
        if (isBlank(email)) record.errors.add("email", "blank");
      },
    },
    {
      name: "details_json_has_valid_format",
      run(record) {
        if (!detailsValid(record.get("details"))) record.errors.add("details", "invalid");
      },
    },
  ],
  beforeSave: [{ name: "assign_derived_columns", run: assignDerivedColumns }],
  afterSave: [
    {
      name: "TransactionalAttributeChangeTracker after_save",
      run(record) {
        record.ivars[COMMITTED] = null;
        const changed = (record.ivars[CHANGED_IN_TRANSACTION] ??= new Set<string>()) as Set<string>;
        for (const name of Object.keys(record.savedChanges)) changed.add(name);
      },
    },
  ],
  beforeCommit: [
    {
      name: "TransactionalAttributeChangeTracker before_commit",
      run(record) {
        const changed = record.ivars[CHANGED_IN_TRANSACTION] as Set<string> | undefined;
        if (changed === undefined) return;
        record.ivars[COMMITTED] = [...changed];
        changed.clear();
      },
    },
  ],
  afterCommit: [
    {
      name: "send_to_elasticsearch",
      on: "create",
      async run(record) {
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["index", { record_id: record.get("id"), class_name: "AudienceMember" }],
          { delaySeconds: ELASTICSEARCH_INDEX_DELAY_SECONDS },
        );
      },
    },
    {
      name: "send_to_elasticsearch",
      on: "update",
      async run(record) {
        const committed = (record.ivars[COMMITTED] as string[] | undefined) ?? [];
        const fields = [...new Set(committed.flatMap((name) => ATTRIBUTE_TO_SEARCH_FIELDS[name] ?? []))];
        if (fields.length === 0) return;
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["update", { record_id: record.get("id"), class_name: "AudienceMember", fields }],
          { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS },
        );
      },
    },
    {
      name: "send_to_elasticsearch",
      on: "destroy",
      async run(record) {
        await performAsync(
          "ElasticsearchIndexerWorker",
          ["delete", { record_id: record.get("id"), class_name: "AudienceMember" }],
          { delaySeconds: ELASTICSEARCH_UPDATE_DELAY_SECONDS },
        );
      },
    },
  ],
});

// `AudienceMember.find_by(email:, seller:)`
export async function findAudienceMember(email: string, sellerId: bigint): Promise<AudienceMemberRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`audience_members`.*")} FROM ${table("audience_members")} WHERE ${column("audience_members", "email")} = ${email} AND ${column("audience_members", "seller_id")} = ${sellerId} LIMIT 1`,
  );
  if (!row) return null;
  const cast = castRow<AudienceMember>("AudienceMember", row);
  // The driver may hand a JSON column back as text.
  if (typeof cast.details === "string") cast.details = JSON.parse(cast.details) as AudienceMember["details"];
  return AudienceMembers.load(cast);
}

// `find_or_initialize_by(email:, seller:)`: the new record starts with `details = {}` (assign_default_details_value).
export async function findOrInitializeAudienceMember(email: string, sellerId: bigint): Promise<AudienceMemberRecord> {
  return (
    (await findAudienceMember(email, sellerId)) ??
    AudienceMembers.build({ email, seller_id: sellerId, details: {} as AudienceMember["details"] })
  );
}
