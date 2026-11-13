// Link creation for LinksController#create: the save callback chain of a new product, as far as recorded examples prove it
// (spec/requests/links_create_parity_spec.rb). Kept apart from link.ts, whose `Links` model refuses a new record.
//
// Served: digital, course, ebook, audiobook, membership (with its default tier), coffee (with its suggested amount) and bundle products,
// in any configured currency whose exchange rate is in Redis, physical products for sellers who qualify without a sales lookup, with an
// optional description and custom summary, and the profile sections that add new products. Everything else a Link save can do on create
// (calls, commissions, installment plans, AI generation, the mobile web view, recurring digital products) throws NotPortedError from
// `parseCreateParams` or from inside the save, which rolls back: nothing is written.
import { randomInt } from "node:crypto";

import { Prisma, type Link } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled } from "../infra/flipper.ts";
import { ProductRecord } from "../search/documents/product.ts";
import { performProductIndexing } from "../search/product-indexing.ts";

import { BundleProducts } from "./bundle-products.ts";
import { isAdult } from "./concerns/adult-keyword-detector.ts";
import { afterCommitEverywhere, performAsync } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import { rubyJsonGenerate } from "./concerns/serialized-columns.ts";
import LINK_DATA from "./link-data.generated.json" with { type: "json" };
import {
  DEFAULT_BOOSTED_DISCOVER_FEE_PER_THOUSAND,
  getUsdCents,
  invalidateProductCache,
  LinkFlags,
  LinkInvalid,
  Links,
  MAX_NAME_LENGTH,
  MAX_PURCHASE_COUNT_RANGE,
  setCustomizablePrice,
  type LinkRecord,
} from "./link.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { Errors } from "./runtime/errors.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { isBlank, rubyLength } from "./runtime/validators.ts";
import { column, execute, selectRows, table } from "./sql.ts";
import { MAX_PRICE_USD_CENTS_UNLESS_VERIFIED, NotPortedError, UserFlags } from "./user.ts";

// BasePrice::Shared::MAX_PRICE_CENTS
const MAX_PRICE_CENTS = 2_147_483_647;
const USD = "usd";
const PRICE_TOO_LARGE = "Sorry, the price entered is too large.";
const NO_PRICE = "New products should be created with a price";
const CURRENCIES = LINK_DATA.currencies as Record<
  string,
  { min_price: number; min_price_formatted: string; single_unit: boolean }
>;
// Product::NativeTypeTemplates::DEFAULT_ATTRIBUTES_FOR_TYPE for the types served here.
const CUSTOM_ATTRIBUTES: Record<string, { name: string; value: string }[]> = {
  ebook: [{ name: "Pages", value: "" }],
  audiobook: [{ name: "Length", value: "" }],
};
export const SERVED_NATIVE_TYPES = ["digital", "course", "ebook", "audiobook", "membership", "coffee", "bundle"];
// `enum :subscription_duration`: the stored integer is the position.
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"];
const DEFAULT_TIERED_MEMBERSHIP_RECURRENCE = "monthly";
// The attributes the new product form sends. `number_of_content_pages` and `release_at_date` are not in `link_params`, so Rails drops them.
const FORM_KEYS = [
  "name",
  "price_range",
  "price_currency_type",
  "native_type",
  "is_physical",
  "is_recurring_billing",
  "subscription_duration",
  "description",
  "custom_summary",
  "ai_prompt",
];
const DROPPED_KEYS = ["number_of_content_pages", "release_at_date"];
const DAY_MS = 24 * 60 * 60 * 1000;
// Product::CreationLimit#default_daily_creation_limit
const COMPLIANT_DAILY_CREATION_LIMIT = 100;
const DEFAULT_DAILY_CREATION_LIMIT = 10;
// User::MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS
const MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS_MS = 90 * DAY_MS;
const ARCHIVED_FLAG = 1n << 4n;
const IS_PHYSICAL_FLAG = 1n << 7n;
// Ruby's String#blank?: Unicode white space only (JavaScript's trim() also strips U+FEFF).
const RUBY_BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

export type CreateParams = {
  name: string | null;
  // null: the form sent no price, which Rails leaves unassigned.
  priceRange: string | null;
  nativeType: string;
  description: string | null;
  currency: string;
  isPhysical: boolean;
  // The membership's recurrence, null when the form sent none.
  subscriptionDuration: string | null;
  customSummary: string | null;
};

// A RecordInvalid raised for a record other than the product (a variant): the product's own errors stay empty.
export class RelatedRecordInvalid extends Error {}

const text = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new NotPortedError(`a ${what} that is not text`, "app/controllers/links_controller.rb:101");
  return value;
};

