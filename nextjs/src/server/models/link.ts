// Port of app/models/link.rb and the concerns it includes, for updating a stored product.
// Callbacks and validations run in Rails' declaration order and send ActiveRecord's statements
// (golden: __fixtures__/link-writes.golden.json, scripts/golden/link-writes.rb).
//
// Only `banned_at` may change: the guard below refuses creating, destroying and every other
// change with NotPortedError before any SQL, since permalink generation and claims, prices,
// offer codes, licenses, publishing and content moderation are still Ruby-only.
import { Prisma, type Link, type ProductCachedValue } from "@prisma/client";
import type { Redis } from "ioredis";

import { defineFlags } from "../../lib/flags.ts";
import { railsCache } from "../cache/rails-cache.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";

import { isAdult } from "./concerns/adult-keyword-detector.ts";
import { getUsdCents as helperGetUsdCents } from "./concerns/currency-helper.ts";
import { deletable } from "./concerns/deletable.ts";
import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import {
  jsonData,
  jsonDataForAttr,
  jsonGet,
  mergeJsonDataWithCurrentRow,
  setJsonDataForAttr,
  toHash,
} from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import {
  associationCache,
  loadBelongsTo,
  setAssociation,
  validatesUniqueness,
  type BelongsTo,
} from "./concerns/rails-validations.ts";
import { rubyJsonGenerate, rubyJsonParse } from "./concerns/serialized-columns.ts";
import LINK_DATA from "./link-data.generated.json" with { type: "json" };
import { redirectRenamedPermalinks } from "./link-permalink-redirects.ts";
import { freshScope, PRODUCT_CACHED_VALUES, ProductCachedValues } from "./product-cached-value.ts";
import { defineModel, type Callback, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord, Row } from "./runtime/record.ts";
import {
  isBlank,
  rubyLength,
  validatesInclusionOf,
  validatesLengthOf,
  validatesPresenceOf,
} from "./runtime/validators.ts";
import { castRow, column, selectRows, table, execute } from "./sql.ts";
import {
  isReservedEmailDomain,
  isValidEmailFormat,
  MAX_PRICE_USD_CENTS_UNLESS_VERIFIED,
  NotPortedError,
} from "./user.ts";

export type LinkRecord = ModelRecord<Link>;

export const CUSTOM_PERMALINK_MAX_LENGTH = 255;
export const MAX_NAME_LENGTH = 255;
export const DEFAULT_BOOSTED_DISCOVER_FEE_PER_THOUSAND = 300;
const MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH = 26;
const MAX_CUSTOM_RECEIPT_TEXT_LENGTH = 500;
const MAX_CUSTOM_FAILED_PAYMENT_TEXT_LENGTH = 500;
export const MAX_PURCHASE_COUNT_RANGE = [0, 10_000_000] as const;
const MIN_PRICE_CENTS = -2_147_483_648;
const MAX_PRICE_CENTS = 2_147_483_647;
const NON_PLAIN_TEXT_PATTERN = /[<>]|https?:|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/iu;
// PURCHASE_PROPERTIES: a save that only moves these does not invalidate the product cache.
const PURCHASE_PROPERTIES = ["updated_at"];
// User::ReputationSummary::ROLLUP_LINK_COLUMNS
const ROLLUP_LINK_COLUMNS = ["deleted_at", "purchase_disabled_at", "banned_at", "draft", "flags", "user_id"];
const REPUTATION_SUMMARY_FEATURE = "seller_reputation_summary";
// Product::Searchable::ATTRIBUTE_TO_SEARCH_FIELDS_MAP, for the columns a ported update can change.
// The order is the Ruby map's: it decides the order of the fields in the enqueued job.
const ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string[]> = {
  name: ["name", "rated_as_adult"],
  description: ["description", "rated_as_adult"],
  purchase_disabled_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  deleted_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  banned_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  max_purchase_count: ["is_recommendable"],
  taxonomy_id: ["taxonomy_id", "taxonomy_attribute_filters", "is_recommendable"],
  content_updated_at: ["content_updated_at"],
  archived: ["is_recommendable", "is_alive_on_profile"],
  display_product_reviews: ["display_product_reviews", "is_recommendable"],
  is_adult: ["rated_as_adult"],
  customizable_price: ["customizable_price"],
};
// The columns an update may change; Rails' own callbacks also write updated_at and json_data. `flags` is ported for PORTED_FLAG_BITS only.
const PORTED_CHANGES = [
  "custom_permalink",
  "banned_at",
  "purchase_disabled_at",
  "flags",
  "deleted_at",
  "name",
  "description",
  "draft",
  "first_published_at",
  "customizable_price",
  "suggested_price_cents",
  "max_purchase_count",
  "taxonomy_id",
  "custom_receipt",
  "content_updated_at",
];
// The only json_data keys a ported update writes: `attr_json_data_accessor :sections, :main_section_index, :custom_summary`, the receipt
// texts and additional details of update_product, and the inferred taxonomy values.
const PORTED_JSON_DATA_KEYS = [
  "sections",
  "main_section_index",
  "custom_summary",
  "custom_attributes",
  "custom_receipt_text",
  "custom_view_content_button_text",
  "inferred_taxonomy_attribute_values",
];
const ARCHIVED_BIT = 1n << 4n;
// Flag N is bit N - 1: archived, is_adult, display_product_reviews, should_show_sales_count and transcode_videos_on_purchase (set by a publish).
const IS_ADULT_BIT = 1n << 15n;
const DISPLAY_PRODUCT_REVIEWS_BIT = 1n << 16n;
const SHOULD_SHOW_SALES_COUNT_BIT = 1n << 21n;
const TRANSCODE_VIDEOS_ON_PURCHASE_BIT = 1n << 23n;
const QUANTITY_ENABLED_BIT = 1n << 13n;
// Bundles::ContentController writes it; no callback of Link reads it (bundle-content-update-... fixtures).
const HAS_OUTDATED_PURCHASES_BIT = 1n << 14n;
// is_collab: only Collaborator and ProductAffiliate callbacks write it, and no Link callback or search field reads it.
const IS_COLLAB_BIT = 1n << 27n;
// product_refund_policy_enabled: POST /v2/products switches it on with the policy it saves; no Link callback or search field reads it.
const PRODUCT_REFUND_POLICY_ENABLED_BIT = 1n << 0n;
const PORTED_FLAG_BITS =
  PRODUCT_REFUND_POLICY_ENABLED_BIT |
  QUANTITY_ENABLED_BIT |
  HAS_OUTDATED_PURCHASES_BIT |
  ARCHIVED_BIT |
  IS_ADULT_BIT |
  DISPLAY_PRODUCT_REVIEWS_BIT |
  SHOULD_SHOW_SALES_COUNT_BIT |
  TRANSCODE_VIDEOS_ON_PURCHASE_BIT |
  IS_COLLAB_BIT;
