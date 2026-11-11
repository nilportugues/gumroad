// Checkout::DiscountsController's reads (`fetch_offer_codes`, #statistics) and Checkout::DiscountsPresenter. A code or an option the port
// cannot read the way Rails does (tiers that start in one month, an option whose category is gone) throws NotPortedError.
import { Prisma, type BaseVariant, type Link, type OfferCode, type User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled } from "../infra/flipper.ts";
import { LinkFlags } from "../models/link.ts";
import {
  OfferCodeFlags,
  OfferCodeRecord,
  NON_GIFT_SUCCESS_STATES,
  NOT_RECURRING_CHARGE,
  countsTowardsUses,
  normalizeTiers,
  poc,
  purchaseFlag,
  states,
} from "../models/offer-code.ts";
import { castRow, column, columnIn, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { BLACK_FRIDAY_CODE } from "../page-props/discover/discover.ts";
import { checkoutOfferCodePolicy } from "../policies/checkout-offer-code.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { timeAsJson } from "../search/es-json.ts";

import type { LinkRow, UserRow } from "./product-reads.ts";
import { longUrl } from "./product.ts";

export const PER_PAGE = 10;
export const BLACK_FRIDAY_CODE_NAME = "Black Friday 2025";
const DASHBOARD_PAGES = ["discounts", "form", "upsells"];
const DEFAULT_CURRENCY = "usd";
const UNTITLED = "Untitled";
const SORT_KEYS = ["name", "revenue", "uses", "term"] as const;

export type Sort = { key?: string; direction?: string };
export type ListingParams = { page: number; query: string | null; sort: Sort };
type Pagination = { pages: number; page: number };

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

// ---------------------------------------------------------------------------------------------
// OfferCode::Sorting#sorted_by

// Purchase.offer_code_statistics: the association scope lands in the join's ON clause.
const statisticsCondition = () =>
  Prisma.sql`${states(NON_GIFT_SUCCESS_STATES)} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)}`;

// OfferCode::Sorting::USES_SORT_SQL
const USES_SORT_SQL = Prisma.sql`COALESCE(SUM(CASE WHEN ${poc("once_per_cart")} = TRUE THEN CASE WHEN ${poc("once_per_cart_allocation_id")} IS NULL THEN 1 ELSE 0 END ELSE ${column("purchases", "quantity")} END), 0) + COUNT(DISTINCT CASE WHEN ${poc("once_per_cart")} = TRUE THEN ${poc("once_per_cart_allocation_id")} END)`;

function sortClauses(sort: Sort): { joins: Prisma.Sql; group: Prisma.Sql; order: Prisma.Sql } {
  const direction = sort.direction === "desc" ? Prisma.raw("desc") : Prisma.raw("asc");
  const none = { joins: Prisma.empty, group: Prisma.empty, order: Prisma.empty };
  switch (sort.key) {
    case "name":
      return { ...none, order: Prisma.sql`${column("offer_codes", "name")} ${direction}, ` };
    case "revenue":
      return {
        joins: Prisma.sql`LEFT OUTER JOIN ${table("purchases")} ON ${column("purchases", "offer_code_id")} = ${column("offer_codes", "id")} AND ${statisticsCondition()}`,
        group: Prisma.sql`GROUP BY ${column("offer_codes", "id")}`,
        order: Prisma.sql`SUM(${column("purchases", "price_cents")}) ${direction}, `,
      };
    case "uses":
      return {
        joins: Prisma.sql`LEFT OUTER JOIN ${table("purchases")} ON ${column("purchases", "offer_code_id")} = ${column("offer_codes", "id")} AND ${countsTowardsUses()} LEFT OUTER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")}`,
        group: Prisma.sql`GROUP BY ${column("offer_codes", "id")}`,
        order: Prisma.sql`${USES_SORT_SQL} ${direction}, `,
      };
    case "term":
      return {
        ...none,
        order: Prisma.sql`${column("offer_codes", "valid_at")} ${direction}, ${column("offer_codes", "expires_at")} ${direction}, `,
      };
    default:
      return none;
  }
}

// ---------------------------------------------------------------------------------------------
// HABTM preloads: the join rows first, then the targets, in the join rows' order as ActiveRecord's preloader leaves them.

async function preloadHabtm<T extends { id: bigint | number }>(
  joinTable: string,
  foreignKey: string,
  codeIds: number[],
  load: (ids: (bigint | number)[]) => Promise<T[]>,
): Promise<Map<number, T[]>> {
  const out = new Map<number, T[]>(codeIds.map((id) => [id, []]));
  if (codeIds.length === 0) return out;
  const joins = await selectRows<{ offer_code_id: bigint | number; target_id: bigint | number }>(
    Prisma.sql`SELECT ${column(joinTable, "offer_code_id")}, ${column(joinTable, foreignKey)} AS target_id FROM ${table(joinTable)} WHERE ${columnIn(joinTable, "offer_code_id", codeIds)}`,
  );
  const targets = await load([...new Set(joins.map((join) => join.target_id))]);
  const byId = new Map(targets.map((target) => [String(target.id), target]));
  for (const join of joins) {
    const target = byId.get(String(join.target_id));
    if (target !== undefined) out.get(Number(join.offer_code_id))!.push(target);
  }
  return out;
}

const loadLinks = async (ids: (bigint | number)[]): Promise<LinkRow[]> =>
  ids.length === 0
    ? []
    : selectRows<LinkRow>(
        Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", ids)}`,
      );
const loadVariants = async (ids: (bigint | number)[]): Promise<BaseVariant[]> =>
  ids.length === 0
    ? []
    : (
        await selectRows(
          Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${columnIn("base_variants", "id", ids)}`,
        )
      ).map((row) => castRow<BaseVariant>("BaseVariant", row));

type LoadedCode = {
  record: OfferCodeRecord;
  products: LinkRow[];
  ownershipProducts: LinkRow[];
  excludedProducts: LinkRow[];
  variants: BaseVariant[];
  ownerOf: Map<string, bigint | number | null>;
};

async function loadCodes(rows: OfferCode[]): Promise<LoadedCode[]> {
  const ids = rows.map((row) => row.id);
  const products = await preloadHabtm("offer_codes_products", "product_id", ids, loadLinks);
  const ownership = await preloadHabtm("offer_codes_ownership_products", "product_id", ids, loadLinks);
  const excluded = await preloadHabtm("offer_codes_excluded_products", "product_id", ids, loadLinks);
  const variants = await preloadHabtm("offer_codes_variants", "variant_id", ids, loadVariants);
  // Only a Variant has a category (a Sku reads its own link_id).
  const categoryIds = [
    ...new Set(
      [...variants.values()]
        .flat()
        .filter((variant) => variant.type === "Variant" && variant.variant_category_id !== null)
        .map((variant) => variant.variant_category_id!),
    ),
  ];
  const categories = new Map<string, bigint | number | null>();
  if (categoryIds.length > 0)
    for (const row of await selectRows<{ id: bigint | number; link_id: bigint | number | null }>(
      Prisma.sql`SELECT ${column("variant_categories", "id")}, ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${columnIn("variant_categories", "id", categoryIds)}`,
    ))
      categories.set(String(row.id), row.link_id);
  return rows.map((row) => {
    const own = variants.get(row.id)!;
    // BaseVariant#owning_product_id
    const ownerOf = new Map(
      own.map(
        (variant) =>
          [
            String(variant.id),
            variant.type === "Variant"
              ? (categories.get(String(variant.variant_category_id)) ?? null)
              : variant.link_id,
          ] as const,
      ),
    );
    return {
      record: new OfferCodeRecord(row),
      products: products.get(row.id)!,
      ownershipProducts: ownership.get(row.id)!,
      excludedProducts: excluded.get(row.id)!,
      variants: own,
      ownerOf,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Checkout::DiscountsController#fetch_offer_codes

export async function fetchOfferCodes(
  seller: User,
  params: ListingParams,
): Promise<{ pagination: Pagination; codes: LoadedCode[] }> {
  const filter = Prisma.sql`${column("offer_codes", "user_id")} = ${seller.id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "code")} IS NOT NULL${
    params.query === null
      ? Prisma.empty
      : Prisma.sql` AND (name LIKE ${`%${params.query}%`} OR code LIKE ${`%${params.query}%`})`
  }`;
  const [counted] = await selectRows<{ total: bigint | number }>(
    Prisma.sql`SELECT COUNT(*) AS total FROM ${table("offer_codes")} WHERE ${filter}`,
  );
  const total = Number(counted!.total);

  // Pagy's last page is 1 for an empty list; an out-of-range page maps to the closest valid one.
  const last = Math.max(Math.ceil(total / PER_PAGE), 1);
  const page = params.page <= 0 ? 1 : Math.min(params.page, last);
  const { joins, group, order } = sortClauses(params.sort);
  const rows = await selectRows(
    Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} ${joins} WHERE ${filter} ${group} ORDER BY ${order}${column("offer_codes", "updated_at")} DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
  );
  return {
    pagination: { pages: last, page },
    codes: await loadCodes(rows.map((row) => castRow<OfferCode>("OfferCode", row))),
  };
}

// ---------------------------------------------------------------------------------------------
// Checkout::DiscountsPresenter

const flag = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(row.flags as bigint, name);

function productProps(row: LinkRow, seller: User) {
  return {
    id: encrypt(row.id),
    name: row.name,
    archived: flag(row, "archived"),
    url: longUrl(row, seller as unknown as UserRow),
    currency_type: row.price_currency_type,
    is_tiered_membership: flag(row, "is_tiered_membership"),
    is_recurring_billing: flag(row, "is_recurring_billing"),
  };
}

export function offerCodeProps(loaded: LoadedCode, seller: User, sellerContext: SellerContext) {
  const { row } = loaded.record;
  // OfferCode#normalized_ownership_duration_tiers
  const tiers = loaded.record.tiered() ? normalizeTiers(loaded.record.tiers) : null;
  // OfferCode#option_ids_by_product
  const optionIds = new Map<string, string[]>();
  for (const variant of loaded.variants) {
    const owner = loaded.ownerOf.get(String(variant.id)) ?? null;
    if (owner === null) throw new NotPortedError("an option with no owning product", "offer_code.rb:348");
    const key = encrypt(owner);
    optionIds.set(key, [...(optionIds.get(key) ?? []), encrypt(variant.id)]);
  }
  const cents = row.amount_cents !== null;
  return {
    id: encrypt(row.id),
    can_update: checkoutOfferCodePolicy.update(sellerContext, { user_id: row.user_id }),
    name: row.name === null || row.name.trim() === "" ? "" : row.name,
    code: row.code,
    discount: cents ? { type: "cents", value: row.amount_cents } : { type: "percent", value: row.amount_percentage },
    products: row.universal ? null : loaded.products.map((product) => productProps(product, seller)),
    excluded_products: row.universal ? loaded.excludedProducts.map((product) => productProps(product, seller)) : [],
    limit: row.max_purchase_count,
    currency_type: row.currency_type ?? DEFAULT_CURRENCY,
    valid_at: timeAsJson(row.valid_at),
    expires_at: timeAsJson(row.expires_at),
    minimum_quantity: row.minimum_quantity,
    duration_in_billing_cycles: row.duration_in_months,
    minimum_amount_cents: row.minimum_amount_cents,
    once_per_cart: cents && OfferCodeFlags.isSet(row.flags, "once_per_cart"),
    existing_customers_only: row.existing_customers_only,
    new_customers_only: row.new_customers_only,
    auto_apply: row.auto_apply,
    sale_label: row.sale_label,
    ownership_products: loaded.ownershipProducts.map((product) => productProps(product, seller)),
    ownership_duration_tiers: tiers,
    option_ids_by_product: Object.fromEntries(optionIds),
  };
}

type OptionRow = {
  id: bigint | number;
  name: string | null;
  variant_category_id: bigint | number | null;
  position_in_category: number | null;
  created_at: Date;
};

// Checkout::DiscountsPresenter#product_props_by_product
export async function productPropsByProduct(seller: User) {
  const products = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL ORDER BY ${column("links", "id")}`,
  );
  if (products.length === 0) return [];
  const ids = products.map((product) => product.id);
  const categories = await selectRows<{ id: bigint | number; link_id: bigint | number }>(
    Prisma.sql`SELECT ${column("variant_categories", "id")}, ${column("variant_categories", "link_id")} FROM ${table("variant_categories")} WHERE ${columnIn("variant_categories", "link_id", ids)} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")}`,
  );
  const variants =
    categories.length === 0
      ? []
      : await selectRows<OptionRow>(
          Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${columnIn(
            "base_variants",
            "variant_category_id",
            categories.map((category) => category.id),
          )} AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "id")}`,
        );
  const skus = await selectRows<OptionRow & { link_id: bigint | number }>(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${columnIn("base_variants", "link_id", ids)} AND ${column("base_variants", "type")} = 'Sku' AND ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "flags")} & 1) = 0 ORDER BY ${column("base_variants", "id")}`,
  );

  return products.map((product) => {
    const props: ReturnType<typeof productProps> & { options?: { id: string; name: string }[] } = productProps(
      product,
      seller,
    );
    let options: OptionRow[];
    if (flag(product, "skus_enabled")) {
      options = skus.filter((sku) => String(sku.link_id) === String(product.id));
    } else {
      const firstCategory = categories.find((category) => String(category.link_id) === String(product.id));
      options = variants
        .filter(
          (variant) => firstCategory !== undefined && String(variant.variant_category_id) === String(firstCategory.id),
        )
        .sort(
          (a, b) =>
            (a.position_in_category === null ? 0 : 1) - (b.position_in_category === null ? 0 : 1) ||
            (a.position_in_category ?? 0) - (b.position_in_category ?? 0) ||
            a.created_at.getTime() - b.created_at.getTime(),
        );
    }
    if (options.length > 0)
      props.options = options.map((option) => ({
        id: encrypt(option.id),
        name: option.name === UNTITLED ? product.name! : (option.name ?? ""),
      }));
    return props;
  });
}

