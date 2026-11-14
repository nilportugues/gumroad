// Write side of app/models/offer_code.rb, for what Api::V2::OfferCodesController#create, #update and #destroy save: a plain code, meaning
// no cancellation or upsell role, customer limits, duration tiers, excluded products or option scope (it may be applied automatically), on products
// that are neither memberships nor have options (`assertPlainCode`, `assertPlainProducts`). Both guards are meant to run before the first
// statement, so a code outside them goes to Rails with nothing written; the validations and callbacks they leave out are the ones that
// cannot fire for a plain code (each is named below where its Ruby declaration sits). The read side is offer-code.ts.
//
// Rails-recorded proof: spec/requests/api/v2/offer_codes_writes_parity_spec.rb, replayed by parity/__tests__/api-v2-ws17c.replay.test.ts
// (row diffs, jobs, response). Not provable there and so pinned only by the unit tests: the order of the statements inside the save, the
// Redis writes of the reindex enqueue (the recorder keeps Redis as it was before the request), and the PaperTrail rows (off in specs).
import { Prisma, type Link, type OfferCode } from "@prisma/client";

import { afterCommitEverywhere } from "./concerns/job-runtime.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { currencyOf, invalidateProductCache, LinkFlags } from "./link.ts";
import { enqueueProductsOfferCodesReindex, enqueueSellerOfferCodesReindex } from "./offer-code-index.ts";
import { amountOff, isCents, isPercent, OfferCodeFlags, OfferCodeRecord } from "./offer-code.ts";
import { type Callback, defineModel } from "./runtime/define-model.ts";
import { type ModelRecord } from "./runtime/record.ts";
import {
  isBlank,
  rubyLength,
  validatesAssociatedPresence,
  validatesFormatOf,
  validatesPresenceOf,
  validatesUniquenessOf,
} from "./runtime/validators.ts";
import { column, execute, selectRows, table } from "./sql.ts";
import { NotPortedError, rubyStrip, strippedField } from "./user.ts";

export const MAX_PURCHASE_COUNT_RANGE = { min: 0, max: 10_000_000 } as const;
const OFFER_CODES = "offer_codes";
// OfferCode::MAX_SALE_LABEL_LENGTH
const MAX_SALE_LABEL_LENGTH = 32;
// Columns whose change makes a code applicable to different products (OfferCode#note_column_applicability_changes).
const APPLICABILITY_COLUMNS = ["universal", "currency_type", "deleted_at", "code", "new_customers_only"];
// validates :code, format: ... (Latin-1 letters included)
const CODE_FORMAT = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\-_]*$/u;

type OfferCodeWrite = ModelRecord<OfferCode>;
const notPorted = (what: string): never => {
  throw new NotPortedError(what, "app/models/offer_code.rb");
};

// OfferCode#products of a saved code: the join rows' products, soft-deleted ones included.
export const productsOfOfferCode = (offerCodeId: number) =>
  selectRows<Link>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} INNER JOIN ${table("offer_codes_products")} ON ${column("links", "id")} = ${column("offer_codes_products", "product_id")} WHERE ${column("offer_codes_products", "offer_code_id")} = ${offerCodeId}`,
  );

// `user.links.alive`, narrowed to the code's currency when it has one: what a universal code applies to (it has no excluded products, see
// assertPlainCode).
export const universalProducts = (userId: number | bigint, currencyType: string | null) =>
  selectRows<Link>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${userId} AND ${column("links", "deleted_at")} IS NULL${isBlank(currencyType) ? Prisma.empty : Prisma.sql` AND ${column("links", "price_currency_type")} = ${currencyType}`}`,
  );

// OfferCode#products: the list a new code was given, else the join rows.
const PRODUCTS = "products";
const loadedProducts = async (record: OfferCodeWrite): Promise<Link[]> => {
  const known = record.ivars[PRODUCTS] as Link[] | undefined;
  if (known) return known;
  const rows = await productsOfOfferCode(record.get("id"));
  record.ivars[PRODUCTS] = rows;
  return rows;
};

// OfferCode#applicable_products
const applicableProducts = (record: OfferCodeWrite): Promise<Link[]> =>
  record.get("universal")
    ? universalProducts(record.get("user_id"), record.get("currency_type"))
    : loadedProducts(record);

// ---------------------------------------------------------------------------------------------
// Products

// Product::Prices#available_price_cents for a product that is not a tiered membership and has no options.
async function availablePriceCents(product: Link): Promise<(number | null)[]> {
  const rows = await selectRows<{ price_cents: number | null }>(
    Prisma.sql`SELECT ${column("prices", "price_cents")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${product.id} AND ${column("prices", "deleted_at")} IS NULL AND ((${column("prices", "flags")} & 1 = 0))`,
  );
  return [...new Set(rows.map((row) => row.price_cents))];
}