const SEARCH_FLAG_BITS: Record<string, bigint> = {
  archived: ARCHIVED_BIT,
  is_adult: IS_ADULT_BIT,
  display_product_reviews: DISPLAY_PRODUCT_REVIEWS_BIT,
};

export const NATIVE_TYPES_TO_TAX_CODE = {
  digital: "31000",
  course: "86132000A0002",
  ebook: "31000",
  newsletter: "55111516A0310",
  membership: "55111516A0310",
  podcast: "55111516A0310",
  audiobook: "31000",
  physical: null,
  bundle: "55111500A9220",
  commission: null,
  call: null,
  coffee: null,
} as const;
export const NATIVE_TYPES = Object.keys(NATIVE_TYPES_TO_TAX_CODE) as (keyof typeof NATIVE_TYPES_TO_TAX_CODE)[];
const INSTALLMENT_PLAN_NATIVE_TYPES = ["call", "course", "digital", "ebook", "bundle"];

const DISCOVER_FEES_PER_THOUSAND = [100, ...Array.from({ length: 701 }, (_, i) => 300 + i)];
// enum :purchase_type / :subscription_duration (integer columns).
const PURCHASE_TYPES = ["buy_only", "rent_only", "buy_and_rent"] as const;
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"] as const;
// BasePrice::Recurrence::RECURRENCE_TO_NUMBER_OF_MONTHS
const RECURRENCE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  biannually: 6,
  yearly: 12,
  every_two_years: 24,
};

type CurrencyData = {
  min_price: number;
  single_unit: boolean;
  min_price_formatted: string;
  double_min_price_in_currency: string;
  min_price_in_currency: string;
  symbol: string;
};
// CURRENCY_CHOICES (config/currencies.json) and the messages Money formats from it.
const CURRENCIES = LINK_DATA.currencies as Record<string, CurrencyData>;

// Bit positions are persisted data: never renumber or reuse without resetting the column first.
export const LinkFlags = defineFlags(
  "links",
  {
    1: "product_refund_policy_enabled",
    2: "is_recurring_billing",
    3: "free_trial_enabled",
    4: "is_in_preorder_state",
    5: "archived",
    6: "is_duplicating",
    7: "is_licensed",
    8: "is_physical",
    9: "skus_enabled",
    10: "block_access_after_membership_cancellation",
    11: "is_price_tax_exclusive_DEPRECATED",
    12: "should_include_last_post",
    13: "from_bundle_marketing",
    14: "quantity_enabled",
    15: "has_outdated_purchases",
    16: "is_adult",
    17: "display_product_reviews",
    18: "allow_double_charges",
    19: "is_tiered_membership",
    20: "should_show_all_posts",
    21: "is_multiseat_license",
    22: "should_show_sales_count",
    23: "is_epublication",
    24: "transcode_videos_on_purchase",
    25: "has_same_rich_content_for_all_variants",
    26: "is_bundle",
    27: "purchasing_power_parity_disabled",
    28: "is_collab",
    29: "is_unpublished_by_admin",
    30: "community_chat_enabled",
    31: "created_via_cli",
    32: "DEPRECATED_moderated_by_iffy",
    33: "hide_sold_out_variants",
    34: "hide_bundle_product_reviews",
    35: "waitlist_enabled",
  },
  { queryMode: "bit_operator" },
);
export type LinkFlag = (typeof LinkFlags.names)[number];

// Link::LinkInvalid
export class LinkInvalid extends Error {
  readonly rubyClass = "Link::LinkInvalid";
  constructor(message: string) {
    super(message);
    this.name = "LinkInvalid";
  }
}

class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

export type LinkCollaborators = {
  isFeatureEnabled(name: string, actor?: string | null): Promise<boolean>;
  // $redis, for exchange rates and the reputation summary version.
  redis(): Pick<Redis, "get" | "incr">;
  // Rails.cache.delete
  cacheDelete(name: string): Promise<unknown>;
};
const DEFAULT_COLLABORATORS: LinkCollaborators = {
  isFeatureEnabled: (name, actor) => isFeatureEnabled(name, actor),
  redis: () => getRedis("main"),
  cacheDelete: (name) => railsCache().delete(name),
};
let collaborators: LinkCollaborators = { ...DEFAULT_COLLABORATORS };
export function setLinkCollaborators(overrides: Partial<LinkCollaborators>): void {
  collaborators = { ...collaborators, ...overrides };
}
export function resetLinkCollaborators(): void {
  collaborators = { ...DEFAULT_COLLABORATORS };
}

// ---------------------------------------------------------------------------------------------
// Readers

export const isFlagSet = (link: LinkRecord, flag: LinkFlag) => LinkFlags.isSet(link.get("flags"), flag);
const purchaseType = (link: LinkRecord) => PURCHASE_TYPES[link.get("purchase_type") ?? -1] ?? null;
const rentOnly = (link: LinkRecord) => purchaseType(link) === "rent_only";
const buyable = (link: LinkRecord) => ["buy_only", "buy_and_rent"].includes(purchaseType(link) ?? "");
const rentable = (link: LinkRecord) => ["rent_only", "buy_and_rent"].includes(purchaseType(link) ?? "");
const subscriptionDuration = (link: LinkRecord) =>
  SUBSCRIPTION_DURATIONS[link.get("subscription_duration") ?? -1] ?? null;
export const isPublished = (link: LinkRecord) =>
  link.get("deleted_at") == null && link.get("purchase_disabled_at") == null && !link.get("draft");
const currency = (link: LinkRecord) => CURRENCIES[link.get("price_currency_type") ?? ""];
// Link#currency for a row: CURRENCY_CHOICES[price_currency_type].
export const currencyOf = (type: string | null): CurrencyData | undefined => CURRENCIES[type ?? ""];

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };
const DEFAULT_OFFER_CODE: BelongsTo = {
  name: "default_offer_code",
  foreignKey: "default_offer_code_id",
  targetTable: "offer_codes",
  targetModel: "OfferCode",
};