export async function discountsProps(
  seller: User,
  sellerContext: SellerContext,
  listing: Awaited<ReturnType<typeof fetchOfferCodes>>,
) {
  return {
    pages: DASHBOARD_PAGES,
    pagination: listing.pagination,
    offer_codes: listing.codes.map((code) => offerCodeProps(code, seller, sellerContext)),
    products: await productPropsByProduct(seller),
    show_black_friday_banner: await isFeatureEnabled("black_friday_seller_banner"),
    black_friday_code: BLACK_FRIDAY_CODE,
    black_friday_code_name: BLACK_FRIDAY_CODE_NAME,
  };
}

// ---------------------------------------------------------------------------------------------
// Checkout::DiscountsController#statistics

type LinkTotal = { link_id: bigint | number; total: unknown };

export async function offerCodeStatistics(offerCodeId: number) {
  const statistics = statisticsCondition();
  const uses = Prisma.sql`${column("purchases", "offer_code_id")} = ${offerCodeId} AND ${statistics} AND ${purchaseFlag("is_commission_completion_purchase", false)}`;
  const perItem = await selectRows<LinkTotal>(
    Prisma.sql`SELECT ${column("purchases", "link_id")}, SUM(${column("purchases", "quantity")}) AS total FROM ${table("purchases")} LEFT OUTER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")} WHERE ${uses} AND (${poc("once_per_cart")} = FALSE OR ${poc("once_per_cart")} IS NULL) GROUP BY ${column("purchases", "link_id")}`,
  );
  const legacyPerCart = await selectRows<LinkTotal>(
    Prisma.sql`SELECT ${column("purchases", "link_id")}, COUNT(*) AS total FROM ${table("purchases")} INNER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")} WHERE ${uses} AND ${poc("once_per_cart")} = TRUE AND ${poc("once_per_cart_allocation_id")} IS NULL GROUP BY ${column("purchases", "link_id")}`,
  );
  const allocated = await selectRows<LinkTotal>(
    Prisma.sql`SELECT ${column("purchases", "link_id")}, COUNT(*) AS total FROM ${table("purchases")} WHERE ${uses} AND ${column("purchases", "id")} IN (SELECT MIN(${column("purchases", "id")}) FROM ${table("purchases")} INNER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")} WHERE ${uses} AND ${poc("once_per_cart")} = TRUE AND ${poc("once_per_cart_allocation_id")} IS NOT NULL GROUP BY ${poc("once_per_cart_allocation_id")}) GROUP BY ${column("purchases", "link_id")}`,
  );
  // Hash#merge keeps the first hash's key order and appends the new keys.
  const usesByProduct = new Map<string, number>();
  for (const rows of [perItem, legacyPerCart, allocated])
    for (const row of rows)
      usesByProduct.set(
        encrypt(row.link_id),
        (usesByProduct.get(encrypt(row.link_id)) ?? 0) + Number(String(row.total)),
      );
  const [revenue] = await selectRows<{ total: unknown }>(
    Prisma.sql`SELECT SUM(${column("purchases", "price_cents")}) AS total FROM ${table("purchases")} WHERE ${column("purchases", "offer_code_id")} = ${offerCodeId} AND ${statistics}`,
  );
  return {
    uses: {
      total: [...usesByProduct.values()].reduce((sum, value) => sum + value, 0),
      products: Object.fromEntries(usesByProduct),
    },
    revenue_cents: revenue?.total == null ? 0 : Number(String(revenue.total)),
  };
}

export { SORT_KEYS };
export type { Link };
