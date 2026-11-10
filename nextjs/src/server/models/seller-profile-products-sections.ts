// What Link#delete! writes to a seller's profile sections: Link#clear_featured_product_sections! and Link#remove_from_profile_sections!
// (app/models/link.rb), over SellerProfileFeaturedProductSection and SellerProfileProductsSection.
import { Prisma, type SellerProfileSection } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { Row } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const PRODUCTS_SECTION = "SellerProfileProductsSection";
const FEATURED_PRODUCT_SECTION = "SellerProfileFeaturedProductSection";
const PRODUCT_SORTS = ["page_layout", "newest", "highest_rated", "most_reviewed", "price_asc", "price_desc"];
const PRODUCTS_SECTION_KEYS = 4;

type Hash = Prisma.JsonObject;

const hashOf = (value: unknown): Hash => {
  const hash = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return hash !== null && typeof hash === "object" && !Array.isArray(hash) ? (hash as Hash) : {};
};
const isInteger = (value: unknown) => typeof value === "bigint" || Number.isInteger(value);

// lib/json_schemas/seller_profile_products_section.json: all four keys and no others.
export function productsSectionValid(hash: Hash): boolean {
  const shown = hash.shown_products;
  return (
    Object.keys(hash).length === PRODUCTS_SECTION_KEYS &&
    PRODUCT_SORTS.includes(hash.default_product_sort as string) &&
    Array.isArray(shown) &&
    shown.every(isInteger) &&
    new Set(shown.map(Number)).size === shown.length &&
    typeof hash.show_filters === "boolean" &&
    typeof hash.add_new_products === "boolean"
  );
}

// lib/json_schemas/seller_profile_featured_product_section.json: an optional integer `featured_product_id` and no other keys.
export function featuredSectionValid(hash: Hash): boolean {
  return Object.keys(hash).every((key) => key === "featured_product_id") && (!("featured_product_id" in hash) || isInteger(hash.featured_product_id));
}

function sectionModel(rubyClass: string, valid: (hash: Hash) => boolean) {
  return defineModel<SellerProfileSection>({
    rubyClass,
    prismaModel: "SellerProfileSection",
    delegate: (tx) => tx.sellerProfileSection as never,
    validations: [
      belongsToRequired<SellerProfileSection>(SELLER),
      {
        name: "validate_json_data",
        run(record) {
          // JSON::Validator's messages are not reproduced.
          if (!valid(hashOf(record.get("json_data")))) throw new NotPortedError(`a ${rubyClass} whose json_data breaks its schema`, "app/models/seller_profile_section.rb");
        },
      },
    ],
  });
}

const ProductsSections = sectionModel(PRODUCTS_SECTION, productsSectionValid);
const FeaturedProductSections = sectionModel(FEATURED_PRODUCT_SECTION, featuredSectionValid);

const sections = "seller_profile_sections";
const sectionRows = (sellerId: unknown, type: string, extra: Prisma.Sql = Prisma.empty) =>
  selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`seller_profile_sections`.*")} FROM ${table(sections)} WHERE ${column(sections, "type")} = ${type} AND ${column(sections, "seller_id")} = ${sellerId}${extra} ORDER BY ${column(sections, "id")}`,
  );

const featuredSectionsOf = (sellerId: unknown, productId: unknown) =>
  sectionRows(sellerId, FEATURED_PRODUCT_SECTION, Prisma.sql` AND CAST(JSON_EXTRACT(${column(sections, "json_data")}, "$.featured_product_id") AS UNSIGNED) = ${productId}`);

// `section.shown_products`, which `include?` and `-` read.
function shownProductsOf(row: Row): number[] {
  const shown = hashOf(row.json_data).shown_products;
  if (!Array.isArray(shown)) throw new NotPortedError("a products section without a shown_products list", "app/models/link.rb");
  return shown.map(Number);
}

const withoutFeaturedProduct = (value: unknown): Hash => {
  const { featured_product_id: _removed, ...rest } = hashOf(value);
  return rest;
};

// `save!(validate: true)` raises on a section whose edited json_data breaks its schema: refuse before the deletion's first write
// rather than half way through it.
export async function assertProfileSectionsEditable(sellerId: unknown, productId: unknown): Promise<void> {
  for (const row of await featuredSectionsOf(sellerId, productId)) {
    if (!featuredSectionValid(withoutFeaturedProduct(row.json_data))) throw new NotPortedError(`a ${FEATURED_PRODUCT_SECTION} whose json_data breaks its schema`, "app/models/seller_profile_section.rb");
  }
  for (const row of await sectionRows(sellerId, PRODUCTS_SECTION)) {
    const shown = shownProductsOf(row);
    if (!shown.includes(Number(productId))) continue;
    if (!productsSectionValid({ ...hashOf(row.json_data), shown_products: shown.filter((id) => id !== Number(productId)) })) {
      throw new NotPortedError(`a ${PRODUCTS_SECTION} whose json_data breaks its schema`, "app/models/seller_profile_section.rb");
    }
  }
}

// Link#clear_featured_product_sections!: drop `featured_product_id` from each featured-product section naming the product.
export async function clearFeaturedProductSections(sellerId: unknown, productId: unknown, now?: () => Date): Promise<void> {
  for (const row of await featuredSectionsOf(sellerId, productId)) {
    const section = FeaturedProductSections.load(castRow<SellerProfileSection>("SellerProfileSection", row));
    section.set("json_data", withoutFeaturedProduct(section.get("json_data")));
    await FeaturedProductSections.saveBang(section, { now });
  }
}

// Link#remove_from_profile_sections!: strip the id from the `shown_products` of every products section of the seller (the per-product
// ones too), under `User#with_profile_sections_lock`.
export async function removeFromProfileSections(sellerId: unknown, productId: unknown, now?: () => Date): Promise<void> {
  const profiles = "seller_profiles";
  const profileLookup = Prisma.sql`SELECT ${Prisma.raw("`seller_profiles`.*")} FROM ${table(profiles)} WHERE ${column(profiles, "seller_id")} = ${sellerId} LIMIT 1`;
  const run = async () => {
    for (const row of await sectionRows(sellerId, PRODUCTS_SECTION)) {
      const shown = shownProductsOf(row);
      if (!shown.includes(Number(productId))) continue;
      const section = ProductsSections.load(castRow<SellerProfileSection>("SellerProfileSection", row));
      section.set("json_data", { ...hashOf(section.get("json_data")), shown_products: shown.filter((id) => id !== Number(productId)) });
      await ProductsSections.saveBang(section, { now });
    }
  };
  const [profile] = await selectRows(profileLookup);
  if (!profile) return run();
  await transaction(async () => {
    await selectRows(Prisma.sql`${profileLookup} FOR UPDATE`);
    await run();
  });
}