const eq = (tableName: string, name: string, value: unknown) =>
  value == null ? Prisma.sql`${column(tableName, name)} IS NULL` : Prisma.sql`${column(tableName, name)} = ${value}`;
const exists = async (sql: Prisma.Sql) => (await selectRows(sql)).length > 0;

type PriceRow = { price_cents: number | null; recurrence: string | null; flags: unknown };
const isRental = (price: PriceRow) => (BigInt((price.flags as bigint | number | null) ?? 0) & 1n) === 1n;

// prices_for_currency: alive_prices is never preloaded here, so every call queries.
function pricesForCurrency(link: LinkRecord): Promise<PriceRow[]> {
  return selectRows<PriceRow>(
    Prisma.sql`SELECT ${Prisma.raw("`prices`.*")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${link.get("id")} AND ${column("prices", "deleted_at")} IS NULL AND ${eq("prices", "currency", link.get("price_currency_type"))}`,
  );
}

async function defaultPrice(link: LinkRecord): Promise<PriceRow | undefined> {
  if (rentOnly(link)) return (await pricesForCurrency(link)).filter(isRental).at(-1);
  let relevant = (await pricesForCurrency(link)).filter((p) => !isRental(p));
  const duration = subscriptionDuration(link);
  if (isFlagSet(link, "is_recurring_billing") && duration !== null)
    relevant = relevant.filter((p) => p.recurrence === duration);
  return relevant.at(-1);
}

async function buyPriceCents(link: LinkRecord): Promise<number | null> {
  if (!buyable(link) || !(await defaultPrice(link))) return null;
  return (await defaultPrice(link))!.price_cents;
}

async function rentalPriceCents(link: LinkRecord): Promise<number | null> {
  if (!rentable(link)) return null;
  return (await pricesForCurrency(link)).filter(isRental).at(-1)?.price_cents ?? null;
}

// Product::Prices#default_price_cents (and #price_cents, its alias).
export function defaultPriceCents(link: LinkRecord): Promise<number | null> {
  return rentOnly(link) ? rentalPriceCents(link) : buyPriceCents(link);
}

async function loadUser(link: LinkRecord, ctx: CallbackContext): Promise<Row | null> {
  return loadBelongsTo(link, USER, ctx);
}

// CurrencyHelper#get_usd_cents.
export async function getUsdCents(currencyType: string, quantity: number): Promise<number> {
  if (currencyType === "usd") return quantity;
  const code = currencyType.toUpperCase();
  const rate = await collaborators.redis().get(`currencies:${code}`);
  const rateFloat = rate == null ? 0 : Number.parseFloat(rate);
  // query_rate: the rates document, then the cache write; the helper's port is golden-tested against Rails.
  if (!(rateFloat > 0)) return helperGetUsdCents(currencyType, quantity);
  const converted = new Prisma.Decimal(quantity).div(rateFloat);
  return (CURRENCIES[currencyType]?.single_unit ? converted.mul(100) : converted)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

// ---------------------------------------------------------------------------------------------
// Callbacks, in link.rb's declaration order (included concerns first).

const flagsDiff = (link: LinkRecord) => BigInt(link.get("flags") ?? 0) ^ BigInt(link.attributeWas("flags") ?? 0);
const attributeChangedForSearch = (link: LinkRecord, key: string) =>
  key in SEARCH_FLAG_BITS
    ? (flagsDiff(link) & SEARCH_FLAG_BITS[key]!) !== 0n
    : link.attributeChanged(key as keyof Link & string);
const changedForSearch = (link: LinkRecord) =>
  Object.keys(ATTRIBUTE_TO_SEARCH_FIELDS).flatMap((key) =>
    attributeChangedForSearch(link, key) ? ATTRIBUTE_TO_SEARCH_FIELDS[key]! : [],
  );

// The json_data keys whose value differs from the stored row.
function changedJsonDataKeys(link: LinkRecord): string[] {
  const was = link.attributeInDatabase("json_data");
  const base = (was == null ? null : toHash(rubyJsonParse(was))) ?? new RubyHash([]);
  const mine = jsonData(link);
  const keys = [...new Set([...base.entries, ...mine.entries].map(([key]) => key as string))];
  return keys.filter((key) => {
    const [before, after] = [jsonGet(base, key), jsonGet(mine, key)];
    return (
      (before === undefined) !== (after === undefined) ||
      (before !== undefined && rubyJsonGenerate(before) !== rubyJsonGenerate(after!))
    );
  });
}

// `product.sections = ids; product.main_section_index = index`: the profile sections of the product page and which one leads.
export function assignProductSections(link: LinkRecord, sectionIds: number[], mainSectionIndex: number): void {
  setJsonDataForAttr(link, "sections", sectionIds as YamlValue);
  setJsonDataForAttr(link, "main_section_index", mainSectionIndex);
}

// `product.sections`: the stored ids, [] when blank.
export function productSections(link: LinkRecord): number[] {
  const value = jsonDataForAttr(link, "sections", []);
  return Array.isArray(value) ? value.map(Number) : [];
}

// claiming_custom_permalink?: the seller row is locked and the other products are read FOR UPDATE.
const claimingCustomPermalink = (link: LinkRecord) =>
  !isBlank(link.get("custom_permalink")) && link.attributeChanged("custom_permalink");
const TAKEN_PERMALINK = "is already used by another one of your products";
const FORCE_PRODUCT_ID_TIMESTAMP_KEY = "force_product_id_timestamp";
// @staged_renamed_custom_permalinks: staged per save, redirected once the outer transaction commits.
const stagedPermalinks = new WeakMap<object, string[]>();

const refuseUnportedSave: Callback<Link> = {
  name: "(guard) refuse unported changes",
  run(link) {
    if (link.newRecord)
      throw new NotPortedError(
        "Link#save on a new record",
        "app/models/link.rb:225 (associate_price, permalink generation, after_create)",
      );
    link.untracked(() => {
      const jsonDataUnported =
        link.attributeChanged("json_data") &&
        changedJsonDataKeys(link).some((key) => !PORTED_JSON_DATA_KEYS.includes(key));
      const unported = link
        .changedAttributeNames()
        .filter((name) => (name === "json_data" ? jsonDataUnported : !PORTED_CHANGES.includes(name)));
      if (unported.length > 0)
        throw new NotPortedError(`Link#save changing ${unported.join(", ")}`, "app/models/link.rb");
      if (link.attributeChanged("flags") && (flagsDiff(link) & ~PORTED_FLAG_BITS) !== 0n)
        throw new NotPortedError(
          "Link#save changing flags other than archived, is_adult, display_product_reviews, should_show_sales_count, transcode_videos_on_purchase, quantity_enabled, has_outdated_purchases, is_collab and product_refund_policy_enabled",
          "app/models/link.rb",
        );
      if (link.get("unique_permalink") == null)
        throw new NotPortedError("Link#generate_unique_permalink", "app/models/link.rb:1882");
    });
  },
};

const beforeValidation: Callback<Link>[] = [
  refuseUnportedSave,
  {
    // MaxPurchaseCount: the assignment happens even when the value is already in range.
    name: "constrain_max_purchase_count_within_range",
    run(link) {
      const count = link.get("max_purchase_count");
      if (count == null) return;
      link.set(
        "max_purchase_count",
        Math.min(Math.max(count, MAX_PURCHASE_COUNT_RANGE[0]), MAX_PURCHASE_COUNT_RANGE[1]),
      );
    },
  },
  {
    // set_unique_permalink is a no-op (the guard refuses a nil permalink). serialize_permalink_checks?
    // only asks will_save_change_to_* questions, which a ported update always answers false.
    name: "lock_seller_for_permalink_checks",
    async run(link) {
      if (link.get("user_id") == null) return;
      if (link.attributeChanged("deleted_at") && link.get("deleted_at") == null) return;
      if (claimingCustomPermalink(link))
        await selectRows(
          Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} = ${link.get("user_id")} LIMIT 1 FOR UPDATE`,
        );
    },
  },
  {
    // `user.links.deleted.find_by(custom_permalink:)&.update(custom_permalink: nil)`. A deleted product that has no permalink is
    // assigned nil again, which changes nothing; one that holds the slug is released with its own callbacks, which are not ported.
    name: "release_custom_permalink_if_possible",
    if: (link) => link.attributeChanged("custom_permalink"),
    async run(link) {
      const [deleted] = await selectRows(
        Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${link.get("user_id")} AND ${column("links", "deleted_at")} IS NOT NULL AND ${eq("links", "custom_permalink", link.get("custom_permalink"))} LIMIT 1`,
      );
      if (deleted && link.get("custom_permalink") != null)
        throw new NotPortedError("Link#release_custom_permalink_if_possible", "app/models/link.rb:2200");
    },
  },
];

