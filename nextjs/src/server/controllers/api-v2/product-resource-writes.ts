// Api::V2::CustomFieldsController and VariantCategoriesController: the writes Node serves. Anything it cannot prove (a parameter that is
// not a string) goes to Rails before the first write.
import type { BaseVariant, CustomField, Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { HTTP_URI_REGEXP as URI_REGEXP } from "../../../lib/ruby-uri-regexp.ts";
import { invalidateProductCache } from "../../models/link.ts";
import {
  recordVariantCategoryDeletion,
  recordVariantDeletion,
  requestIdOf,
} from "../../models/product-variant-deletion-audit.ts";
import {
  assertPlainVariant,
  assertPlainVariantProduct,
  buildVariant,
  loadVariantRecord,
  Variants,
} from "../../models/variant-writes.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";

import {
  type ApiV2Input,
  EDIT_PRODUCTS_SCOPES,
  errorWithCreatingObject,
  errorWithObject,
  loadProduct,
  registerApiV2,
  successWithObject,
} from "./base.ts";
import {
  findVariantCategory,
  loadVariant,
  loadVariantCategory,
  productCustomFields,
  successWithVariant,
} from "./product-resources.ts";
import { customFieldJson, externalId, variantCategoryJson } from "./records.ts";
import { rubyToI } from "./ruby-params.ts";

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

const presence = (value: string | null | undefined): string | null =>
  value === undefined || value === null || blank(value) ? null : value;

type CustomFieldDraft = { field_type: string | null; name: string | null; flags: bigint };

// CustomField's validations, in the order the model declares them: belongs_to :seller, field_type inclusion, name presence,
// terms_valid_uri, type_not_boolean_if_post_purchase (is_post_purchase is flag 1).
function customFieldErrors(field: CustomFieldDraft): string[] {
  const errors: string[] = [];
  if (field.field_type === null || !CUSTOM_FIELD_TYPES.includes(field.field_type))
    errors.push("Field type is not included in the list");
  if (field.name === null || blank(field.name)) errors.push("Name can't be blank");
  if (field.field_type === TYPE_TERMS && !(field.name !== null && URI_REGEXP.test(field.name)))
    errors.push("Please provide a valid URL for custom field of Terms type.");
  if ((field.flags & 1n) === 1n && ["checkbox", TYPE_TERMS].includes(field.field_type ?? ""))
    errors.push("Boolean post-purchase fields are not allowed");
  return errors;
}

// before_validation :set_default_name
const withDefaultName = <T extends CustomFieldDraft>(field: T): T =>
  field.field_type === TYPE_FILE && (field.name === null || blank(field.name))
    ? { ...field, name: FILE_FIELD_NAME }
    : field;

async function loadCustomField(input: ApiV2Input) {
  const halted = await loadProduct("link_id")(input);
  if (halted) return halted;
  // `@custom_fields.where(name: params[:id]).last`
  const fields = (await productCustomFields(productOf(input))).filter(
    (field) => field.name !== null && field.name.toLowerCase() === input.routeParams.id!.toLowerCase(),
  );
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
      const name =
        presence(stringParam(params.name)) ?? presence(stringParam(params.url)) ?? presence(stringParam(params.label));
      if (name === null) return errorWithCreatingObject("custom_field");
      const type = stringParam(params.type);
      const draft = withDefaultName({ field_type: type ?? "text", name, flags: 0n });
      const errors = customFieldErrors(draft);
      if (errors.length > 0) return errorWithCreatingObject("custom_field", { errors });

      const now = new Date();
      const field = await db.$transaction(async (tx) => {
        const created = await tx.customField.create({
          data: {
            field_type: draft.field_type,
            name: draft.name,
            required: params.required === "true",
            seller_id: owner.id,
            created_at: now,
            updated_at: now,
          },
        });
        await tx.customFieldsProduct.create({
          data: { custom_field_id: created.id, product_id: productOf(input).id, created_at: now, updated_at: now },
        });
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
  {
    method: "PUT",
    pattern: "/v2/products/:link_id/custom_fields/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadCustomField,
    run: updateCustomField,
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/custom_fields/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadCustomField,
    async run(input) {
      const field: CustomField = input.state.customField;
      // `@custom_field.products.count`: the join rows whose product exists.
      const joins = await db.customFieldsProduct.findMany({ where: { custom_field_id: field.id } });
      const live =
        joins.length === 0
          ? []
          : await db.link.findMany({
              where: { id: { in: joins.map((join) => join.product_id) } },
              select: { id: true },
            });
      if (live.length > 1)
        await db.customFieldsProduct.deleteMany({
          where: { custom_field_id: field.id, product_id: productOf(input).id },
        });
      else await db.customField.delete({ where: { id: field.id } });
      return successWithObject("custom_field", null);
    },
  },
);

async function updateCustomField(input: ApiV2Input) {
  const field: CustomField = input.state.customField;
  const required = input.params.required;
  // A request that names no `required` changes nothing and succeeds.
  if (required === undefined || required === null)
    return successWithObject("custom_field", await customFieldJson(field));
  const draft = withDefaultName({ field_type: field.field_type, name: field.name, flags: field.flags });
  const next = { ...field, required: required === "true", name: draft.name };
  // `update` returns false for a field that no longer validates, and the action ignores that: the response shows the in-memory value.
  if (customFieldErrors(draft).length === 0 && (next.required !== field.required || next.name !== field.name)) {
    await db.customField.update({
      where: { id: field.id },
      data: { required: next.required, name: next.name, updated_at: new Date() },
    });
  }
  return successWithObject("custom_field", await customFieldJson(next));
}

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::VariantCategoriesController

// `params.permit(:title)`: a scalar title. A JSON boolean is permitted and the varchar column casts it to "1"/"0". A number stays in Rails
// (the parsed body cannot tell 5 from 5.0, and Rails keeps the difference); anything else is dropped or unpermitted.
function permittedTitle(params: Record<string, unknown>): { given: boolean; title: string | null } {
  if (!("title" in params)) return { given: false, title: null };
  const title = params.title;
  if (typeof title === "boolean") return { given: true, title: title ? "1" : "0" };
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
        const created = await tx.variantCategory.create({
          data: { link_id: Number(link.id), ...(given ? { title } : {}) },
        });
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
  {
    method: "PUT",
    pattern: "/v2/products/:link_id/variant_categories/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadVariantCategoryForWrite,
    run: updateVariantCategory,
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/variant_categories/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadVariantCategoryForWrite,
    run: destroyVariantCategory,
  },
);

// Soft-deletes the grouping only: its versions stay alive, as in Rails. The deleted_at is re-read under the row lock so a retry or a
// concurrent DELETE that lost the race records no second audit row.
async function destroyVariantCategory(input: ApiV2Input) {
  const category = input.state.variantCategory;
  const link = productOf(input);
  const now = new Date();
  const aliveChildVariantCount = await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      { deleted_at: Date | null }[]
    >`SELECT deleted_at FROM variant_categories WHERE id = ${category.id} FOR UPDATE`;
    if (locked === undefined || locked.deleted_at !== null) return null;
    const count = await tx.baseVariant.count({
      where: { type: "Variant", variant_category_id: category.id, deleted_at: null },
    });
    await tx.variantCategory.update({ where: { id: category.id }, data: { deleted_at: now } });
    await tx.link.update({ where: { id: link.id }, data: { updated_at: now } });
    return count;
  });
  if (aliveChildVariantCount !== null) {
    await invalidateProductCache(link.id);
    await recordVariantCategoryDeletion(db, {
      actorUserId: input.owner.id,
      productId: link.id,
      deletedCategoryExternalId: externalId(category.id),
      aliveChildVariantCount,
      requestId: requestIdOf(input.request.headers.get("x-request-id")),
    });
  }
  return successWithObject("variant_category", null);
}

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
  return successWithObject(
    "variant_category",
    variantCategoryJson({ ...category, title: given ? title : category.title }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::VariantsController#create, #update and #destroy
//
// Served: the before_actions (token scope, product, category and version lookups) and the saves of a version of a plain product
// (models/variant-writes.ts). Handed to Rails whole, before any write: a tier, a call or coffee product, a free product, a version with
// prices of its own, a parameter the port does not cast like Ruby, and an update that carries `rich_content` (it rewrites pages and files).
const VARIANTS = "/v2/products/:link_id/variant_categories/:variant_category_id/variants";
const INTEGER_COLUMN_LIMIT = 2 ** 31 - 1;
const VARCHAR_LIMIT = 255;

// ActiveModel's Integer cast: blank is nil, a string reads as String#to_i. A value of another type, or outside the column, stays in Rails.
function castInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  let integer: bigint;
  if (typeof value === "string") {
    if (blank(value)) return null;
    integer = rubyToI(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value)) integer = BigInt(value);
  else throw new NotPortedError("a version amount that is not text or a whole number");
  if (integer > BigInt(INTEGER_COLUMN_LIMIT) || integer < -BigInt(INTEGER_COLUMN_LIMIT))
    throw new NotPortedError("a version amount outside the column's range");
  return Number(integer);
}

function castString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || [...value].length > VARCHAR_LIMIT)
    throw new NotPortedError("a version name or description that is not text, or too long for its column");
  return value;
}

