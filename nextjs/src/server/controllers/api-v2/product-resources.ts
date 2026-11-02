// Api::V2::SkusController, VariantCategoriesController, VariantsController, CustomFieldsController and ProductBuildsController: the
// reads. The writes live in product-resource-writes.ts.
import type { BaseVariant, Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, errorWithObject, loadProduct, PUBLIC_READ_SCOPES, registerApiV2, renderResponse, successWithObject } from "./base.ts";
import {
  aliveVariantCategories,
  aliveVariants,
  baseVariantJson,
  customFieldJson,
  externalId,
  IS_DEFAULT_SKU,
  linkFlag,
  productBuildJson,
  timeJson,
  variantCategoryJson,
  variantJson,
} from "./records.ts";
import { fromExternalId } from "./base.ts";

const productOf = (input: ApiV2Input): Link => input.state.product;

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::SkusController

async function skus(link: Link): Promise<BaseVariant[]> {
  if (linkFlag(link, "skus_enabled")) {
    const alive = await db.baseVariant.findMany({ where: { type: "Sku", link_id: Number(link.id), deleted_at: null }, orderBy: { id: "asc" } });
    const real = alive.filter((sku) => (sku.flags & IS_DEFAULT_SKU) === 0);
    return real.length > 0 ? real : alive.filter((sku) => (sku.flags & IS_DEFAULT_SKU) !== 0);
  }
  return linkFlag(link, "is_physical") ? aliveVariants(link) : [];
}

registerApiV2(
  { method: "GET", pattern: "/v2/products/:link_id/skus", scopes: PUBLIC_READ_SCOPES, before: loadProduct("link_id"), run: async (input) => successWithObject("skus", (await skus(productOf(input))).map(baseVariantJson)) },
);

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::CustomFieldsController

// `@product.custom_fields`: the join table's rows, in the order the join stores them.
async function productCustomFields(link: Link) {
  const joins = await db.customFieldsProduct.findMany({ where: { product_id: link.id }, orderBy: { id: "asc" } });
  if (joins.length === 0) return [];
  const fields = await db.customField.findMany({ where: { id: { in: joins.map((join) => join.custom_field_id) } } });
  const byId = new Map(fields.map((field) => [field.id, field]));
  return joins.flatMap((join) => (byId.has(join.custom_field_id) ? [byId.get(join.custom_field_id)!] : []));
}

registerApiV2({
  method: "GET",
  pattern: "/v2/products/:link_id/custom_fields",
  scopes: PUBLIC_READ_SCOPES,
  before: loadProduct("link_id"),
  run: async (input) => successWithObject("custom_fields", await Promise.all((await productCustomFields(productOf(input))).map(customFieldJson))),
});

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::VariantCategoriesController