// Link#current_base_variants.present?
async function hasCurrentBaseVariants(product: Link): Promise<boolean> {
  const [row] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("base_variants")} WHERE ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "link_id")} = ${product.id} OR ${column("base_variants", "variant_category_id")} IN (SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL))) AS found`,
  );
  return Number(row?.found ?? 0) > 0;
}

// Products whose available prices are not the plain buy prices (tiers, options, rentals) and currencies the port holds no minimum for
// need prices the port does not read.
export async function assertPlainProducts(products: Link[]): Promise<void> {
  for (const product of products) {
    if (LinkFlags.isSet(product.flags, "is_tiered_membership")) notPorted("a discount on a membership");
    if (product.purchase_type === 1) notPorted("a discount on a rental product");
    if (currencyOf(product.price_currency_type) === undefined)
      notPorted("a discount on a product in an unknown currency");
    if (await hasCurrentBaseVariants(product)) notPorted("a discount on a product with options");
  }
}

// A saved code outside the plain shape.
export async function assertPlainCode(row: OfferCode): Promise<void> {
  if (OfferCodeFlags.isSet(row.flags, "is_cancellation_discount")) notPorted("a cancellation discount");
  if (row.existing_customers_only || row.new_customers_only) notPorted("a code limited to existing or new customers");
  if (row.duration_in_months != null) notPorted("a code with a duration in billing cycles");
  const tiers = row.ownership_duration_tiers;
  if (tiers != null && !(Array.isArray(tiers) && tiers.length === 0)) notPorted("a code with duration tiers");
  const [related] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT (EXISTS (SELECT 1 FROM ${table("upsells")} WHERE ${column("upsells", "offer_code_id")} = ${row.id}) OR EXISTS (SELECT 1 FROM ${table("offer_codes_excluded_products")} WHERE ${column("offer_codes_excluded_products", "offer_code_id")} = ${row.id}) OR EXISTS (SELECT 1 FROM ${table("offer_codes_variants")} WHERE ${column("offer_codes_variants", "offer_code_id")} = ${row.id}) OR EXISTS (SELECT 1 FROM ${table("offer_codes_ownership_products")} WHERE ${column("offer_codes_ownership_products", "offer_code_id")} = ${row.id}) OR EXISTS (SELECT 1 FROM ${table("offer_codes_ownership_variants")} WHERE ${column("offer_codes_ownership_variants", "offer_code_id")} = ${row.id})) AS found`,
  );
  if (Number(related?.found ?? 0) > 0)
    notPorted("a code with an upsell, exclusions, options or ownership products or options");
}

// ---------------------------------------------------------------------------------------------
// Validations

const eligibleQuantity = (record: OfferCodeWrite) =>
  isCents(attributesOf(record)) && OfferCodeFlags.isSet(record.get("flags"), "once_per_cart")
    ? Math.max(Number(record.get("minimum_quantity") ?? 0), 1)
    : 1;
const attributesOf = (record: OfferCodeWrite) => ({
  amount_cents: record.get("amount_cents"),
  amount_percentage: record.get("amount_percentage"),
});

// OfferCode#is_amount_valid? (an untiered code)
export async function isAmountValid(record: OfferCodeWrite, product: Link): Promise<boolean> {
  const minPrice = currencyOf(product.price_currency_type)!.min_price;
  for (const unitPriceCents of await availablePriceCents(product)) {
    const eligible = (unitPriceCents ?? 0) * eligibleQuantity(record);
    const priceAfterCode = eligible - amountOff(attributesOf(record), eligible);
    if (!(priceAfterCode <= 0 || priceAfterCode >= minPrice)) return false;
  }
  return true;
}

