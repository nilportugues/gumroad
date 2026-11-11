// Product::AsJson#as_json_for_api, for the products Node can serialize exactly. Whatever it cannot (Elasticsearch counts, signed S3 file
// URLs, Active Storage covers and thumbnails, taxonomy categories, purchasing power parity, preorders, bundles, tiered memberships and a
// product-level refund policy) goes to Rails whole, before the request writes anything.
import type { Link, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { defaultPriceCents, LinkFlags, Links } from "../../models/link.ts";
import { UserFlags } from "../../models/user.ts";
import {
  assertPriceSupported,
  assertThumbnailsSupported,
  loadRowData,
  priceFormattedVerbose,
  thumbnailJson,
} from "../../page-props/seller-products/listing.ts";
import { findLink, findUserById } from "../../presenters/product-reads.ts";
import { longUrl } from "../../presenters/product.ts";
import { HandBackToRails } from "../application-controller.ts";

import { variantRichContentJson } from "./product-resources.ts";
import { externalId, timeJson } from "./records.ts";

const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"] as const;
const IS_POST_PURCHASE_FLAG = 1n;
const COLLECT_PER_PRODUCT_FLAG = 2n;
const HIDE_HEADER_FLAG = 2n;
const SALES_SCOPES = ["view_sales", "account"];

// Api::ProductSectionsPresenter::SECTION_TYPES
const SECTION_TYPES: Record<string, string> = {
  SellerProfileProductsSection: "products",
  SellerProfileFeaturedProductSection: "featured_product",
  SellerProfileRichTextSection: "rich_text",
  SellerProfilePostsSection: "posts",
  SellerProfileWishlistsSection: "wishlists",
  SellerProfileSubscribeSection: "subscribe",
};

export type ProductJsonOptions = { owner: User; scopes: string[]; slim: boolean };

const flag = (link: Link, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(link.flags, name);
const jsonObject = (text: string | null): Record<string, unknown> => {
  if (text === null || text === "") return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

// The shapes of a product that need what Node does not have; thrown before any write of the request.
export async function assertProductJsonSupported(links: Link[], { owner, scopes }: ProductJsonOptions): Promise<void> {
  if (scopes.some((scope) => SALES_SCOPES.includes(scope)))
    throw new HandBackToRails("sales_count and sales_usd_cents come from Elasticsearch");
  const ids = links.map((link) => link.id);
  for (const link of links) {
    if (link.taxonomy_id !== null) throw new HandBackToRails("a product with a taxonomy category");
    if (flag(link, "is_tiered_membership")) throw new HandBackToRails("a tiered membership");
    if (flag(link, "is_bundle")) throw new HandBackToRails("a bundle");
    if (
      flag(link, "product_refund_policy_enabled") &&
      (await db.refundPolicy.findFirst({ where: { product_id: link.id } }))
    )
      throw new HandBackToRails("a product-level refund policy");
    if (
      UserFlags.isSet(owner.flags, "purchasing_power_parity_enabled") &&
      !flag(link, "purchasing_power_parity_disabled")
    )
      throw new HandBackToRails("purchasing power parity prices");
  }
  if (ids.length === 0) return;
  if ((await db.assetPreview.count({ where: { link_id: { in: ids }, deleted_at: null } })) > 0)
    throw new HandBackToRails("a product with covers");
  if ((await db.productFile.count({ where: { link_id: { in: ids }, deleted_at: null } })) > 0)
    throw new HandBackToRails("a product with files");
  if ((await db.preorderLink.count({ where: { link_id: { in: ids } } })) > 0) throw new HandBackToRails("a preorder");
}

// Link#checkout_custom_fields as custom_field_descriptors: the seller's global fields, then the product's own.
async function customFieldDescriptors(link: Link, owner: User) {
  const globals = await db.customField.findMany({
    where: { seller_id: owner.id, global: true },
    orderBy: { id: "asc" },
  });
  const joins = await db.customFieldsProduct.findMany({ where: { product_id: link.id }, orderBy: { id: "asc" } });
  const own =
    joins.length === 0
      ? []
      : await db.customField.findMany({ where: { id: { in: joins.map((join) => join.custom_field_id) } } });
  const byId = new Map(own.map((field) => [field.id, field]));
  const fields = [
    ...globals,
    ...joins.flatMap((join) => (byId.has(join.custom_field_id) ? [byId.get(join.custom_field_id)!] : [])),
  ];
  return fields
    .filter((field) => (BigInt(field.flags) & IS_POST_PURCHASE_FLAG) === 0n)
    .map((field) => ({
      id: externalId(field.id),
      type: field.field_type,
      name: field.name,
      required: field.required,
      collect_per_product: (BigInt(field.flags) & COLLECT_PER_PRODUCT_FLAG) === COLLECT_PER_PRODUCT_FLAG,
    }));
}

async function tagNames(link: Link): Promise<(string | null)[]> {
  const taggings = await db.productTagging.findMany({
    where: { product_id: Number(link.id) },
    orderBy: [{ tag_id: "asc" }, { id: "asc" }],
  });
  if (taggings.length === 0) return [];
  const tags = await db.tag.findMany({ where: { id: { in: taggings.map((tagging) => tagging.tag_id!) } } });
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  return taggings.flatMap((tagging) => (byId.has(tagging.tag_id!) ? [byId.get(tagging.tag_id!)!.name] : []));
}

async function variantCategories(link: Link, slim: boolean) {
  const categories = await db.variantCategory.findMany({
    where: { link_id: Number(link.id), deleted_at: null },
    orderBy: { id: "asc" },
  });
  const variants =
    categories.length === 0
      ? []
      : await db.baseVariant.findMany({
          where: {
            type: "Variant",
            variant_category_id: { in: categories.map((category) => category.id) },
            deleted_at: null,
          },
          orderBy: { id: "asc" },
        });
  return Promise.all(
    categories.map(async (category) => ({
      title: category.title,
      options: await Promise.all(
        variants
          .filter((variant) => variant.variant_category_id === category.id)
          .map(async (variant) => ({
            name: variant.name,
            price_difference: variant.price_difference_cents,
            is_pay_what_you_want: variant.customizable_price === true,
            recurrence_prices: null,
            url: null,
            ...(slim ? {} : { rich_content: await variantRichContentJson(link, variant) }),
          })),
      ),
    })),
  );
}

async function richContentJson(link: Link) {
  const pages = await db.richContent.findMany({
    where: { entity_type: "Link", entity_id: link.id, deleted_at: null },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return pages.map((page) => ({
    id: externalId(page.id),
    page_id: externalId(page.id),
    title: page.title,
    variant_id: null,
    description: { type: "doc", content: page.description },
    updated_at: timeJson(page.updated_at),
  }));
}

// Api::ProductSectionsPresenter#props
export async function productSectionsJson(link: Link) {
  const rows = await db.sellerProfileSection.findMany({ where: { product_id: link.id }, orderBy: { id: "asc" } });
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const stored = jsonObject(link.json_data).sections;
  const ids = Array.isArray(stored) ? stored : [];
  const sections = ids.flatMap((id) => byId.get(Number(id)) ?? []);
  const data = (row: (typeof rows)[number]) =>
    jsonObject(row.json_data === null ? null : JSON.stringify(row.json_data));
  const productIds = sections.flatMap((section) => {
    const hash = data(section);
    if (section.type === "SellerProfileProductsSection") {
      if (!Array.isArray(hash.shown_products))
        throw new HandBackToRails("a products section without a shown_products list");
      return hash.shown_products as number[];
    }
    return section.type === "SellerProfileFeaturedProductSection" && hash.featured_product_id != null
      ? [hash.featured_product_id as number]
      : [];
  });
  const products =
    productIds.length === 0
      ? []
      : await db.link.findMany({
          where: { user_id: link.user_id!, id: { in: [...new Set(productIds)].map(BigInt) } },
          select: { id: true },
        });
  const externalIds = new Map(products.map((product) => [Number(product.id), externalId(product.id)]));
  return sections.map((section) => {
    const type = SECTION_TYPES[section.type];
    if (type === undefined) throw new HandBackToRails("a section type the API presenter names by inflection");
    const hash = data(section);
    const payload: Record<string, unknown> = {
      id: externalId(section.id),
      type,
      header: section.header ?? "",
      hide_header: (BigInt(section.flags) & HIDE_HEADER_FLAG) === HIDE_HEADER_FLAG,
    };
    if (section.type === "SellerProfileProductsSection") {
      payload.shown_products = (hash.shown_products as number[]).flatMap((id) => externalIds.get(Number(id)) ?? []);
      payload.default_product_sort = hash.default_product_sort ?? null;
      payload.show_filters = hash.show_filters ?? null;
      payload.add_new_products = hash.add_new_products ?? null;
    } else if (section.type === "SellerProfileFeaturedProductSection") {
      const featured = hash.featured_product_id == null ? undefined : externalIds.get(Number(hash.featured_product_id));
      if (featured) payload.featured_product = featured;
    }
    return payload;
  });
}

export async function productsApiJson(links: Link[], options: ProductJsonOptions): Promise<Record<string, unknown>[]> {
  await assertProductJsonSupported(links, options);
  const { owner, slim } = options;
  const data = await loadRowData(links);
  await assertThumbnailsSupported(data);
  const seller = await findUserById(owner.id);
  const result: Record<string, unknown>[] = [];
  for (const link of links) {
    assertPriceSupported(link, data);
    const row = await findLink(link.id);
    const record = Links.load(link);
    const jsonData = jsonObject(link.json_data);
    const json: Record<string, unknown> = {
      name: link.name,
      description: link.description,
      require_shipping: link.require_shipping,
      preview_url: link.preview_url,
      custom_receipt: link.custom_receipt,
      customizable_price: link.customizable_price,
      custom_permalink: link.custom_permalink,
      subscription_duration: SUBSCRIPTION_DURATIONS[link.subscription_duration ?? -1] ?? null,
      id: externalId(link.id),
      url: null,
      price: await defaultPriceCents(record),
      currency: link.price_currency_type,
      taxonomy_id: null,
      category: null,
      category_label: null,
      short_url: longUrl(row!, seller!),
      landing_url: longUrl(row!, seller!),
      thumbnail_url: thumbnailJson(link, data)?.url || null,
      tags: await tagNames(link),
      formatted_price: priceFormattedVerbose(link, data),
      published: link.purchase_disabled_at === null && link.banned_at === null && link.deleted_at === null,
      file_info: {},
      max_purchase_count: link.max_purchase_count,
      deleted: link.deleted_at !== null,
      custom_fields: await customFieldDescriptors(link, owner),
      custom_summary: jsonData.custom_summary ?? null,
      is_tiered_membership: false,
      recurrences: null,
      covers: [],
      main_cover_id: null,
      bundle_products: [],
      variants: await variantCategories(link, slim),
    };
    if (!slim) {
      const page = await db.page.findFirst({
        where: { pageable_type: "Link", pageable_id: link.id, slug: null },
        orderBy: { id: "asc" },
      });
      Object.assign(json, {
        custom_html: page?.custom_html ?? null,
        refund_policy: { refund_period: "inherit", title: null, fine_print: null, inherited: true },
        rich_content: await richContentJson(link),
        has_same_rich_content_for_all_variants: flag(link, "has_same_rich_content_for_all_variants"),
        main_section_index: (jsonData.main_section_index as number | undefined) || 0,
        sections: await productSectionsJson(link),
        files: [],
      });
    }
    result.push(json);
  }
  return result;
}