// `params[:link]`, reduced to what the port proves. Rails would take any other permitted attribute (prices, permalinks, flags...)
// or reject a body shape (a list, a string) with its own error, so those go to Rails whole.
export function parseCreateParams(raw: unknown): CreateParams {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new NotPortedError("a link parameter that is not a hash", "app/controllers/links_controller.rb:101");
  const link = raw as Record<string, unknown>;
  const unknown = Object.keys(link).filter((key) => !FORM_KEYS.includes(key) && !DROPPED_KEYS.includes(key));
  if (unknown.length > 0)
    throw new NotPortedError(`the link attributes ${unknown.join(", ")}`, "app/controllers/links_controller.rb:1428");

  // `params[:link][:is_physical]` is truthy for any non-nil, non-false value, including the string "false".
  if (![undefined, null, false, true].includes(link.is_physical as boolean | null | undefined))
    throw new NotPortedError("an is_physical that is not true or false", "app/controllers/links_controller.rb:91");
  const isPhysical = link.is_physical === true;
  if (![undefined, false, true].includes(link.is_recurring_billing as boolean | undefined))
    throw new NotPortedError("an is_recurring_billing that is not true or false", "app/models/link.rb:2309");
  const isRecurring = link.is_recurring_billing === true;

  let subscriptionDuration: string | null = null;
  const duration = link.subscription_duration;
  // The enum casts a blank value to nil and raises ArgumentError for an unknown one.
  if (duration !== undefined && duration !== null && duration !== "") {
    if (typeof duration !== "string" || !SUBSCRIPTION_DURATIONS.includes(duration))
      throw new NotPortedError("a subscription duration the enum refuses", "app/models/link.rb:315");
    subscriptionDuration = duration;
  }

  let currency = USD;
  if (link.price_currency_type !== undefined) {
    if (typeof link.price_currency_type !== "string" || link.price_currency_type === "")
      throw new NotPortedError("a blank currency", "app/models/link.rb:328");
    currency = link.price_currency_type.toLowerCase();
    if (!(currency in CURRENCIES))
      throw new NotPortedError("a currency Rails has no configuration for", "app/models/link.rb:920");
  }

  const nativeType = link.native_type;
  if (typeof nativeType !== "string" || !SERVED_NATIVE_TYPES.includes(nativeType))
    throw new NotPortedError(`the native type ${JSON.stringify(nativeType)}`, "app/models/link.rb:466");
  // A tiered membership is is_recurring_billing; any other pairing (a recurring digital product, a one-off membership) is unproven.
  if (isRecurring !== (nativeType === "membership"))
    throw new NotPortedError(
      "a recurring flag that does not match the native type",
      "app/controllers/links_controller.rb:112",
    );
  if (subscriptionDuration !== null && nativeType !== "membership")
    throw new NotPortedError("a subscription duration on a product that is not a membership", "app/models/link.rb:477");
  if (isPhysical && nativeType !== "digital")
    throw new NotPortedError(
      "a physical product of a native type other than digital",
      "app/controllers/links_controller.rb:91",
    );
  if (nativeType === "membership" && CURRENCIES[currency]!.single_unit)
    throw new NotPortedError("a membership priced in a single-unit currency", "app/models/link.rb:489");

  // Generation runs for a present prompt only.
  if (link.ai_prompt !== undefined && link.ai_prompt !== null) {
    if (typeof link.ai_prompt !== "string" || !RUBY_BLANK.test(link.ai_prompt))
      throw new NotPortedError("an AI prompt", "app/controllers/links_controller.rb:124");
  }

  let customSummary: string | null = null;
  if (link.custom_summary !== undefined && link.custom_summary !== null) {
    if (typeof link.custom_summary !== "string")
      throw new NotPortedError("a custom summary that is not text", "app/controllers/links_controller.rb:107");
    if (!RUBY_BLANK.test(link.custom_summary)) {
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(link.custom_summary))
        throw new NotPortedError("a custom summary JSON.dump would refuse", "app/models/link.rb:1522");
      customSummary = link.custom_summary;
    }
  }

  const price = link.price_range;
  let priceRange: string | null;
  // `return unless price` leaves the product without a price.
  if (price === undefined || price === null) priceRange = null;
  else if (typeof price === "string") priceRange = price;
  else if (typeof price === "number" && Number.isFinite(price) && !String(price).includes("e"))
    priceRange = String(price);
  else throw new NotPortedError("a price that is neither text nor a plain number", "app/modules/product/prices.rb:76");
  // A custom summary saves the product once before the action's rescue: a LinkInvalid there is not rescued, and a recurrence
  // Price#recurrence_validation refuses breaks the first save.
  if (customSummary !== null && priceRange === null)
    throw new NotPortedError("a custom summary without a price", "app/controllers/links_controller.rb:107");
  if (customSummary !== null && nativeType === "membership" && subscriptionDuration === null)
    throw new NotPortedError("a membership with a custom summary and no recurrence", "app/models/price.rb:25");

  return {
    name: text(link.name, "name"),
    priceRange,
    nativeType,
    description: text(link.description, "description"),
    currency,
    isPhysical,
    subscriptionDuration,
    customSummary,
  };
}

