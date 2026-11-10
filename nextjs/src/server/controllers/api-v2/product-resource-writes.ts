// Api::V2::CustomFieldsController and VariantCategoriesController: the writes Node serves. Anything it cannot prove (a parameter that is
// not a string) goes to Rails before the first write. DELETE of a variant category stays in Rails: it writes a ProductVariantDeletionAudit row.
import type { CustomField, Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { HTTP_URI_REGEXP as URI_REGEXP } from "../../../lib/ruby-uri-regexp.ts";
import { invalidateProductCache } from "../../models/link.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, errorWithCreatingObject, errorWithObject, loadProduct, registerApiV2, successWithObject } from "./base.ts";
import { findVariantCategory, productCustomFields } from "./product-resources.ts";
import { customFieldJson, variantCategoryJson } from "./records.ts";

const productOf = (input: ApiV2Input): Link => input.state.product;

// CustomField::TYPES
const CUSTOM_FIELD_TYPES = ["text", "checkbox", "terms", "long_text", "file"];
const TYPE_TERMS = "terms";
const TYPE_FILE = "file";
const FILE_FIELD_NAME = "File upload";
const COLLECT_PER_PRODUCT_FLAG = 2n;

// String#blank?: empty or only whitespace (Unicode spaces included).
const blank = (value: string) => /^[\s\u0085᠎]*$/u.test(value);

// A parameter that is a string or absent. Rails would cast another JSON type (a number, a list) in ways the port does not follow.
function stringParam(value: unknown): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") return value;
  throw new NotPortedError("a custom field parameter that is not a string");
}

const presence = (value: string | null | undefined): string | null => (value === undefined || value === null || blank(value) ? null : value);

type CustomFieldDraft = { field_type: string | null; name: string | null; flags: bigint };

// CustomField's validations, in the order the model declares them: belongs_to :seller, field_type inclusion, name presence,
// terms_valid_uri, type_not_boolean_if_post_purchase (is_post_purchase is flag 1).
function customFieldErrors(field: CustomFieldDraft): string[] {
  const errors: string[] = [];
  if (field.field_type === null || !CUSTOM_FIELD_TYPES.includes(field.field_type)) errors.push("Field type is not included in the list");
  if (field.name === null || blank(field.name)) errors.push("Name can't be blank");
  if (field.field_type === TYPE_TERMS && !(field.name !== null && URI_REGEXP.test(field.name))) errors.push("Please provide a valid URL for custom field of Terms type.");
  if ((field.flags & 1n) === 1n && ["checkbox", TYPE_TERMS].includes(field.field_type ?? "")) errors.push("Boolean post-purchase fields are not allowed");
  return errors;
}

// before_validation :set_default_name
const withDefaultName = <T extends CustomFieldDraft>(field: T): T => (field.field_type === TYPE_FILE && (field.name === null || blank(field.name)) ? { ...field, name: FILE_FIELD_NAME } : field);

async function loadCustomField(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  // `@custom_fields.where(name: params[:id]).last`
  const fields = (await productCustomFields(productOf(input))).filter((field) => field.name !== null && field.name.toLowerCase() === input.routeParams.id!.toLowerCase());
  input.state.customField = fields.sort((a, b) => Number(a.id - b.id)).at(-1) ?? null;
  return input.state.customField ? undefined : errorWithObject("custom_field", null);
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products/:link_id/custom_fields",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    async run(input) {
      const { params, owner } = input;
      const name = presence(stringParam(params.name)) ?? presence(stringParam(params.url)) ?? presence(stringParam(params.label));
      if (name === null) return errorWithCreatingObject("custom_field");
      const type = stringParam(params.type);
      const draft = withDefaultName({ field_type: type ?? "text", name, flags: 0n });
      const errors = customFieldErrors(draft);
      if (errors.length > 0) return errorWithCreatingObject("custom_field", { errors });

      const now = new Date();
      const field = await db.$transaction(async (tx) => {
        const created = await tx.customField.create({ data: { field_type: draft.field_type, name: draft.name, required: params.required === "true", seller_id: owner.id, created_at: now, updated_at: now } });
        await tx.customFieldsProduct.create({ data: { custom_field_id: created.id, product_id: productOf(input).id, created_at: now, updated_at: now } });
        return created;
      });
      return successWithObject("custom_field", await customFieldJson(field));
    },
  },
  {
    method: "PATCH",
    pattern: "/v2/products/:link_id/custom_fields/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadCustomField,
    run: updateCustomField,
  },
  { method: "PUT", pattern: "/v2/products/:link_id/custom_fields/:id", scopes: EDIT_PRODUCTS_SCOPES, before: loadCustomField, run: updateCustomField },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/custom_fields/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadCustomField,
    async run(input) {
      const field: CustomField = input.state.customField;
      // `@custom_field.products.count`: the join rows whose product exists.
      const joins = await db.customFieldsProduct.findMany({ where: { custom_field_id: field.id } });
      const live = joins.length === 0 ? [] : await db.link.findMany({ where: { id: { in: joins.map((join) => join.product_id) } }, select: { id: true } });
      if (live.length > 1) await db.customFieldsProduct.deleteMany({ where: { custom_field_id: field.id, product_id: productOf(input).id } });
      else await db.customField.delete({ where: { id: field.id } });
      return successWithObject("custom_field", null);
    },
  },
);