// OfferCode#price_validation
async function priceValidation(record: OfferCodeWrite): Promise<void> {
  if (record.get("deleted_at") != null) return;
  const amounts = attributesOf(record);
  if ((isPercent(amounts) && amounts.amount_percentage! < 0) || (isCents(amounts) && amounts.amount_cents! < 0))
    return void record.errors.add("base", "Please enter a positive discount amount.");
  if (!isPercent(amounts) && !isCents(amounts))
    return void record.errors.add("base", "Please enter a discount amount.");
  if (isPercent(amounts) && amounts.amount_percentage! > 100)
    return void record.errors.add("base", "Please enter a discount amount that is 100% or less.");
  for (const product of await applicableProducts(record)) {
    const config = currencyOf(product.price_currency_type)!;
    if (!(await isAmountValid(record, product)))
      record.errors.add(
        "base",
        `The price after discount for all of your products must be either ${config.symbol}0 or at least ${config.min_price_formatted}.`,
      );
    // validate_membership_price_after_discount: plain products are no memberships.
    const currencyType = record.get("currency_type");
    if (!(isPercent(amounts) || currencyType == null || product.price_currency_type === currencyType))
      record.errors.add(
        "base",
        `This discount code uses ${currencyType.toUpperCase()} but the product uses ${product.price_currency_type?.toUpperCase()}. Please change the discount code to use the same currency as the product.`,
      );
    if (!record.errors.isEmpty()) return;
  }
}

// OfferCode#max_purchase_count_is_greater_than_or_equal_to_inventory_sold
async function maxPurchaseCountCoversUses(record: OfferCodeWrite): Promise<void> {
  if (record.get("deleted_at") != null || !record.attributeChanged("max_purchase_count")) return;
  const max = record.get("max_purchase_count");
  if (max == null) return;
  // A new code has no purchases, and Rails does not query for them.
  const used = record.newRecord ? 0 : await new OfferCodeRecord(record.attributes as OfferCode).timesUsed();
  if (max >= used) return;
  record.errors.add(
    "base",
    `You have chosen a discount code quantity that is less that the number already used. Please enter an amount no less than ${used}.`,
  );
}

// OfferCode#expires_at_is_after_valid_at
function expiresAfterValid(record: OfferCodeWrite): void {
  const validAt = record.get("valid_at");
  const expiresAt = record.get("expires_at");
  if ((validAt != null && expiresAt != null && expiresAt <= validAt) || (validAt == null && expiresAt != null))
    record.errors.add("base", "The discount code's start date must be earlier than its end date.");
}

// OfferCode#validate_not_used_as_default_discount
async function notUsedAsDefaultDiscount(record: OfferCodeWrite): Promise<void> {
  if (!record.attributeChanged("deleted_at") || record.get("deleted_at") == null || !record.persisted) return;
  const [row] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("links")} WHERE ${column("links", "default_offer_code_id")} = ${record.get("id")} AND ${column("links", "deleted_at")} IS NULL) AS found`,
  );
  if (Number(row?.found ?? 0) > 0)
    record.errors.add(
      "base",
      "This discount code is currently set as the default discount for one or more active or archived products. Please remove it from all products before deleting.",
    );
}

// OfferCode#validate_auto_apply. A plain code is never a cancellation discount, an upsell or limited to new customers
// (assertPlainCode), so only the "all products" rule and the one-code-per-seller rule can fire.
async function autoApplyIsValid(record: OfferCodeWrite): Promise<void> {
  if (!record.get("auto_apply") || record.get("deleted_at") != null) return;
  if (!record.get("universal"))
    record.errors.add("base", "Only a discount that applies to all products can be applied automatically.");
  const userId = record.get("user_id");
  if (userId == null) return;
  // A saved code locks the other rows it reads (a current read); a new one does not.
  const [other] = await selectRows<{ code: string | null }>(
    Prisma.sql`SELECT ${column(OFFER_CODES, "code")} FROM ${table(OFFER_CODES)} WHERE ${column(OFFER_CODES, "deleted_at")} IS NULL AND ${column(OFFER_CODES, "user_id")} = ${userId} AND ${column(OFFER_CODES, "auto_apply")} = TRUE${record.persisted ? Prisma.sql` AND ${column(OFFER_CODES, "id")} != ${record.get("id")}` : Prisma.empty} ORDER BY ${column(OFFER_CODES, "id")} ASC LIMIT 1${record.persisted ? Prisma.raw(" FOR UPDATE") : Prisma.empty}`,
  );
  if (other !== undefined)
    record.errors.add(
      "base",
      `Another discount (${other.code ?? ""}) is already applied automatically. Turn it off first.`,
    );
}

// OfferCode#validate_sale_label
function saleLabelIsValid(record: OfferCodeWrite): void {
  const label = record.get("sale_label");
  if (isBlank(label)) return;
  if (rubyLength(label) > MAX_SALE_LABEL_LENGTH)
    record.errors.add("base", `The sale label can be at most ${MAX_SALE_LABEL_LENGTH} characters.`);
  else if (/[<>]/u.test(label!)) record.errors.add("base", "The sale label must be plain text.");
}

// OfferCode#code_validation: no other code of the product or universal code that applies to it has the same code.
async function codeIsUnique(record: OfferCodeWrite): Promise<void> {
  if (record.get("deleted_at") != null || record.get("universal")) return;
  for (const product of await applicableProducts(record)) {
    const others = await selectRows<{ id: number; code: string | null }>(
      Prisma.sql`SELECT ${column(OFFER_CODES, "id")}, ${column(OFFER_CODES, "code")} FROM ${table(OFFER_CODES)} WHERE ${column(OFFER_CODES, "id")} IN (SELECT offer_code_id FROM offer_codes_products WHERE product_id = ${product.id}) AND ${column(OFFER_CODES, "deleted_at")} IS NULL UNION ALL SELECT ${column(OFFER_CODES, "id")}, ${column(OFFER_CODES, "code")} FROM ${table(OFFER_CODES)} WHERE ${column(OFFER_CODES, "user_id")} = ${product.user_id} AND universal = 1 AND (currency_type = ${product.price_currency_type} OR currency_type IS NULL) AND ${column(OFFER_CODES, "deleted_at")} IS NULL AND NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${product.id})`,
    );
    if (others.some((other) => record.get("code") === other.code && record.get("id") !== other.id)) {
      record.errors.add("base", "Discount code must be unique.");
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Callbacks

const paperTrail = hasPaperTrail<OfferCode>("OfferCode", { itemType: "OfferCode" });

// belongs_to :user (required)
const userExists = async (id: unknown) =>
  (await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ${column("users", "id")} = ${id} LIMIT 1`))
    .length > 0;