// BasePrice::Shared#clean_price and CurrencyHelper#string_to_price_cents. A single-unit currency (yen) skips the comma handling and has no cents.
export function cleanPriceCents(priceString: string, singleUnit = false): bigint {
  let clean = priceString;
  if (!singleUnit) {
    clean = clean.replace(/[^-0-9.,]/gu, "");
    // Euro style: a comma two places from the end is the decimal mark.
    if (clean.lastIndexOf(",") !== -1 && clean.lastIndexOf(",") === clean.length - 3)
      clean = clean.replaceAll(".", "").replaceAll(",", ".");
  }
  clean = clean.replace(/[^-0-9.]/gu, "");
  let sanitized = clean;
  if ((sanitized.match(/\./gu) ?? []).length > 1) {
    const firstDot = sanitized.indexOf(".");
    sanitized = sanitized.slice(0, firstDot + 1) + sanitized.slice(firstDot + 1).replaceAll(".", "");
  }
  if (!/\d/u.test(sanitized)) sanitized = "0";
  // BigDecimal("1-2") raises in Ruby and answers a 500; only plain decimals are read here.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(sanitized);
  if (!match) throw new NotPortedError("a price BigDecimal may refuse", "app/helpers/currency_helper.rb:77");
  const [, sign, whole, fraction = ""] = match;
  const places = singleUnit ? 0 : 2;
  const digits = fraction.padEnd(places + 1, "0");
  let cents = BigInt(whole!) * 10n ** BigInt(places) + (places === 0 ? 0n : BigInt(digits.slice(0, places)));
  // BigDecimal#round rounds half away from zero.
  if (Number(digits[places]) >= 5) cents += 1n;
  return sign === "-" ? -cents : cents;
}

// `#to_sentence` of Rails' default locale.
export function toSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// `errors.to_hash` grouped by attribute in first-seen order.
export function errorsToHash(errors: Errors): [string, string[]][] {
  const grouped = new Map<string, string[]>();
  for (const { attribute, message } of errors.details)
    grouped.set(attribute, [...(grouped.get(attribute) ?? []), message]);
  return [...grouped];
}

export type SellerAccount = {
  id: bigint;
  flags: bigint;
  verified: boolean | null;
  confirmed_at: Date | null;
  created_at: Date | null;
  user_risk_state: string | null;
  json_data: string | null;
};

// `user.daily_product_creation_limit` (a json_data accessor): the seller's own limit, null when unset.
export function dailyProductCreationLimit(jsonData: string | null): number | null {
  if (!jsonData?.includes("daily_product_creation_limit")) return null;
  let hash: unknown;
  try {
    hash = JSON.parse(jsonData);
  } catch {
    throw new NotPortedError("a seller json_data that is not JSON", "app/models/user.rb:258");
  }
  const value = (hash as Record<string, unknown> | null)?.daily_product_creation_limit;
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new NotPortedError("a daily product creation limit that is not a whole number", "app/models/user.rb:258");
  return value;
}

export type PhysicalVerdict = "allowed" | "forbidden";

