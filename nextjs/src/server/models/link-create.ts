// Link creation for LinksController#create: the save callback chain of a new product, as far as recorded examples prove it
// (spec/requests/links_create_parity_spec.rb). Kept apart from link.ts, whose `Links` model refuses a new record.
//
// Served: a non-recurring digital, course, ebook or audiobook priced in USD, with an optional description. Everything else a Link
// save can do on create (tiers, physical shipping, calls, coffee, commissions, bundles, other currencies and their exchange rates,
// the custom summary, AI generation) throws NotPortedError from `parseCreateParams` or `assertCreatable`, before any write.
import { randomInt } from "node:crypto";

import { Prisma, type Link } from "@prisma/client";

import { isFeatureEnabled } from "../infra/flipper.ts";
import { ProductRecord } from "../search/documents/product.ts";
import { performProductIndexing } from "../search/product-indexing.ts";

import { isAdult } from "./concerns/adult-keyword-detector.ts";
import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { RubyHash, type YamlValue } from "./concerns/psych.ts";
import { rubyJsonGenerate } from "./concerns/serialized-columns.ts";
import LINK_DATA from "./link-data.generated.json" with { type: "json" };
import {
  DEFAULT_BOOSTED_DISCOVER_FEE_PER_THOUSAND,
  invalidateProductCache,
  LinkFlags,
  LinkInvalid,
  Links,
  MAX_NAME_LENGTH,
  type LinkRecord,
} from "./link.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { Errors } from "./runtime/errors.ts";
import { withExecutor } from "./runtime/query-cache.ts";
import { isBlank, rubyLength } from "./runtime/validators.ts";
import { column, execute, selectRows, table } from "./sql.ts";
import { MAX_PRICE_USD_CENTS_UNLESS_VERIFIED, NotPortedError, UserFlags } from "./user.ts";

// BasePrice::Shared::MAX_PRICE_CENTS
const MAX_PRICE_CENTS = 2_147_483_647;
const USD = "usd";
const PRICE_TOO_LARGE = "Sorry, the price entered is too large.";
// Product::NativeTypeTemplates::DEFAULT_ATTRIBUTES_FOR_TYPE for the types served here.
const CUSTOM_ATTRIBUTES: Record<string, { name: string; value: string }[]> = {
  ebook: [{ name: "Pages", value: "" }],
  audiobook: [{ name: "Length", value: "" }],
};
export const SERVED_NATIVE_TYPES = ["digital", "course", "ebook", "audiobook"];
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
// The smallest Product::CreationLimit#daily_creation_limit: below it no seller is stopped, whatever their risk state.
const SMALLEST_DAILY_CREATION_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CreateParams = {
  name: string | null;
  priceRange: string;
  nativeType: string;
  description: string | null;
};

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
  if (link.is_physical !== undefined && link.is_physical !== null && link.is_physical !== false)
    throw new NotPortedError("a physical product", "app/controllers/links_controller.rb:91");
  if (link.is_recurring_billing !== undefined && link.is_recurring_billing !== false)
    throw new NotPortedError("a recurring product", "app/models/link.rb:2309");
  if (link.subscription_duration !== undefined && link.subscription_duration !== null)
    throw new NotPortedError("a subscription duration", "app/models/link.rb:477");
  if (link.price_currency_type !== undefined && link.price_currency_type !== USD)
    throw new NotPortedError("a currency other than USD", "app/helpers/currency_helper.rb:96");
  if (link.custom_summary !== undefined && link.custom_summary !== null && link.custom_summary !== "")
    throw new NotPortedError("a custom summary", "app/controllers/links_controller.rb:107");
  if (link.ai_prompt !== undefined && link.ai_prompt !== null && link.ai_prompt !== "")
    throw new NotPortedError("an AI prompt", "app/controllers/links_controller.rb:124");

  const nativeType = link.native_type;
  if (typeof nativeType !== "string" || !SERVED_NATIVE_TYPES.includes(nativeType))
    throw new NotPortedError(`the native type ${JSON.stringify(nativeType)}`, "app/models/link.rb:466");

  const price = link.price_range;
  // `return unless price` leaves the product without a price, which associate_price refuses.
  if (price === undefined || price === null)
    throw new NotPortedError("a product without a price", "app/modules/product/prices.rb:398");
  let priceRange: string;
  if (typeof price === "string") priceRange = price;
  else if (typeof price === "number" && Number.isFinite(price) && !String(price).includes("e"))
    priceRange = String(price);
  else throw new NotPortedError("a price that is neither text nor a plain number", "app/modules/product/prices.rb:76");

  return {
    name: text(link.name, "name"),
    priceRange,
    nativeType,
    description: text(link.description, "description"),
  };
}

