// The reads ProductPresenter shares between its card and the product page: plain SQL over the rows
// Rails' associations load, with the same ordering and `alive` scopes.
import { Prisma } from "@prisma/client";

import { classifyHost } from "../../lib/navigation/proxy/hosts.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";

export type Row = Record<string, unknown>;

export type LinkRow = {
  id: bigint;
  user_id: bigint | null;
  name: string | null;
  unique_permalink: string | null;
  custom_permalink: string | null;
  description: string | null;
  purchase_type: number | null;
  price_currency_type: string | null;
  customizable_price: boolean | null;
  max_purchase_count: number | null;
  suggested_price_cents: number | null;
  rental_price_cents: number | null;
  native_type: string | null;
  subscription_duration: number | null;
  duration_in_months: number | null;
  flags: bigint | number | null;
  draft: boolean | null;
  deleted_at: Date | null;
  banned_at: Date | null;
  purchase_disabled_at: Date | null;
  default_offer_code_id: bigint | null;
  sales_count_for_inventory_cache: number | null;
  json_data: unknown;
  updated_at: Date | null;
  free_trial_duration_amount: number | null;
  free_trial_duration_unit: number | null;
  [column: string]: unknown;
};

export type UserRow = {
  id: bigint;
  external_id: string | null;
  name: string | null;
  username: string | null;
  email: string | null;
  unconfirmed_email: string | null;
  verified: boolean | null;
  flags: bigint | number | null;
  deleted_at: Date | null;
  [column: string]: unknown;
};

export type PriceRow = { id: bigint; price_cents: number | null; recurrence: string | null; currency: string | null; flags: bigint | number | null };

export type BaseVariantRow = {
  id: bigint;
  variant_category_id: bigint | null;
  link_id: bigint | null;
  type: string | null;
  name: string | null;
  description: string | null;
  price_difference_cents: number | null;
  max_purchase_count: number | null;
  sales_count_for_inventory_cache: number | null;
  duration_in_minutes: number | null;
  customizable_price: boolean | null;
  flags: bigint | number | null;
  position_in_category: number | null;
  created_at: Date | null;
  deleted_at: Date | null;
  [column: string]: unknown;
};

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

export const bit = (flags: bigint | number | null | undefined, position: number): boolean => ((BigInt(flags ?? 0) >> BigInt(position - 1)) & 1n) === 1n;

export async function findLink(id: bigint | number): Promise<LinkRow | null> {
  const [row] = await selectRows<LinkRow>(Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "id")} = ${id} LIMIT 1`);
  return row ?? null;
}

export async function findUserById(id: bigint | number): Promise<UserRow | null> {
  const [row] = await selectRows<UserRow>(Prisma.sql`SELECT ${star("users")} FROM ${table("users")} WHERE ${column("users", "id")} = ${id} LIMIT 1`);
  return row ?? null;
}

// `alive_prices`: the product's undeleted prices, in primary key order.
export function alivePrices(productId: bigint): Promise<PriceRow[]> {
  return selectRows<PriceRow>(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${productId} AND ${column("prices", "deleted_at")} IS NULL ORDER BY ${column("prices", "id")} ASC`,
  );
}

// `variant_categories_alive`
export function aliveVariantCategoryIds(productId: bigint): Promise<{ id: bigint }[]> {
  return selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC`,
  );
}

// `Link#current_base_variants`: BaseVariant.alive for the product itself (SKUs) and for its alive categories.
export async function currentBaseVariants(productId: bigint): Promise<BaseVariantRow[]> {
  const categoryIds = (await aliveVariantCategoryIds(productId)).map((category) => category.id);
  const inCategories = categoryIds.length === 0 ? Prisma.sql`NULL` : Prisma.join(categoryIds);
  return selectRows<BaseVariantRow>(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "link_id")} = ${productId} OR ${column("base_variants", "variant_category_id")} IN (${inCategories})) ORDER BY ${column("base_variants", "id")} ASC`,
  );
}

export type ReviewStatRow = { reviews_count: number | null; average_rating: number | null; [rating: string]: unknown };

// `product_review_stat || ProductReviewStat::TEMPLATE`: the template is an unsaved record, so its counts are nil
// (average_rating and reviews_count have column defaults of 0.0 and 0).
export async function reviewStat(productId: bigint): Promise<ReviewStatRow | null> {
  const [row] = await selectRows<ReviewStatRow>(
    Prisma.sql`SELECT ${star("product_review_stats")} FROM ${table("product_review_stats")} WHERE ${column("product_review_stats", "link_id")} = ${productId} LIMIT 1`,
  );
  return row ?? null;
}

// `Subdomain.find_seller_by_hostname` and `user_by_custom_domain`, as `user_by_domain(host)`.
export async function userByDomain(hostname: string): Promise<UserRow | null> {
  const host = classifyHost(hostname, domainConfig(process.env));
  const alive = Prisma.sql`${column("users", "deleted_at")} IS NULL`;
  if (host.sellerSubdomain) {
    const where =
      "externalId" in host.sellerSubdomain
        ? Prisma.sql`${column("users", "external_id")} = ${host.sellerSubdomain.externalId}`
        : host.sellerSubdomain.username === ""
          ? null
          : Prisma.sql`${column("users", "username")} = ${host.sellerSubdomain.username}`;
    if (where) {
      const [row] = await selectRows<UserRow>(Prisma.sql`SELECT ${star("users")} FROM ${table("users")} WHERE ${alive} AND ${where} LIMIT 1`);
      if (row) return row;
    }
  }
  const custom = await customDomainByHost(hostname);
  if (custom?.user_id != null) return findUserById(custom.user_id);
  return null;
}

export type CustomDomainRow = { id: bigint; user_id: bigint | null; product_id: bigint | null; domain: string };

// `CustomDomain.find_by_host`
export async function customDomainByHost(hostname: string): Promise<CustomDomainRow | null> {
  const candidates = classifyHost(hostname, domainConfig(process.env)).customDomainLookup;
  for (const domain of candidates ?? []) {
    const [row] = await selectRows<CustomDomainRow>(
      Prisma.sql`SELECT ${star("custom_domains")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "deleted_at")} IS NULL AND ${column("custom_domains", "domain")} = ${domain} LIMIT 1`,
    );
    if (row) return row;
  }
  return null;
}