// User#can_create_physical_products? up to the lookups that need Elasticsearch (the sales total). Past them the request goes to Rails.
export async function canCreatePhysicalProducts(seller: SellerAccount, now: Date): Promise<PhysicalVerdict> {
  const suspended = ["suspended_for_tos_violation", "suspended_for_fraud"].includes(seller.user_risk_state ?? "");
  if (seller.confirmed_at === null || suspended) return "forbidden";
  if (UserFlags.isSet(seller.flags, "DEPRECATED_can_create_physical_products")) return "allowed";
  const [row] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "flags")} & ${IS_PHYSICAL_FLAG} > 0 LIMIT 1`,
  );
  if (row) return "allowed";
  if (
    seller.created_at !== null &&
    seller.created_at.getTime() > now.getTime() - MIN_ACCOUNT_AGE_FOR_PHYSICAL_PRODUCTS_MS
  )
    return "forbidden";
  throw new NotPortedError(
    "the payouts and sales total behind User#can_create_physical_products?",
    "app/models/user.rb:1730",
  );
}

async function exists(query: Prisma.Sql): Promise<boolean> {
  return (await selectRows(query)).length > 0;
}

// Link#generate_unique_permalink
async function generateUniquePermalink(sellerId: bigint): Promise<string> {
  const letter = () => String.fromCharCode(97 + randomInt(26));
  let candidate = letter();
  while (
    candidate === "comps" ||
    (await exists(
      Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${candidate} LIMIT 1`,
    )) ||
    (await exists(
      Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "custom_permalink")} = ${candidate} LIMIT 1`,
    ))
  ) {
    candidate += letter();
  }
  return candidate;
}

const paperTrail = hasPaperTrail<Link>("Link", { itemType: "Link" });
const nowOf = (ctx: { now?: () => Date }) => (ctx.now ?? (() => new Date()))();

// ProductIndexingService.perform(product:, action: "index", on_failure: :async), after commit.
function enqueueSearchIndex(link: LinkRecord, now: () => Date): Promise<void> {
  return afterCommitEverywhere(() =>
    withExecutor(async () => {
      const product = await ProductRecord.find(link.get("id"), {
        now,
        featureActive: (name, actor) => isFeatureEnabled(name, actor),
      });
      if (product) await performProductIndexing(product, "index", [], "async");
    }),
  );
}

async function lastInsertId(): Promise<bigint> {
  const [row] = await selectRows<{ id: bigint }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
  return BigInt(row!.id);
}

async function insertVariantCategory(linkId: bigint, title: string): Promise<bigint> {
  await execute(
    Prisma.sql`INSERT INTO ${table("variant_categories")} (${column("variant_categories", "link_id")}, ${column("variant_categories", "deleted_at")}, ${column("variant_categories", "title")}, ${column("variant_categories", "flags")}) VALUES (${linkId}, NULL, ${title}, 0)`,
  );
  return lastInsertId();
}

async function insertVariant(
  categoryId: bigint,
  name: string,
  priceDifferenceCents: number | null,
  now: Date,
): Promise<bigint> {
  await execute(
    Prisma.sql`INSERT INTO ${table("base_variants")} (${column("base_variants", "variant_category_id")}, ${column("base_variants", "price_difference_cents")}, ${column("base_variants", "name")}, ${column("base_variants", "deleted_at")}, ${column("base_variants", "created_at")}, ${column("base_variants", "updated_at")}, ${column("base_variants", "type")}, ${column("base_variants", "flags")}, ${column("base_variants", "position_in_category")}, ${column("base_variants", "sales_count_for_inventory_cache")}) VALUES (${categoryId}, ${priceDifferenceCents}, ${name}, NULL, ${now}, ${now}, 'Variant', 0, 0, 0)`,
  );
  return lastInsertId();
}

async function insertPrice(
  price: {
    linkId: bigint | null;
    variantId: bigint | null;
    cents: number;
    currency: string;
    recurrence: string | null;
  },
  now: Date,
): Promise<void> {
  await execute(
    Prisma.sql`INSERT INTO ${table("prices")} (${column("prices", "link_id")}, ${column("prices", "price_cents")}, ${column("prices", "currency")}, ${column("prices", "recurrence")}, ${column("prices", "created_at")}, ${column("prices", "updated_at")}, ${column("prices", "deleted_at")}, ${column("prices", "flags")}, ${column("prices", "variant_id")}, ${column("prices", "suggested_price_cents")}) VALUES (${price.linkId}, ${price.cents}, ${price.currency}, ${price.recurrence}, ${now}, ${now}, NULL, 0, ${price.variantId}, NULL)`,
  );
}

// Link#initialize_tier_if_needed: the "Tier" category with an "Untitled" tier, priced at the product's price, and the zero price
// the product keeps beside it (Variant::Prices#save_recurring_prices!). `subscription_duration ||=` stays in memory: the column keeps
// what the form sent.
async function initializeTier(link: LinkRecord, ctx: { now?: () => Date }): Promise<void> {
  const now = nowOf(ctx);
  const linkId = link.get("id");
  const duration = SUBSCRIPTION_DURATIONS[link.get("subscription_duration")!] ?? DEFAULT_TIERED_MEMBERSHIP_RECURRENCE;
  const currency = link.get("price_currency_type")!;
  const cents = Number(link.get("price_cents") ?? 0);
  const categoryId = await insertVariantCategory(linkId, "Tier");
  await Links.touch(link, { now: ctx.now, deferred: true });
  const variantId = await insertVariant(categoryId, "Untitled", null, now);
  await insertPrice({ linkId: null, variantId, cents, currency, recurrence: duration }, now);
  // Variant#set_customizable_price: update_column, so updated_at stays.
  if (cents === 0)
    await execute(
      Prisma.sql`UPDATE ${table("base_variants")} SET ${column("base_variants", "customizable_price")} = TRUE WHERE ${column("base_variants", "id")} = ${variantId}`,
    );
  await insertPrice({ linkId, variantId: null, cents: 0, currency, recurrence: duration }, now);
  await afterCommitEverywhere(() => invalidateProductCache(linkId, ctx.now));
}

// Link#add_to_profile_sections: every products section of the seller that adds new products shows the new one. A saved profile is
// row-locked first, as User#with_profile_sections_lock does.
async function addToProfileSections(link: LinkRecord, ctx: { now?: () => Date }): Promise<void> {
  const sellerId = link.get("user_id")!;
  const [profile] = await selectRows(
    Prisma.sql`SELECT ${column("seller_profiles", "id")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${sellerId} LIMIT 1`,
  );
  if (profile)
    await selectRows(
      Prisma.sql`SELECT ${column("seller_profiles", "id")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${sellerId} LIMIT 1 FOR UPDATE`,
    );
  const sections = await selectRows<{ id: bigint; json_data: string | Record<string, unknown> | null }>(
    Prisma.sql`SELECT ${column("seller_profile_sections", "id")}, ${column("seller_profile_sections", "json_data")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "type")} = 'SellerProfileProductsSection' AND ${column("seller_profile_sections", "seller_id")} = ${sellerId} ORDER BY ${column("seller_profile_sections", "id")}`,
  );
  for (const section of sections) {
    const hash =
      typeof section.json_data === "string"
        ? (JSON.parse(section.json_data) as Record<string, unknown>)
        : (section.json_data ?? {});
    if (!hash.add_new_products) continue;
    const shown = hash.shown_products;
    if (hash.add_new_products !== true || !Array.isArray(shown) || shown.some((id) => !Number.isSafeInteger(id)))
      throw new NotPortedError("a products section whose json_data is not the schema's", "app/models/link.rb:2283");
    hash.shown_products = [...(shown as unknown[]), Number(link.get("id"))];
    await execute(
      Prisma.sql`UPDATE ${table("seller_profile_sections")} SET ${column("seller_profile_sections", "json_data")} = ${JSON.stringify(hash)}, ${column("seller_profile_sections", "updated_at")} = ${nowOf(ctx)} WHERE ${column("seller_profile_sections", "id")} = ${section.id}`,
    );
  }
}

// Link#initialize_suggested_amount_if_needed!: the "Suggested Amounts" category holding the entered price, then `update!(price_cents: 0,
// customizable_price: true)`, which on a saved product rewrites the Price row and leaves the column alone.
async function initializeSuggestedAmount(link: LinkRecord, ctx: { now?: () => Date }): Promise<void> {
  if (link.get("native_type") !== "coffee") return;
  const now = nowOf(ctx);
  const linkId = link.get("id");
  const cents = Number(link.get("price_cents") ?? 0);
  const categoryId = await insertVariantCategory(linkId, "Suggested Amounts");
  await Links.touch(link, { now: ctx.now, deferred: true });
  // BaseVariant#price_difference_cents_validation
  if (cents <= 0) throw new RelatedRecordInvalid("Price difference cents must be greater than 0");
  await insertVariant(categoryId, "", cents, now);
  await execute(
    Prisma.sql`UPDATE ${table("prices")} SET ${column("prices", "price_cents")} = 0, ${column("prices", "updated_at")} = ${now} WHERE ${column("prices", "link_id")} = ${linkId} AND ${column("prices", "currency")} = ${link.get("price_currency_type")} AND ${column("prices", "recurrence")} IS NULL AND ${column("prices", "deleted_at")} IS NULL`,
  );
  await execute(
    Prisma.sql`UPDATE ${table("links")} SET ${column("links", "customizable_price")} = TRUE, ${column("links", "updated_at")} = ${now} WHERE ${column("links", "id")} = ${linkId}`,
  );
  link.set("customizable_price", true);
  link.clearAttributeChanges(["customizable_price", "updated_at"]);
  await afterCommitEverywhere(() => invalidateProductCache(linkId, ctx.now));
}

const beforeValidation: Callback<Link>[] = [
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
    name: "set_unique_permalink",
    async run(link) {
      if (link.get("unique_permalink") == null)
        link.set("unique_permalink", await generateUniquePermalink(link.get("user_id")!));
    },
  },
];

const validations: Callback<Link>[] = [
  {
    // Product::CreationLimit, included ahead of the model's own validations.
    name: "validate_daily_product_creation_limit",
    async run(link, ctx) {
      const limit = link.ivars.dailyCreationLimit as number | null;
      if (limit === null) return;
      const [row] = await selectRows<Record<string, unknown>>(
        Prisma.sql`SELECT COUNT(*) FROM ${table("links")} WHERE ${column("links", "user_id")} = ${link.get("user_id")} AND ${column("links", "created_at")} >= ${new Date(nowOf(ctx).getTime() - DAY_MS)} AND ${column("links", "deleted_at")} IS NULL`,
      );
      if (Number(Object.values(row ?? {})[0] ?? 0) >= limit)
        link.errors.add("base", `Sorry, you can only create ${limit} products per day.`);
    },
  },
  {
    name: "validates :name, presence: true, length: { maximum: 255 }",
    run(link) {
      const name = link.get("name");
      if (isBlank(name)) link.errors.add("name", "blank");
      if (rubyLength(name) > MAX_NAME_LENGTH) link.errors.add("name", "too_long", { count: MAX_NAME_LENGTH });
    },
  },
  {
    // Product::Prices#default_price_cents reads the column until the product is saved.
    name: "validates :default_price_cents, presence: true",
    run(link) {
      if (link.get("price_cents") == null) link.errors.add("default_price_cents", "blank");
    },
  },
  {
    name: "validates :unique_permalink, presence: true",
    run(link) {
      if (isBlank(link.get("unique_permalink"))) link.errors.add("unique_permalink", "blank");
    },
  },
  {
    // Product::Prices#suggested_price_greater_than_price; the default price is the column until the product is saved.
    name: "suggested_price_greater_than_price",
    run(link) {
      const suggested = link.get("suggested_price_cents");
      if (suggested == null || !link.get("customizable_price") || link.get("price_cents") == null) return;
      if (suggested < Number(link.get("price_cents")))
        link.errors.add("base", "The suggested price you entered was too low.");
    },
  },
  {
    // BasePrice::Shared#price_must_be_within_range
    name: "price_must_be_within_range",
    async run(link) {
      const cents = link.get("price_cents");
      if (cents == null || Number(cents) === 0) return;
      const currency = link.get("price_currency_type")!;
      const config = CURRENCIES[currency]!;
      const price = Number(cents);
      if (price > MAX_PRICE_CENTS) link.errors.add("base", PRICE_TOO_LARGE);
      else if (price < config.min_price)
        link.errors.add("base", `Sorry, a product must be at least ${config.min_price_formatted}.`);
      else if (link.ivars.sellerMaxProductPrice != null) {
        if ((await getUsdCents(currency, price)) > (link.ivars.sellerMaxProductPrice as number))
          link.errors.add("base", "Sorry, we don't support pricing products above $5,000.");
      }
    },
  },
  {
    name: "content_has_no_adult_keywords",
    run(link) {
      for (const content of [link.get("description"), link.get("name")]) {
        if (isAdult(content)) {
          link.errors.add("base", "Adult keywords are not allowed");
          break;
        }
      }
    },
  },
  {
    // Product::Validations#one_coffee_per_user
    name: "one_coffee_per_user",
    async run(link) {
      if (link.get("native_type") !== "coffee") return;
      if (
        await exists(
          Prisma.sql`SELECT 1 AS one FROM ${table("links")} WHERE ${column("links", "user_id")} = ${link.get("user_id")} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "flags")} & ${ARCHIVED_FLAG} = 0 AND ${column("links", "native_type")} = 'coffee' LIMIT 1`,
        )
      )
        link.errors.add("base", "You can only have one coffee product.");
    },
  },
];

export const LinkCreations = defineModel<Link>({
  rubyClass: "Link",
  prismaModel: "Link",
  delegate: (tx) => tx.link as never,
  beforeValidation,
  validations,
  beforeSave: [
    mergeJsonDataWithCurrentRow<Link>("links"),
    {
      name: "remove_xml_tags",
      run: (link) => {
        const description = link.get("description");
        if (!isBlank(description))
          link.set("description", description!.replace(/<!--\?xml.+\?-->|<!--\[if gte mso.+<!\[endif\]-->/gsu, ""));
      },
    },
  ],
  beforeCreate: [
    {
      name: "set_default_discover_fee_per_thousand",
      run(link) {
        if (link.ivars.sellerDiscoverBoost === true)
          link.set("discover_fee_per_thousand", DEFAULT_BOOSTED_DISCOVER_FEE_PER_THOUSAND);
      },
    },
  ],
  afterCreate: [
    ...paperTrail.afterCreate,
    {
      // The autosave of `prices << price` (associate_price; a tiered membership gets its prices on the tier): the Price row, then the
      // belongs_to touch on the product and its cache invalidation.
      name: "autosave_prices",
      async run(link, ctx) {
        // A membership saved before the action marks it tiered (the custom summary's first save) keeps a plain recurring Price.
        if (link.ivars.tiered === true && link.ivars.untieredFirstSave !== true) return;
        const now = nowOf(ctx);
        const duration =
          link.ivars.untieredFirstSave === true ? SUBSCRIPTION_DURATIONS[link.get("subscription_duration")!]! : null;
        // The failed first save of a physical product with a custom summary already built a Price; the second save builds another.
        for (let copy = 0; copy < (link.ivars.priceCopies as number); copy++)
          await insertPrice(
            {
              linkId: link.get("id"),
              variantId: null,
              cents: Number(link.get("price_cents")),
              currency: link.get("price_currency_type")!,
              recurrence: duration,
            },
            now,
          );
        await Links.touch(link, { now: ctx.now, deferred: true });
        await afterCommitEverywhere(() => invalidateProductCache(link.get("id"), ctx.now));
      },
    },
    {
      // `bundle.bundle_products.build` in BundlesController#create_from_email: the has_many autosave inserts them once the Link and its Price exist.
      name: "autosave_bundle_products",
      async run(link, ctx) {
        for (const member of (link.ivars.bundleMembers as BundleMember[] | undefined) ?? [])
          await BundleProducts.createBang(
            {
              bundle_id: link.get("id"),
              product_id: member.productId,
              variant_id: member.variantId,
              quantity: 1,
              position: null,
              deleted_at: null,
            },
            { now: ctx.now },
          );
      },
    },
    {
      name: "enqueue_search_index!",
      run: (link, ctx) => enqueueSearchIndex(link, ctx.now ?? (() => new Date())),
    },
    {
      name: "initialize_tier_if_needed",
      async run(link, ctx) {
        if (link.ivars.tiered === true && link.ivars.untieredFirstSave !== true) await initializeTier(link, ctx);
      },
    },
    { name: "add_to_profile_sections", run: addToProfileSections },
    { name: "initialize_suggested_amount_if_needed!", run: initializeSuggestedAmount },
  ],
  // The form sets customizable_price itself (`price_range=`), the API only assigns the cents, so only the API create needs the callback.
  afterSave: [{ ...setCustomizablePrice, if: (link) => link.ivars.priceFromCents === true }],
});

export type CreateOutcome =
  | { created: true; link: LinkRecord; priceCents: number | null }
  | { created: false; errors: Errors };

export type CreateSeller = SellerAccount & { isTeamMember: boolean };

// LinksController#create from `current_seller.links.build` to `save!`.
export async function createLink(seller: CreateSeller, params: CreateParams, now?: () => Date): Promise<CreateOutcome> {
  const singleUnit = CURRENCIES[params.currency]!.single_unit;
  let cents: bigint | null = null;
  let customizable = false;
  if (params.priceRange !== null) {
    cents = cleanPriceCents(params.priceRange, singleUnit);
    if (cents > BigInt(MAX_PRICE_CENTS)) throw new LinkInvalid(PRICE_TOO_LARGE);
    // Product::Prices#write_customizable_price runs before the action marks the product tiered, so a membership gets it too.
    customizable = params.priceRange.endsWith("+") || cents === 0n;
  }
  const membership = params.nativeType === "membership";
  if (cents === null && !membership) {
    // Link#associate_price adds the error and raises LinkInvalid, which the action rescues.
    const errors = new Errors();
    errors.add("base", NO_PRICE);
    return { created: false, errors };
  }

  const customAttributes = CUSTOM_ATTRIBUTES[params.nativeType];
  const taxonomy = (
    await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("taxonomies", "id")} FROM ${table("taxonomies")} WHERE ${column("taxonomies", "slug")} = 'other' LIMIT 1`,
    )
  )[0];
  const jsonData: [string, YamlValue][] = [];
  if (params.customSummary !== null) jsonData.push(["custom_summary", params.customSummary]);
  if (customAttributes) jsonData.push(["custom_attributes", customAttributes as unknown as YamlValue]);
  if (params.nativeType === "coffee") jsonData.push(["custom_button_text_option", "donate_prompt"]);

  let flags = LinkFlags.set(0n, "display_product_reviews", true);
  if (params.isPhysical) flags = LinkFlags.set(flags, "is_physical", true);
  if (membership) {
    for (const flag of [
      "is_recurring_billing",
      "is_tiered_membership",
      "should_show_all_posts",
      "should_include_last_post",
    ] as const)
      flags = LinkFlags.set(flags, flag, true);
  }
  if (params.nativeType === "bundle") flags = LinkFlags.set(flags, "is_bundle", true);

  const link = LinkCreations.build({
    user_id: seller.id,
    name: params.name,
    description: params.description,
    native_type: params.nativeType,
    price_cents: cents === null ? null : Number(cents),
    price_currency_type: params.currency,
    customizable_price: customizable,
    subscription_duration:
      params.subscriptionDuration === null ? null : SUBSCRIPTION_DURATIONS.indexOf(params.subscriptionDuration),
    require_shipping: params.isPhysical,
    draft: true,
    purchase_disabled_at: (now ?? (() => new Date()))(),
    taxonomy_id: taxonomy?.id ?? null,
    flags,
    json_data: rubyJsonGenerate(new RubyHash(jsonData)),
  } as Partial<Link>);
  link.ivars.sellerMaxProductPrice = seller.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
  link.ivars.sellerDiscoverBoost = UserFlags.isSet(seller.flags, "discover_boost_enabled");
  link.ivars.tiered = membership;
  link.ivars.priceCopies = params.isPhysical && params.customSummary !== null ? 2 : 1;
  // With a custom summary the action saves the product before it marks it tiered.
  link.ivars.untieredFirstSave = membership && params.customSummary !== null;
  link.ivars.dailyCreationLimit = seller.isTeamMember
    ? null
    : (dailyProductCreationLimit(seller.json_data) ??
      (seller.user_risk_state === "compliant" ? COMPLIANT_DAILY_CREATION_LIMIT : DEFAULT_DAILY_CREATION_LIMIT));
  try {
    if (!(await LinkCreations.save(link, { now }))) return { created: false, errors: link.errors };
  } catch (error) {
    if (error instanceof RelatedRecordInvalid) return { created: false, errors: link.errors };
    throw error;
  }
  // The second save of a product with a custom summary flips draft and purchase_disabled_at, which submits it to IndexNow. For a
  // physical product the first save fails (no require_shipping yet), so the only save is the create and nothing is submitted.
  if (params.customSummary !== null && !params.isPhysical)
    await performAsync("SubmitToIndexnowJob", [[link.get("id")]]);
  // `@product.price_cents` is the saved Price row once the product is persisted: zero for a tier-priced membership and for coffee.
  const tiered = membership && params.customSummary === null;
  const priceCents = tiered || params.nativeType === "coffee" ? 0 : Number(link.get("price_cents"));
  return { created: true, link, priceCents };
}

export type ApiCreateParams = {
  name: string | null;
  description: string | null;
  // The raw `params[:price]`, already a whole number of cents (`price_cents=` assigns it as is, with no clean_price); null when the key is absent.
  priceCents: number | null;
  currency: string;
  // An explicit taxonomy; null falls back to the "other" taxonomy.
  taxonomyId: bigint | null;
  customSummary: string | null;
  // The mass-assigned columns, already cast; undefined when the key is absent.
  maxPurchaseCount?: number | null;
  customizablePrice?: boolean;
  suggestedPriceCents?: number | null;
};

// Api::V2::LinksController#create from `links.build` to the first `save!`: a digital product that starts as a draft with purchases
// disabled. `price_cents=` on a new record only writes the attribute, so a zero price gets customizable_price from the after_save
// set_customizable_price.
export async function createApiLink(
  seller: CreateSeller,
  params: ApiCreateParams,
  now?: () => Date,
): Promise<CreateOutcome> {
  const taxonomyId =
    params.taxonomyId ??
    (
      await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("taxonomies", "id")} FROM ${table("taxonomies")} WHERE ${column("taxonomies", "slug")} = 'other' LIMIT 1`,
      )
    )[0]?.id ??
    null;
  const jsonData: [string, YamlValue][] = [];
  if (params.customSummary !== null) jsonData.push(["custom_summary", params.customSummary]);
  const link = LinkCreations.build({
    user_id: seller.id,
    name: params.name,
    description: params.description,
    native_type: "digital",
    price_cents: params.priceCents,
    price_currency_type: params.currency,
    draft: true,
    purchase_disabled_at: (now ?? (() => new Date()))(),
    taxonomy_id: taxonomyId,
    flags: LinkFlags.set(0n, "display_product_reviews", true),
    json_data: rubyJsonGenerate(new RubyHash(jsonData)),
    ...(params.maxPurchaseCount !== undefined && { max_purchase_count: params.maxPurchaseCount }),
    ...(params.customizablePrice !== undefined && { customizable_price: params.customizablePrice }),
    ...(params.suggestedPriceCents !== undefined && { suggested_price_cents: params.suggestedPriceCents }),
  } as Partial<Link>);
  link.ivars.sellerMaxProductPrice = seller.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
  link.ivars.sellerDiscoverBoost = UserFlags.isSet(seller.flags, "discover_boost_enabled");
  link.ivars.tiered = false;
  link.ivars.priceCopies = 1;
  link.ivars.untieredFirstSave = false;
  link.ivars.priceFromCents = true;
  link.ivars.dailyCreationLimit = seller.isTeamMember
    ? null
    : (dailyProductCreationLimit(seller.json_data) ??
      (seller.user_risk_state === "compliant" ? COMPLIANT_DAILY_CREATION_LIMIT : DEFAULT_DAILY_CREATION_LIMIT));
  if (params.priceCents === null) {
    // Link#associate_price adds the error and raises LinkInvalid, which the action rescues.
    const errors = new Errors();
    errors.add("base", NO_PRICE);
    return { created: false, errors };
  }
  if (!(await LinkCreations.save(link, { now }))) return { created: false, errors: link.errors };
  return { created: true, link, priceCents: params.priceCents };
}