// BasePrice::Shared#clean_price and CurrencyHelper#string_to_price_cents for USD (not a single-unit currency).
export function cleanPriceCents(priceString: string): bigint {
  let clean = priceString.replace(/[^-0-9.,]/gu, "");
  // Euro style: a comma two places from the end is the decimal mark.
  if (clean.lastIndexOf(",") !== -1 && clean.lastIndexOf(",") === clean.length - 3)
    clean = clean.replaceAll(".", "").replaceAll(",", ".");
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
  const digits = fraction.padEnd(3, "0");
  let cents = BigInt(whole!) * 100n + BigInt(digits.slice(0, 2));
  // BigDecimal#round rounds half away from zero.
  if (Number(digits[2]) >= 5) cents += 1n;
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

// Everything the port declines to model about this seller's account, asked before the first write.
export async function assertCreatable(seller: {
  id: bigint;
  isTeamMember: boolean;
  json_data: string | null;
}): Promise<void> {
  const sections = await selectRows<{ json_data: string | Record<string, unknown> | null }>(
    Prisma.sql`SELECT ${column("seller_profile_sections", "json_data")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "type")} = 'SellerProfileProductsSection' AND ${column("seller_profile_sections", "seller_id")} = ${seller.id}`,
  );
  for (const { json_data } of sections) {
    if (json_data === null) continue;
    const hash = typeof json_data === "string" ? (JSON.parse(json_data) as Record<string, unknown>) : json_data;
    if (hash.add_new_products === true)
      throw new NotPortedError("a products section that adds new products", "app/models/link.rb:2283");
  }
  if (seller.isTeamMember) return;
  // Product::CreationLimit: `daily_product_creation_limit` is a json_data accessor and the default depends on the risk state.
  if (seller.json_data?.includes("daily_product_creation_limit"))
    throw new NotPortedError(
      "a seller with a daily product creation limit",
      "app/modules/product/creation_limit.rb:56",
    );
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "created_at")} >= ${new Date(Date.now() - DAY_MS)} AND ${column("links", "deleted_at")} IS NULL`,
  );
  if (Number(Object.values(row ?? {})[0] ?? 0) >= SMALLEST_DAILY_CREATION_LIMIT)
    throw new NotPortedError(
      "a seller near the daily product creation limit",
      "app/modules/product/creation_limit.rb:43",
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

const beforeValidation: Callback<Link>[] = [
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
    name: "validates :name, presence: true, length: { maximum: 255 }",
    run(link) {
      const name = link.get("name");
      if (isBlank(name)) link.errors.add("name", "blank");
      if (rubyLength(name) > MAX_NAME_LENGTH) link.errors.add("name", "too_long", { count: MAX_NAME_LENGTH });
    },
  },
  {
    name: "validates :unique_permalink, presence: true",
    run(link) {
      if (isBlank(link.get("unique_permalink"))) link.errors.add("unique_permalink", "blank");
    },
  },
  {
    // price_must_be_within_range: only the USD branch is served.
    name: "price_must_be_within_range",
    run(link, _ctx) {
      const cents = Number(link.get("price_cents"));
      if (cents === 0) return;
      const config = LINK_DATA.currencies[USD];
      if (cents > MAX_PRICE_CENTS) link.errors.add("base", PRICE_TOO_LARGE);
      else if (cents < config.min_price)
        link.errors.add("base", `Sorry, a product must be at least ${config.min_price_formatted}.`);
      else if (link.ivars.sellerMaxProductPrice != null && cents > (link.ivars.sellerMaxProductPrice as number))
        link.errors.add("base", "Sorry, we don't support pricing products above $5,000.");
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
      // The autosave of `prices << price`: the Price row, then the belongs_to touch on the product and its cache invalidation.
      name: "autosave_prices",
      async run(link, ctx) {
        const now = (ctx.now ?? (() => new Date()))();
        await execute(
          Prisma.sql`INSERT INTO ${table("prices")} (${column("prices", "link_id")}, ${column("prices", "price_cents")}, ${column("prices", "currency")}, ${column("prices", "recurrence")}, ${column("prices", "created_at")}, ${column("prices", "updated_at")}, ${column("prices", "deleted_at")}, ${column("prices", "flags")}, ${column("prices", "variant_id")}, ${column("prices", "suggested_price_cents")}) VALUES (${link.get("id")}, ${link.get("price_cents")}, ${USD}, NULL, ${now}, ${now}, NULL, 0, NULL, NULL)`,
        );
        await Links.touch(link, { now: ctx.now, deferred: true });
        await afterCommitEverywhere(() => invalidateProductCache(link.get("id"), ctx.now));
      },
    },
    {
      name: "enqueue_search_index!",
      run: (link, ctx) => enqueueSearchIndex(link, ctx.now ?? (() => new Date())),
    },
  ],
});

export type CreateOutcome =
  | { created: true; link: LinkRecord; priceCents: number }
  | { created: false; errors: Errors };

// LinksController#create from `current_seller.links.build` to `save!`.
export async function createLink(
  seller: { id: bigint; flags: bigint; verified: boolean | null },
  params: CreateParams,
  now?: () => Date,
): Promise<CreateOutcome> {
  const cents = cleanPriceCents(params.priceRange);
  if (cents > BigInt(MAX_PRICE_CENTS)) throw new LinkInvalid(PRICE_TOO_LARGE);
  const customizable = params.priceRange.endsWith("+") || cents === 0n;
  const customAttributes = CUSTOM_ATTRIBUTES[params.nativeType];
  const taxonomy = (
    await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("taxonomies", "id")} FROM ${table("taxonomies")} WHERE ${column("taxonomies", "slug")} = 'other' LIMIT 1`,
    )
  )[0];
  const link = LinkCreations.build({
    user_id: seller.id,
    name: params.name,
    description: params.description,
    native_type: params.nativeType,
    price_cents: Number(cents),
    price_currency_type: USD,
    customizable_price: customizable,
    draft: true,
    purchase_disabled_at: (now ?? (() => new Date()))(),
    taxonomy_id: taxonomy?.id ?? null,
    flags: LinkFlags.set(0n, "display_product_reviews", true),
    json_data: rubyJsonGenerate(
      new RubyHash(customAttributes ? [["custom_attributes", customAttributes as unknown as YamlValue]] : []),
    ),
  } as Partial<Link>);
  link.ivars.sellerMaxProductPrice = seller.verified ? null : MAX_PRICE_USD_CENTS_UNLESS_VERIFIED;
  link.ivars.sellerDiscoverBoost = UserFlags.isSet(seller.flags, "discover_boost_enabled");
  if (!(await LinkCreations.save(link, { now }))) return { created: false, errors: link.errors };
  return { created: true, link, priceCents: Number(cents) };
}