// `params.permit(:price_difference_cents, :description, :name, :max_purchase_count)`: only the keys the request names.
function permittedVariantAttributes(params: Record<string, unknown>): Partial<BaseVariant> {
  const attributes: Partial<BaseVariant> = {};
  if ("price_difference_cents" in params)
    attributes.price_difference_cents = castInteger(params.price_difference_cents);
  if ("description" in params) attributes.description = castString(params.description);
  if ("name" in params) attributes.name = castString(params.name);
  if ("max_purchase_count" in params) attributes.max_purchase_count = castInteger(params.max_purchase_count);
  return attributes;
}

const errorsOf = (record: { errors: { fullMessages(): string[] } }) => ({ errors: record.errors.fullMessages() });

async function createVariant(input: ApiV2Input) {
  const product = productOf(input);
  await assertPlainVariantProduct(product);
  const attributes = permittedVariantAttributes(input.params);
  const record = buildVariant({ ...attributes, variant_category_id: input.state.variantCategory.id });
  if (!(await Variants.save(record))) return errorWithCreatingObject("variant", errorsOf(record));
  return successWithVariant(product, record.attributes as BaseVariant);
}

async function updateVariant(input: ApiV2Input) {
  const product = productOf(input);
  if ("rich_content" in input.params) throw new NotPortedError("the rich content of a version");
  await assertPlainVariantProduct(product);
  const row: BaseVariant = input.state.variant;
  await assertPlainVariant(row);
  const attributes = permittedVariantAttributes(input.params);
  const record = loadVariantRecord(row);
  record.assign(attributes);
  if (!(await Variants.save(record))) return errorWithObject("variant", errorsOf(record));
  return successWithVariant(product, record.attributes as BaseVariant);
}