export type BundleMember = { productId: bigint; variantId: bigint | null };

export type BundleFromEmailParams = { name: string; priceCents: number; currency: string; externalIds: string[] };

const NATIVE_TYPE_CALL = "call";
const IS_BUNDLE_FLAG = LinkFlags.bit("is_bundle");
const IS_RECURRING_BILLING_FLAG = LinkFlags.bit("is_recurring_billing");
const SKUS_ENABLED_FLAG = LinkFlags.bit("skus_enabled");

// BundleProduct's product_is_not_bundle, product_is_not_subscription and product_is_not_call.
export const cannotJoinBundle = (product: { flags: bigint | number; native_type: string | null }): boolean =>
  (BigInt(product.flags) & (IS_BUNDLE_FLAG | IS_RECURRING_BILLING_FLAG)) !== 0n ||
  product.native_type === NATIVE_TYPE_CALL;

// Product::BundlesMarketing::BUNDLE_NAMES, which Rails evaluates once at boot: "#{1.year.ago.year} Bundle".
export const bundleMarketingNames = (now: Date): Record<string, string> => ({
  year: `${now.getUTCFullYear() - 1} Bundle`,
  best_selling: "Best Selling Bundle",
  everything: "Everything Bundle",
});

// `current_seller.products.by_external_ids(ids)` (deleted products included, ordered as the primary key scan returns them) with
// `product.alive_variants.first` for each. Null when a product would fail BundleProduct's validations, which fails the bundle's save.
async function bundleMembers(sellerId: bigint, productIds: bigint[]): Promise<BundleMember[] | null> {
  if (productIds.length === 0) return [];
  const products = await selectRows<{ id: bigint; flags: bigint; native_type: string | null }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "flags")}, ${column("links", "native_type")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "id")} IN (${Prisma.join(productIds)}) ORDER BY ${column("links", "id")} ASC`,
  );
  if (products.some((product) => (BigInt(product.flags) & SKUS_ENABLED_FLAG) !== 0n))
    throw new NotPortedError("a bundle product with SKUs enabled", "app/controllers/bundles_controller.rb:26");
  if (products.some(cannotJoinBundle)) return null;
  const members: BundleMember[] = [];
  for (const product of products) {
    const [variant] = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "id")} ASC LIMIT 1`,
    );
    members.push({ productId: BigInt(product.id), variantId: variant === undefined ? null : BigInt(variant.id) });
  }
  return members;
}