// OfferCode#reindex_associated_products
async function reindexAssociatedProducts(record: OfferCodeWrite): Promise<void> {
  const universal = record.get("universal");
  const catalogue = universal || record.attributeBeforeLastSave("universal");
  const sellerId = record.get("user_id");
  const sellerIds = [...new Set([sellerId, record.attributeBeforeLastSave("user_id")].filter((id) => id != null))];
  const targeted = (await loadedProducts(record)).map((product) => product.id);
  await afterCommitEverywhere(async () => {
    if (catalogue) for (const id of sellerIds) await enqueueSellerOfferCodesReindex(id);
    if (targeted.length > 0) await enqueueProductsOfferCodesReindex(sellerId, targeted);
  });
}

const APPLICABILITY_CHANGED = "applicability_changed";
export const EXPIRING_CONTEXT = "expiring";

export const OfferCodes = defineModel<OfferCode>({
  rubyClass: "OfferCode",
  prismaModel: "OfferCode",
  delegate: (tx) => tx.offerCode as never,
  beforeValidation: [
    {
      // MaxPurchaseCount#constrain_max_purchase_count_within_range. Its numericality validation, declared with it, cannot fail afterwards.
      name: "constrain_max_purchase_count_within_range",
      run(record) {
        const max = record.get("max_purchase_count");
        if (max != null)
          record.set(
            "max_purchase_count",
            Math.min(Math.max(max, MAX_PURCHASE_COUNT_RANGE.min), MAX_PURCHASE_COUNT_RANGE.max),
          );
      },
    },
    { name: "stripped_fields :code", run: (record) => record.set("code", strippedField(record.get("code"))) },
    {
      // A label belongs to the auto-applied sale and is cleared from any other code.
      name: "normalize_sale_label",
      run(record) {
        const label = record.get("sale_label");
        record.set("sale_label", record.get("auto_apply") ? (isBlank(label) ? null : rubyStrip(label!)) : null);
      },
    },
    {
      name: "lock_seller_for_auto_apply",
      if: (record) => record.get("auto_apply"),
      // `User.where(id: user_id).lock.pick(:id)`: a locking read of the seller, so concurrent saves for one seller serialize.
      async run(record) {
        const userId = record.get("user_id");
        if (userId == null || record.get("deleted_at") != null) return;
        await selectRows(
          Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1 FOR UPDATE`,
        );
      },
    },
    {
      name: "auto_apply = false if nil",
      run(record) {
        if (record.get("auto_apply") == null) record.set("auto_apply", false);
      },
    },
  ],
  validations: [
    validatesAssociatedPresence<OfferCode>("user", "user_id", userExists),
    // Both `code` validators carry `unless: is_cancellation_discount? || upsell.present?`, which no plain code satisfies.
    validatesPresenceOf<OfferCode>(["code"]),
    validatesFormatOf<OfferCode>(["code"], {
      with: CODE_FORMAT,
      message: "can only contain numbers, letters, dashes, and underscores.",
    }),
    { name: "max_purchase_count_is_greater_than_or_equal_to_inventory_sold", run: maxPurchaseCountCoversUses },
    { name: "expires_at_is_after_valid_at", run: expiresAfterValid },
    // `unless: validation_context == :expiring`: ending a code is never refused by prices it already fails.
    {
      name: "price_validation",
      run: priceValidation,
      unless: (record) => record.validationContext === EXPIRING_CONTEXT,
    },
    { name: "validate_not_used_as_default_discount", run: notUsedAsDefaultDiscount },
    // validate_cancellation_discount_*, validate_existing_customer_settings, validate_new_customer_settings, validate_ownership_duration_tiers,
    // validate_excluded_products and validate_option_scope return at once for a plain code.
    // validate_default_discount_remains_applicable has nothing to detach: the API never changes a code's currency or product list.
    { name: "validate_auto_apply", run: autoApplyIsValid },
    { name: "validate_sale_label", run: saleLabelIsValid },
    validatesUniquenessOf<OfferCode>(OFFER_CODES, ["code"], {
      scope: ["user_id", "deleted_at"],
      if: (record) => record.get("universal"),
      unless: (record) => record.get("deleted_at") != null,
      message: "must be unique.",
    }),
    { name: "code_validation", run: codeIsUnique },
  ] as Callback<OfferCode>[],
  afterCreate: [
    ...paperTrail.afterCreate,
    {
      // The join rows of has_and_belongs_to_many :products, saved by the association's autosave once the code has an id.
      name: "autosave_associated_records_for_products",
      async run(record, ctx) {
        const now = (ctx.now ?? (() => new Date()))();
        for (const product of (record.ivars[PRODUCTS] as Link[] | undefined) ?? [])
          await execute(
            Prisma.sql`INSERT INTO ${table("offer_codes_products")} (${Prisma.raw("`offer_code_id`, `product_id`, `created_at`, `updated_at`")}) VALUES (${record.get("id")}, ${product.id}, ${now}, ${now})`,
          );
      },
    },
  ],
  afterUpdate: [...paperTrail.afterUpdate],
  afterSave: [
    {
      name: "invalidate_product_cache",
      async run(record, ctx) {
        for (const product of await loadedProducts(record)) await invalidateProductCache(product.id, ctx.now);
      },
    },
    // forget_auto_apply_offer_code clears Current, which lives for one Rails request.
    { name: "reindex_associated_products", run: reindexAssociatedProducts },
    {
      name: "note_column_applicability_changes",
      run(record) {
        // previously_new_record?: the save that just ran was the insert.
        if (record.savedChanges.id !== undefined) return;
        record.ivars[APPLICABILITY_CHANGED] ||= Object.keys(record.savedChanges).some((key) =>
          APPLICABILITY_COLUMNS.includes(key),
        );
      },
    },
  ],
  afterCommit: [
    {
      // repair_detached_default_discounts: a code that is some product's default cannot be deleted (notUsedAsDefaultDiscount) and the API
      // changes none of the other columns, so there is nothing detached to clear.
      name: "repair_detached_default_discounts",
      if: (record) => record.ivars[APPLICABILITY_CHANGED] === true,
      async run(record) {
        record.ivars[APPLICABILITY_CHANGED] = false;
        const [row] = await selectRows<{ found: number | bigint }>(
          Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("links")} WHERE ${column("links", "default_offer_code_id")} = ${record.get("id")} AND ${column("links", "deleted_at")} IS NULL) AS found`,
        );
        if (Number(row?.found ?? 0) > 0) notPorted("a default discount detached by a concurrent write");
      },
    },
  ],
  afterRollback: [
    {
      name: "forget_applicability_changes",
      run(record) {
        record.ivars[APPLICABILITY_CHANGED] = false;
      },
    },
  ],
});

// OfferCode.new(...) with the human attribute name OfferCode overrides.
export function buildOfferCode(attributes: Partial<OfferCode>, products: Link[] = []): OfferCodeWrite {
  const record = OfferCodes.build(attributes);
  record.errors.humanNames.code = "Discount code";
  record.ivars[PRODUCTS] = products;
  return record;
}

export function loadOfferCode(row: OfferCode): OfferCodeWrite {
  const record = OfferCodes.load(row);
  record.errors.humanNames.code = "Discount code";
  return record;
}

// `offer_code.products << product` on a new code: the after_add callback `reindex_removed_product` runs at once, outside any transaction,
// so a code the validations refuse has already queued its reindex.
export async function addProduct(record: OfferCodeWrite, product: Link): Promise<void> {
  const products = (record.ivars[PRODUCTS] ??= []) as Link[];
  products.push(product);
  await enqueueProductsOfferCodesReindex(product.user_id!, [product.id]);
}