// fetch_variant_category: any of the product's categories by external id, deleted ones included.
async function findVariantCategory(link: Link, id: string | undefined) {
  const decoded = fromExternalId(id);
  return decoded === null ? null : db.variantCategory.findFirst({ where: { link_id: Number(link.id), id: decoded } });
}

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/products/:link_id/variant_categories",
    scopes: PUBLIC_READ_SCOPES,
    before: loadProduct("link_id"),
    run: async (input) => successWithObject("variant_categories", (await aliveVariantCategories(productOf(input))).map(variantCategoryJson)),
  },
  {
    method: "GET",
    pattern: "/v2/products/:link_id/variant_categories/:id",
    scopes: PUBLIC_READ_SCOPES,
    async before(input) {
      const halted = await loadProduct("link_id")(input);
      if (halted) return halted;
      input.state.variantCategory = await findVariantCategory(productOf(input), input.routeParams.id);
      return input.state.variantCategory ? undefined : errorWithObject("variant_category", null);
    },
    run: async (input) => successWithObject("variant_category", variantCategoryJson(input.state.variantCategory)),
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::VariantsController

async function loadVariantCategory(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  input.state.variantCategory = await findVariantCategory(productOf(input), input.routeParams.variant_category_id);
  return input.state.variantCategory ? undefined : errorWithObject("variant_category", null);
}

// fetch_variant: the category's versions (`variant_category.variants`), deleted ones included.
async function loadVariant(input: ApiV2Input) {
  const halted = await loadVariantCategory(input);
  if (halted) return halted;
  const decoded = fromExternalId(input.routeParams.id);
  input.state.variant = decoded === null ? null : await db.baseVariant.findFirst({ where: { type: "Variant", variant_category_id: input.state.variantCategory.id, id: decoded } });
  return input.state.variant ? undefined : errorWithObject("variant", null);
}

// RichContents#rich_content_json for a version.
export async function variantRichContentJson(link: Link, variant: BaseVariant): Promise<unknown[]> {
  if (linkFlag(link, "has_same_rich_content_for_all_variants") && (await hidesVariantRichContent(link))) return [];
  const pages = await db.richContent.findMany({ where: { entity_type: "BaseVariant", entity_id: variant.id, deleted_at: null }, orderBy: { position: "asc" } });
  return pages.map((page) => ({
    id: externalId(page.id),
    page_id: externalId(page.id),
    title: page.title,
    variant_id: externalId(variant.id),
    description: { type: "doc", content: page.description },
    updated_at: timeJson(page.updated_at),
  }));
}

// `!recoverable_hidden_variant_rich_content?` for a product that shares one set of pages across its versions.
async function hidesVariantRichContent(link: Link): Promise<boolean> {
  if (linkFlag(link, "is_physical")) return true;
  const pages = await db.richContent.findMany({ where: { entity_type: "Link", entity_id: link.id, deleted_at: null } });
  // RichContent#has_editor_content? is a title, or a body that walks the node tree; the walk is not ported.
  const undecided = pages.some((page) => !page.title && Array.isArray(page.description) && page.description.length > 0);
  if (undecided) throw new NotPortedError("variant rich content of a product whose shared pages may be blank");
  if (pages.some((page) => page.title)) return true;
  const variants = await aliveVariants(link);
  if (variants.length === 0) return true;
  const variantPages = await db.richContent.findMany({ where: { entity_type: "BaseVariant", entity_id: { in: variants.map((variant) => variant.id) }, deleted_at: null } });
  if (variantPages.some((page) => !page.title && Array.isArray(page.description) && page.description.length > 0)) throw new NotPortedError("variant rich content of a product whose shared pages may be blank");
  return !variantPages.some((page) => page.title);
}

export async function successWithVariant(link: Link, variant: BaseVariant) {
  const json = await variantJson(variant, link);
  json.rich_content = await variantRichContentJson(link, variant);
  return renderResponse(true, { variant: json });
}

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/products/:link_id/variant_categories/:variant_category_id/variants",
    scopes: PUBLIC_READ_SCOPES,
    before: loadVariantCategory,
    async run(input) {
      const variants = await db.baseVariant.findMany({ where: { type: "Variant", variant_category_id: input.state.variantCategory.id, deleted_at: null }, orderBy: { id: "asc" } });
      return successWithObject("variants", await Promise.all(variants.map((variant) => variantJson(variant, productOf(input)))));
    },
  },
  {
    method: "GET",
    pattern: "/v2/products/:link_id/variant_categories/:variant_category_id/variants/:id",
    scopes: PUBLIC_READ_SCOPES,
    before: loadVariant,
    run: (input) => successWithVariant(productOf(input), input.state.variant),
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::ProductBuildsController

async function loadBuild(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  input.state.build = await db.productBuild.findFirst({ where: { product_id: productOf(input).id, public_id: input.routeParams.id }, orderBy: { id: "asc" } });
  return input.state.build ? undefined : errorWithObject("build", null);
}

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/products/:link_id/builds",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    run: async (input) => renderResponse(true, { builds: (await db.productBuild.findMany({ where: { product_id: productOf(input).id }, orderBy: { number: "asc" } })).map(productBuildJson) }),
  },
  { method: "GET", pattern: "/v2/products/:link_id/builds/:id", scopes: EDIT_PRODUCTS_SCOPES, before: loadBuild, run: async (input) => renderResponse(true, { build: productBuildJson(input.state.build) }) },
);

export { findVariantCategory, loadVariant, loadVariantCategory, productCustomFields };