// BundlesController#create_from_email from `current_seller.products.build` to `save`: a draft bundle (no purchase_disabled_at, taxonomy or
// reviews flag, unlike POST /links) holding the seller's products. A false save is the stale-link redirect, whatever the cause.
export async function createBundleFromEmail(
  seller: CreateSeller,
  params: BundleFromEmailParams,
  now?: () => Date,
): Promise<CreateOutcome> {
  const decrypted = params.externalIds
    .map((id) => decrypt(id))
    .filter((id): id is number => id !== null)
    .map(BigInt);
  const members = await bundleMembers(seller.id, [...new Set(decrypted)]);
  const link = LinkCreations.build({
    user_id: seller.id,
    name: params.name,
    native_type: "bundle",
    price_cents: params.priceCents,
    price_currency_type: params.currency,
    draft: true,
    flags: LinkFlags.set(LinkFlags.set(0n, "is_bundle", true), "from_bundle_marketing", true),
    json_data: rubyJsonGenerate(new RubyHash([])),
  } as Partial<Link>);
  link.ivars.sellerMaxProductPrice = seller.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
  link.ivars.sellerDiscoverBoost = UserFlags.isSet(seller.flags, "discover_boost_enabled");
  link.ivars.tiered = false;
  link.ivars.priceCopies = 1;
  link.ivars.untieredFirstSave = false;
  // A free bundle becomes pay-what-you-want in set_customizable_price after the save.
  link.ivars.priceFromCents = true;
  link.ivars.bundleMembers = members ?? [];
  link.ivars.dailyCreationLimit = seller.isTeamMember
    ? null
    : (dailyProductCreationLimit(seller.json_data) ??
      (seller.user_risk_state === "compliant" ? COMPLIANT_DAILY_CREATION_LIMIT : DEFAULT_DAILY_CREATION_LIMIT));
  if (members === null || !(await LinkCreations.save(link, { now }))) return { created: false, errors: link.errors };
  return { created: true, link, priceCents: params.priceCents };
}