const validations: Callback<Link>[] = [
  // MaxPurchaseCount's numericality check: the before_validation above already clamped the value.
  {
    name: "validates :user, presence: true",
    async run(link, ctx) {
      if ((await loadUser(link, ctx)) === null) link.errors.add("user", "blank");
    },
  },
  validatesPresenceOf<Link>(["name"]),
  validatesLengthOf<Link>(["name"], { maximum: MAX_NAME_LENGTH }),
  {
    name: "validates :support_email, email_format: true, not_reserved_email_domain: true, allow_nil: true",
    run(link) {
      const email = link.get("support_email");
      if (email == null) return;
      if (!isValidEmailFormat(email)) link.errors.add("support_email", "invalid");
      if (isReservedEmailDomain(email)) link.errors.add("support_email", "is reserved");
    },
  },
  {
    name: "validates :default_price_cents, presence: true",
    async run(link) {
      // Reading the enum and building the alive_prices scope materialize the attributes in this
      // order, which PaperTrail's `object` then follows.
      link.attributeChanged("purchase_type");
      link.materializeAll();
      if ((await defaultPriceCents(link)) == null) link.errors.add("default_price_cents", "blank");
    },
  },
  validatesPresenceOf<Link>(["unique_permalink"]),
  validatesUniqueness<Link>("Link", "links", "unique_permalink"),
  {
    name: "validates :unique_permalink, format: /\\A[a-zA-Z_]+\\z/",
    run(link) {
      if (!/^[a-zA-Z_]+$/u.test(String(link.get("unique_permalink") ?? "")))
        link.errors.add("unique_permalink", "invalid");
    },
  },
  {
    name: "validates :custom_permalink, format:, length:, allow_blank: true",
    run(link) {
      const value = link.get("custom_permalink");
      if (isBlank(value)) return;
      if (!/^[a-zA-Z0-9_-]+$/u.test(value!))
        link.errors.add("custom_permalink", "invalid", {
          message: "can only contain letters, numbers, dashes, and underscores",
        });
      if (rubyLength(value) > CUSTOM_PERMALINK_MAX_LENGTH) {
        link.errors.add("custom_permalink", "too_long", {
          count: CUSTOM_PERMALINK_MAX_LENGTH,
          message: `must be ${CUSTOM_PERMALINK_MAX_LENGTH} characters or fewer`,
        });
      }
    },
  },
  {
    ...validatesUniqueness<Link>("Link", "links", "custom_permalink", {
      scope: ["user_id"],
      message: "is already used by another one of your products",
    }),
    unless: (link) => isBlank(link.get("custom_permalink")),
  },
  {
    name: "suggested_price_greater_than_price",
    async run(link) {
      const suggested = link.get("suggested_price_cents");
      if (isBlank(suggested) || !link.get("customizable_price")) return;
      const price = await defaultPriceCents(link);
      if (price == null || suggested! >= (await defaultPriceCents(link))!) return;
      link.errors.add("base", "The suggested price you entered was too low.");
    },
  },
  {
    name: "suggested_price_must_be_within_storage_range",
    run(link) {
      const suggested = link.get("suggested_price_cents");
      if (suggested == null || (suggested >= MIN_PRICE_CENTS && suggested <= MAX_PRICE_CENTS)) return;
      link.errors.add(
        "base",
        suggested > 0
          ? "Sorry, the suggested price entered is too large."
          : "Sorry, the suggested price entered is too low.",
      );
    },
  },
  {
    name: "duration_multiple_of_price_options",
    async run(link) {
      const duration = link.get("duration_in_months");
      if (!isFlagSet(link, "is_recurring_billing") || duration == null) return;
      if (duration <= 0) {
        link.errors.add("base", "Your subscription length in months must be a number greater than zero.");
        return;
      }
      const rows = await selectRows<{ recurrence: string | null }>(
        Prisma.sql`SELECT ${column("prices", "recurrence")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${link.get("id")} AND ${column("prices", "deleted_at")} IS NULL`,
      );
      for (const { recurrence } of rows) {
        const months = RECURRENCE_MONTHS[recurrence ?? ""];
        if (months === undefined) throw new TypeError("nil can't be coerced into Integer");
        if (duration % months !== 0) {
          link.errors.add(
            "base",
            `Your subscription length in months must be a multiple of ${months} because you have selected a payment option of ${String(recurrence)} payments.`,
          );
          return;
        }
      }
    },
  },
  {
    // The restore and claim checks only run for changes the guard refuses.
    name: "custom_and_unique_permalink_uniqueness",
    async run(link, ctx) {
      if ((await loadUser(link, ctx)) === null) throw new NoMethodError("undefined method 'links' for nil");
      const custom = link.get("custom_permalink");
      const claiming = claimingCustomPermalink(link);
      // validate_claimed_custom_permalink_is_free: a locking read sees a claim that committed after this save's snapshot.
      if (claiming && !link.errors.added("custom_permalink", "taken")) {
        const claimed = await exists(
          Prisma.sql`SELECT /*+ INDEX(links index_links_on_user_id) */ 1 AS one FROM ${table("links")} WHERE ${column("links", "user_id")} = ${link.get("user_id")} AND ${column("links", "id")} != ${link.get("id")} AND ${eq("links", "custom_permalink", custom)} LIMIT 1 FOR UPDATE`,
        );
        if (claimed) link.errors.add("custom_permalink", "taken", { message: TAKEN_PERMALINK });
      }
      if (link.get("unique_permalink") === custom) return;
      const duplicate = await exists(
        Prisma.sql`SELECT /*+ INDEX(links index_links_on_user_id) */ 1 AS one FROM ${table("links")} WHERE ${column("links", "user_id")} = ${link.get("user_id")} AND ${column("links", "id")} != ${link.get("id")} AND ${column("links", "deleted_at")} IS NULL AND ${eq("links", "unique_permalink", custom)} LIMIT 1${claiming ? Prisma.sql` FOR UPDATE` : Prisma.empty}`,
      );
      if (duplicate) link.errors.add("custom_permalink", TAKEN_PERMALINK);
    },
  },
  {
    // Product::Validations#max_purchase_count_is_greater_than_or_equal_to_inventory_sold; `sales_count_for_inventory` reads the column fresh.
    name: "max_purchase_count_is_greater_than_or_equal_to_inventory_sold",
    async run(link) {
      if (!link.attributeChanged("max_purchase_count")) return;
      const max = link.get("max_purchase_count");
      if (max == null) return;
      const [row] = await selectRows<{ sold: number | null }>(
        Prisma.sql`SELECT ${column("links", "sales_count_for_inventory_cache")} AS sold FROM ${table("links")} WHERE ${column("links", "id")} = ${link.get("id")} LIMIT 1`,
      );
      if (!(max >= Number(row?.sold ?? 0)))
        link.errors.add("base", "Sorry, you cannot limit the number of purchases to that amount.");
    },
  },
  {
    // custom_permalink_of_licensed_product: with no cutover timestamp in Redis it passes; with one it compares licensed products of other sellers.
    name: "custom_permalink_of_licensed_product",
    if: (link) => link.attributeChanged("custom_permalink") && isFlagSet(link, "is_licensed"),
    async run(link) {
      if (isBlank(link.get("custom_permalink"))) return;
      if ((await collaborators.redis().get(FORCE_PRODUCT_ID_TIMESTAMP_KEY)) == null) return;
      throw new NotPortedError("Link#custom_permalink_of_licensed_product", "app/models/link.rb:1940");
    },
  },
  {
    name: "free_trial_only_enabled_if_recurring_billing",
    run(link) {
      if (isFlagSet(link, "is_recurring_billing")) return;
      if (
        isFlagSet(link, "free_trial_enabled") ||
        !isBlank(link.get("free_trial_duration_unit")) ||
        !isBlank(link.get("free_trial_duration_amount"))
      ) {
        link.errors.add("base", "Free trials are only allowed for subscription products.");
      }
    },
  },
  validatesInclusionOf<Link>(["native_type"], { in: NATIVE_TYPES }),
  validatesInclusionOf<Link>(["discover_fee_per_thousand"], {
    in: DISCOVER_FEES_PER_THOUSAND,
    message: "must be between 30% and 100%",
  }),
  // free_trial_duration_amount's validations only run for a new record or a changed amount.
  { ...validatesPresenceOf<Link>(["free_trial_duration_unit"]), if: (link) => isFlagSet(link, "free_trial_enabled") },
  {
    name: "price_must_be_within_range",
    async run(link, ctx) {
      const currencyType = link.get("price_currency_type");
      const config = currency(link);
      if (!config) {
        link.errors.add("base", `'${currencyType ?? ""}' is not a supported currency.`);
        return;
      }
      const rows = await selectRows<{ price_cents: number | null }>(
        Prisma.sql`SELECT ${column("prices", "price_cents")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${link.get("id")} AND ${column("prices", "deleted_at")} IS NULL AND ${eq("prices", "currency", currencyType)}`,
      );
      for (const { price_cents: cents } of rows) {
        if (cents == null || cents === 0) continue;
        if (cents > MAX_PRICE_CENTS) link.errors.add("base", "Sorry, the price entered is too large.");
        else if (cents < config.min_price)
          link.errors.add("base", `Sorry, a product must be at least ${config.min_price_formatted}.`);
        else {
          const user = await loadUser(link, ctx);
          if (user === null) throw new NoMethodError("undefined method 'max_product_price' for nil");
          // User#max_product_price
          const max = user.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
          if (max !== null && (await getUsdCents(currencyType!, cents)) > max)
            link.errors.add("base", "Sorry, we don't support pricing products above $5,000.");
        }
      }
    },
  },
  {
    name: "require_shipping_for_physical",
    run(link) {
      if (isFlagSet(link, "is_physical") && !link.get("require_shipping"))
        link.errors.add("base", "Shipping form is required for physical products.");
    },
  },
  {
    name: "valid_tier_version_structure",
    if: (link) => isFlagSet(link, "is_tiered_membership"),
    async run(link) {
      if (offSale(link)) return;
      const count = await countOf(
        Prisma.sql`SELECT COUNT(*) FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${link.get("id")} AND ${column("variant_categories", "deleted_at")} IS NULL`,
      );
      if (count !== 1) {
        link.errors.add("base", "Memberships should only have one Tier version category.");
        throw new LinkInvalid("Memberships should only have one Tier version category.");
      }
      const category = (await firstAliveCategory(link))!;
      const tiers = await countOf(
        Prisma.sql`SELECT COUNT(*) FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "variant_category_id")} = ${category.id} AND ${column("base_variants", "deleted_at")} IS NULL`,
      );
      if (tiers === 0) {
        link.errors.add("base", "Memberships should have at least one tier.");
        throw new LinkInvalid("Memberships should have at least one tier.");
      }
    },
  },
  {
    name: "calls_must_have_at_least_one_duration",
    async run(link) {
      if (link.get("native_type") !== "call" || link.get("deleted_at") != null || isFlagSet(link, "archived")) return;
      const category = await firstAliveCategory(link);
      if (
        category &&
        (await exists(
          Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "variant_category_id")} = ${category.id} AND ${column("base_variants", "deleted_at")} IS NULL LIMIT 1`,
        ))
      ) {
        return;
      }
      link.errors.add("base", "Calls must have at least one duration");
    },
  },
  {
    name: "alive_category_variants_presence",
    async run(link) {
      if (offSale(link)) return;
      const empty = await exists(
        Prisma.sql`SELECT 1 AS one FROM ${table("variant_categories")} LEFT OUTER JOIN ${table("base_variants")} ON ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} AND ${column("base_variants", "type")} = 'Variant' WHERE ${column("variant_categories", "link_id")} = ${link.get("id")} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "id")} IS NULL LIMIT 1`,
      );
      if (empty) link.errors.add("base", "Sorry, the product versions must have at least one option.");
    },
  },
  {
    name: "content_has_no_adult_keywords",
    if: (link) => link.attributeChanged("description") || link.attributeChanged("name"),
    run(link) {
      if (isAdult(link.get("description")) || isAdult(link.get("name")))
        link.errors.add("base", "Adult keywords are not allowed");
    },
  },
  {
    name: "custom_view_content_button_text_length",
    run(link) {
      const text = jsonDataForAttr(link, "custom_view_content_button_text");
      if (isBlank(text) || rubyLength(text) <= MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH) return;
      const over = rubyLength(text) - MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH;
      link.errors.add(
        "base",
        `Button: ${over} ${over === 1 ? "character" : "characters"} over limit (max: ${MAX_VIEW_CONTENT_BUTTON_TEXT_LENGTH})`,
      );
    },
  },
  {
    name: "validates :custom_receipt_text, length:",
    run(link) {
      if (rubyLength(jsonDataForAttr(link, "custom_receipt_text")) > MAX_CUSTOM_RECEIPT_TEXT_LENGTH)
        link.errors.add("custom_receipt_text", "too_long", { count: MAX_CUSTOM_RECEIPT_TEXT_LENGTH });
    },
  },
  {
    name: "validates :custom_failed_payment_text, length:",
    run(link) {
      if (rubyLength(jsonDataForAttr(link, "custom_failed_payment_text")) > MAX_CUSTOM_FAILED_PAYMENT_TEXT_LENGTH) {
        link.errors.add("custom_failed_payment_text", "too_long", { count: MAX_CUSTOM_FAILED_PAYMENT_TEXT_LENGTH });
      }
    },
  },
  {
    name: "custom_failed_payment_text_is_plain_text",
    run(link) {
      const text = jsonDataForAttr(link, "custom_failed_payment_text");
      if (!NON_PLAIN_TEXT_PATTERN.test(text == null ? "" : String(text))) return;
      link.errors.add(
        "base",
        "Failed payment message: links and HTML are not allowed. We add the payment update link for you.",
      );
    },
  },
  validatesPresenceOf<Link>(["filetype"]),
  validatesPresenceOf<Link>(["filegroup"]),
  // bundle_is_not_in_bundle only runs when is_bundle changes.
  {
    name: "published_bundle_must_have_at_least_one_product",
    async run(link) {
      if (!isPublished(link) || !isFlagSet(link, "is_bundle")) return;
      const any = await exists(
        Prisma.sql`SELECT 1 AS one FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${link.get("id")} AND ${column("bundle_products", "deleted_at")} IS NULL LIMIT 1`,
      );
      if (!any) link.errors.add("base", "Bundles must have at least one product.");
    },
  },
  {
    name: "commission_price_is_valid",
    if: (link) => link.get("native_type") === "commission",
    async run(link) {
      const config = currency(link);
      if (!config) throw new NoMethodError("undefined method '[]' for nil");
      const doubleMin = config.min_price * 2;
      if ((await defaultPriceCents(link)) === 0) return;
      const price = await defaultPriceCents(link);
      if (price == null) throw new NoMethodError("undefined method '>=' for nil");
      if (price >= doubleMin) return;
      link.errors.add("base", `The commission price must be at least ${config.double_min_price_in_currency}.`);
    },
  },
  // one_coffee_per_user only runs when a coffee product is unarchived.
  {
    name: "quantity_enabled_state_is_allowed",
    run(link) {
      if (isFlagSet(link, "quantity_enabled") && ["membership", "call"].includes(link.get("native_type"))) {
        link.errors.add("base", "Customers cannot be allowed to choose a quantity for this product.");
      }
    },
  },
  {
    // The checks past the lookup only run when default_offer_code_id changes.
    name: "default_offer_code_must_be_valid",
    async run(link, ctx) {
      await loadBelongsTo(link, DEFAULT_OFFER_CODE, ctx);
    },
  },
  {
    // Runs while publishing, or when the name or description of a published product change; the moderation service is Ruby's.
    name: "content_moderation_check",
    if: (link) =>
      !link.newRecord && isPublished(link) && (link.attributeChanged("name") || link.attributeChanged("description")),
    run() {
      throw new NotPortedError("ContentModeration::ModerateRecordService.check", "app/models/link.rb:2385");
    },
  },
  {
    name: "validates_associated :installment_plan",
    async run(link) {
      // The has_one stays loaded (nil included) on the instance, so a second save of it asks nothing.
      const cached = associationCache(link).get("installment_plan");
      let plan = cached?.row as { number_of_installments: number | null } | null | undefined;
      if (plan === undefined) {
        [plan = null] = await selectRows<{ number_of_installments: number | null }>(
          Prisma.sql`SELECT ${Prisma.raw("`product_installment_plans`.*")} FROM ${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${link.get("id")} AND ${column("product_installment_plans", "deleted_at")} IS NULL LIMIT 1`,
        );
        setAssociation(link, "installment_plan", link.get("id"), plan);
      }
      if (!plan) return;
      const message = await installmentPlanError(link, plan);
      if (message !== null) link.errors.add("installment_plan", "invalid", { message });
    },
  },
];

async function countOf(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(sql);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

const offSale = (link: LinkRecord) =>
  link.get("deleted_at") != null ||
  isFlagSet(link, "archived") ||
  (link.get("purchase_disabled_at") != null && link.attributeChanged("purchase_disabled_at"));

async function firstAliveCategory(link: LinkRecord): Promise<{ id: bigint } | undefined> {
  const [row] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw("`variant_categories`.*")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${link.get("id")} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC LIMIT 1`,
  );
  return row;
}