async function updateCustomField(input: ApiV2Input) {
  const field: CustomField = input.state.customField;
  const required = input.params.required;
  // A request that names no `required` changes nothing and succeeds.
  if (required === undefined || required === null) return successWithObject("custom_field", await customFieldJson(field));
  const draft = withDefaultName({ field_type: field.field_type, name: field.name, flags: field.flags });
  const next = { ...field, required: required === "true", name: draft.name };
  // `update` returns false for a field that no longer validates, and the action ignores that: the response shows the in-memory value.
  if (customFieldErrors(draft).length === 0 && (next.required !== field.required || next.name !== field.name)) {
    await db.customField.update({ where: { id: field.id }, data: { required: next.required, name: next.name, updated_at: new Date() } });
  }
  return successWithObject("custom_field", await customFieldJson(next));
}

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::VariantCategoriesController

// `params.permit(:title)`: a scalar title. Rails casts a number to its string; anything else is dropped or unpermitted.
function permittedTitle(params: Record<string, unknown>): { given: boolean; title: string | null } {
  if (!("title" in params)) return { given: false, title: null };
  const title = params.title;
  if (title === null || typeof title === "string") return { given: true, title };
  throw new NotPortedError("a variant category title that is not a string");
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products/:link_id/variant_categories",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    async run(input) {
      const { given, title } = permittedTitle(input.params);
      const link = productOf(input);
      const now = new Date();
      const category = await db.$transaction(async (tx) => {
        const created = await tx.variantCategory.create({ data: { link_id: Number(link.id), ...(given ? { title } : {}) } });
        await tx.link.update({ where: { id: link.id }, data: { updated_at: now } });
        return created;
      });
      await invalidateProductCache(link.id);
      return successWithObject("variant_category", variantCategoryJson(category));
    },
  },
  {
    method: "PATCH",
    pattern: "/v2/products/:link_id/variant_categories/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadVariantCategoryForWrite,
    run: updateVariantCategory,
  },
  { method: "PUT", pattern: "/v2/products/:link_id/variant_categories/:id", scopes: EDIT_PRODUCTS_SCOPES, before: loadVariantCategoryForWrite, run: updateVariantCategory },
);

async function loadVariantCategoryForWrite(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  input.state.variantCategory = await findVariantCategory(productOf(input), input.routeParams.id);
  return input.state.variantCategory ? undefined : errorWithObject("variant_category", null);
}

async function updateVariantCategory(input: ApiV2Input) {
  const category = input.state.variantCategory;
  const { given, title } = permittedTitle(input.params);
  const link = productOf(input);
  const changed = given && title !== category.title;
  if (changed) {
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.variantCategory.update({ where: { id: category.id }, data: { title } });
      await tx.link.update({ where: { id: link.id }, data: { updated_at: now } });
    });
  }
  // after_commit :invalidate_product_cache runs for a save that changed nothing as well.
  await invalidateProductCache(link.id);
  return successWithObject("variant_category", variantCategoryJson({ ...category, title: given ? title : category.title }));
}