// A retry, or a request that lost the race, finds the row deleted under the lock: nothing is written or audited.
async function destroyVariant(input: ApiV2Input) {
  const product = productOf(input);
  const row: BaseVariant = input.state.variant;
  if (row.deleted_at !== null) return successWithObject("variant", null);
  await assertPlainVariantProduct(product);
  await assertPlainVariant(row);
  const record = loadVariantRecord(row);
  let deleted = false;
  await Variants.withLock(record, async () => {
    if (record.get("deleted_at") !== null) return;
    // update_attribute: no validations, every callback; deliberately not mark_deleted, which also enqueues the rich content and archive cleanup.
    record.set("deleted_at", new Date());
    await Variants.save(record, { validate: false });
    deleted = true;
  });
  if (deleted)
    await recordVariantDeletion(db, {
      actorUserId: input.owner.id,
      productId: product.id,
      deletedVariantExternalId: externalId(row.id),
      requestId: requestIdOf(input.request.headers.get("x-request-id")),
    });
  return successWithObject("variant", null);
}

registerApiV2(
  { method: "POST", pattern: VARIANTS, scopes: EDIT_PRODUCTS_SCOPES, before: loadVariantCategory, run: createVariant },
  {
    method: "PATCH",
    pattern: `${VARIANTS}/:id`,
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadVariant,
    run: updateVariant,
  },
  { method: "PUT", pattern: `${VARIANTS}/:id`, scopes: EDIT_PRODUCTS_SCOPES, before: loadVariant, run: updateVariant },
  {
    method: "DELETE",
    pattern: `${VARIANTS}/:id`,
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadVariant,
    run: destroyVariant,
  },
);