async function maxAliveVariantPriceDifference(link: LinkRecord): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT MAX(${column("base_variants", "price_difference_cents")}) FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${link.get("id")} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL`,
  );
  const value = row ? Object.values(row)[0] : null;
  return value == null ? 0 : Number(value);
}

// ProductInstallmentPlan#valid?: the first full message, or null when valid.
async function installmentPlanError(
  link: LinkRecord,
  plan: { number_of_installments: number | null },
): Promise<string | null> {
  const errors: string[] = [];
  const installments = plan.number_of_installments;
  if (installments == null)
    errors.push("Number of installments can't be blank", "Number of installments is not a number");
  else if (installments <= 1) errors.push("Number of installments must be greater than 1");
  if (isFlagSet(link, "is_recurring_billing") || isFlagSet(link, "is_tiered_membership"))
    errors.push("Installment plans are not available for membership products");
  else if (isFlagSet(link, "is_in_preorder_state"))
    errors.push("Installment plans are not available for pre-order products");
  else if (!INSTALLMENT_PLAN_NATIVE_TYPES.includes(link.get("native_type")))
    errors.push("Installment plans are not available for this product type");
  if (isFlagSet(link, "is_bundle")) {
    throw new NotPortedError(
      "ProductInstallmentPlan#validate_bundle_content_eligibility",
      "app/models/product_installment_plan.rb:69",
    );
  }
  const hasPaidVariants = (await maxAliveVariantPriceDifference(link)) > 0;
  if (link.get("customizable_price") && !hasPaidVariants)
    errors.push('Installment plans are not available for "pay what you want" pricing');
  const first = await defaultPriceCents(link);
  const second = await defaultPriceCents(link);
  if (second == null) throw new NoMethodError("undefined method '+' for nil");
  const maxPriceCents = Math.max(first!, second + (await maxAliveVariantPriceDifference(link)));
  const config = currency(link);
  if (!config) throw new NoMethodError("undefined method '[]' for nil");
  if (config.min_price * (installments ?? 0) > maxPriceCents)
    errors.push(`The minimum price for each installment must be at least ${config.min_price_in_currency}.`);
  return errors[0] ?? null;
}

// Product::Searchable#enqueue_index_update_for
function enqueueIndexUpdateFor(link: LinkRecord, fields: string[], ctx: CallbackContext): Promise<void> {
  return enqueueIndexUpdateForProduct(link.get("id") as bigint, fields, ctx.now);
}

// The same, for a caller that holds the product's id and not its record (a review's stat update).
export function enqueueIndexUpdateForProduct(
  id: bigint,
  fields: string[],
  now: () => Date = () => new Date(),
): Promise<void> {
  return import("../search/product-indexing.ts").then(({ enqueueIndexUpdatesFor }) =>
    enqueueIndexUpdatesFor([id], fields, {
      now,
      featureActive: (name, actor) => collaborators.isFeatureEnabled(name, actor),
    }),
  );
}

// User#bump_reputation_summary_version: a lost bump is bounded by the aggregate's TTL.
export async function bumpReputationSummaryVersion(userId: bigint | number): Promise<void> {
  if (!(await collaborators.isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(userId))))) return;
  await afterCommitEverywhere(async () => {
    try {
      await collaborators.redis().incr(`seller_reputation_summary/version/${String(userId)}`);
    } catch (error) {
      console.error(`Seller reputation summary bump failed for user ${String(userId)}: ${(error as Error).message}`);
    }
  });
}

// Product::Caching#invalidate_cache
export async function invalidateProductCache(linkId: bigint | number, now?: () => Date): Promise<void> {
  await collaborators.cacheDelete(`link_cache_key_prefix_${String(linkId)}`);
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_cached_values`.*")} FROM ${table(PRODUCT_CACHED_VALUES)} WHERE ${column(PRODUCT_CACHED_VALUES, "product_id")} = ${linkId} AND ${freshScope()}`,
  );
  for (const row of rows) {
    await ProductCachedValues.updateBang(
      ProductCachedValues.load(castRow<ProductCachedValue>("ProductCachedValue", row)),
      { expired: true },
      { now },
    );
  }
}

const paperTrail = hasPaperTrail<Link>("Link", { itemType: "Link" });
const savedKeys = (link: LinkRecord) => Object.keys(link.savedChanges);

// Product::Prices#set_customizable_price, writing with update_column. Shared with LinkCreations, whose API create runs it after the first save.
export const setCustomizablePrice: Callback<Link> = {
  // Product::Prices#set_customizable_price, writing with update_column.
  name: "set_customizable_price",
  async run(link, ctx) {
    if (isFlagSet(link, "is_tiered_membership")) return;
    if ((await defaultPriceCents(link)) !== 0) return;
    if (link.get("native_type") === "coffee") return;
    const [row] = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT SUM(${column("base_variants", "price_difference_cents")}) FROM ${table("variant_categories")} INNER JOIN ${table("base_variants")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} AND ${column("base_variants", "type")} = 'Variant' WHERE ${column("variant_categories", "link_id")} = ${link.get("id")} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL`,
    );
    const sum = row ? Object.values(row)[0] : null;
    if (sum != null && Number(sum) > 0) return;
    if (link.get("customizable_price") === true) return;
    await execute(
      Prisma.sql`UPDATE ${table("links")} SET ${column("links", "customizable_price")} = TRUE WHERE ${column("links", "id")} = ${link.get("id")}`,
    );
    link.set("customizable_price", true);
    link.clearAttributeChanges(["customizable_price"]);
    await enqueueIndexUpdateFor(link, ["customizable_price"], ctx);
  },
};

// Link#publish_schedule_invalidated?: a delete, a manual publish, a disable, a ban or an admin takedown ends a pending schedule.
export function publishScheduleInvalidated(link: LinkRecord): boolean {
  const flagsChange = link.savedChanges.flags;
  return (
    (link.savedChangeTo("deleted_at") && link.get("deleted_at") != null) ||
    link.savedChangeTo("draft", { to: false }) ||
    (link.savedChangeTo("purchase_disabled_at") && link.get("purchase_disabled_at") != null) ||
    (link.savedChangeTo("banned_at") && link.get("banned_at") != null) ||
    // A new draft already has purchase_disabled_at, so taking one down changes only this flag.
    (flagsChange !== undefined &&
      isFlagSet(link, "is_unpublished_by_admin") &&
      !LinkFlags.isSet(link.attributeBeforeLastSave("flags"), "is_unpublished_by_admin"))
  );
}

export const Links = defineModel<Link>({
  rubyClass: "Link",
  prismaModel: "Link",
  delegate: (tx) => tx.link as never,
  beforeValidation,
  validations,
  beforeSave: [
    mergeJsonDataWithCurrentRow<Link>("links"),
    {
      name: "downcase_filetype",
      run: (link) => {
        const filetype = link.get("filetype");
        if (!isBlank(filetype)) link.set("filetype", filetype!.toLowerCase());
      },
    },
    {
      // Strips XML that Word and similar apps paste into descriptions.
      name: "remove_xml_tags",
      run: (link) => {
        const description = link.get("description");
        if (!isBlank(description))
          link.set("description", description!.replace(/<!--\?xml.+\?-->|<!--\[if gte mso.+<!\[endif\]-->/gsu, ""));
      },
    },
  ],
  beforeUpdate: [
    {
      name: "update_search_index_for_changed_fields",
      async run(link, ctx) {
        const fields = changedForSearch(link);
        if (fields.length > 0) await enqueueIndexUpdateFor(link, fields, ctx);
      },
    },
  ],
  afterTouch: [...paperTrail.afterTouch],
  afterUpdate: [
    ...paperTrail.afterUpdate,
    {
      name: "invalidate_cache",
      if: (link) => savedKeys(link).some((key) => !PURCHASE_PROPERTIES.includes(key)),
      run: (link, ctx) => invalidateProductCache(link.get("id") as bigint, ctx.now),
    },
    {
      name: "bump_seller_reputation_version_for_rollup_change",
      if: (link) => savedKeys(link).some((key) => ROLLUP_LINK_COLUMNS.includes(key)),
      async run(link, ctx) {
        const user = await loadUser(link, ctx);
        if (user === null) throw new NoMethodError("undefined method 'bump_reputation_summary_version' for nil");
        await bumpReputationSummaryVersion(user.id as number | bigint);
      },
    },
  ],
  afterSave: [
    {
      // ProductPublishSchedule.cancel_pending!: a schedule the job has already claimed is left alone
      name: "cancel_pending_publish_schedule",
      if: publishScheduleInvalidated,
      async run(link) {
        await execute(
          Prisma.sql`DELETE FROM ${table("product_publish_schedules")} WHERE ${column("product_publish_schedules", "status")} = 'scheduled' AND ${column("product_publish_schedules", "product_id")} = ${link.get("id")}`,
        );
      },
    },
    {
      name: "stage_renamed_custom_permalink",
      if: (link) => link.savedChangeTo("custom_permalink"),
      run(link) {
        const outgoing = link.attributeBeforeLastSave("custom_permalink");
        if (isBlank(outgoing)) return;
        stagedPermalinks.set(link, [...(stagedPermalinks.get(link) ?? []), outgoing!]);
      },
    },
    setCustomizablePrice,
  ],
  afterRollback: [
    {
      name: "discard_renamed_custom_permalinks",
      run: (link) => void stagedPermalinks.delete(link),
    },
  ],
  afterCommit: [
    {
      name: "redirect_renamed_custom_permalinks",
      async run(link) {
        const slugs = stagedPermalinks.get(link);
        stagedPermalinks.delete(link);
        if (!slugs?.length) return;
        await redirectRenamedPermalinks(
          slugs,
          { id: link.get("id"), sellerId: link.get("user_id"), deleted: link.get("deleted_at") != null },
          new Date(),
        );
      },
    },
    {
      // indexnow_submission_needed?
      name: "submit_to_indexnow",
      on: "update",
      if: (link) =>
        link.savedChangeTo("purchase_disabled_at") ||
        link.savedChangeTo("deleted_at") ||
        link.savedChangeTo("draft") ||
        (isPublished(link) &&
          (link.savedChangeTo("name") || link.savedChangeTo("description") || link.savedChangeTo("custom_permalink"))),
      async run(link) {
        await performAsync("SubmitToIndexnowJob", [[link.get("id") as bigint]]);
      },
    },
  ],
  beforeDestroy: [
    {
      name: "(guard) refuse destroy",
      run: () => {
        throw new NotPortedError("Link#destroy", "app/models/link.rb (dependent associations)");
      },
    },
  ],
});

export const LinkDeletable = deletable(Links);

// `link.banned_at = time`: the column has no fractional seconds, so the value is cast to them.
export function bannedAtValue(at: Date | null): Date | null {
  return at === null ? null : new Date(Math.floor(at.getTime() / 1000) * 1000);
}

// `link.enqueue_index_update_for(fields)` for a product that was not loaded as a record (SaveFilesService on a post).
export function enqueueLinkIndexUpdate(
  linkId: bigint | number,
  fields: string[],
  now: () => Date = () => new Date(),
): Promise<void> {
  return import("../search/product-indexing.ts").then(({ enqueueIndexUpdatesFor }) =>
    enqueueIndexUpdatesFor([linkId], fields, {
      now,
      featureActive: (name, actor) => collaborators.isFeatureEnabled(name, actor),
    }),
  );
}

// `Link.find(id)`
export async function findLinkBang(id: bigint | number): Promise<LinkRecord> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`,
  );
  if (!row) throw Object.assign(new Error(`Couldn't find Link with 'id'=${String(id)}`), { name: "RecordNotFound" });
  return Links.load(castRow<Link>("Link", row));
}
