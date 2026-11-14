// ProfileSectionsController (app/controllers/profile_sections_controller.rb) with SellerProfileSections::SaveService: the profile editor's
// per-section create, update and destroy. Rich text sections (SaveContentUpsellsService), a section whose data breaks its schema
// other than by a non-boolean show_filters (JSON::Validator's messages) and any attribute the section's class does not have (UnknownAttributeError) stay in Rails.
import { Prisma, type SellerProfileSection } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { hashOf } from "../models/seller-profile-products-sections.ts";
import { SECTION_KINDS, sectionModelFor } from "../models/seller-profile-section-kinds.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { authorize } from "../policies/authorize.ts";
import { profileSectionPolicy } from "../policies/profile-section.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import type { Params } from "./rails-body.ts";
import { authorizeJson, json as sellerJson, noContent, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const SECTIONS = "seller_profile_sections";
// SellerProfileSection's `hide_header` is the second `has_flags` entry.
const HIDE_HEADER_FLAG = 2n;
export const BASE_CLASS = "SellerProfileSection";
export const RUBY_CONSTANT = /^[A-Za-z_]\w*$/u;

// ProfileSectionPolicy::UPDATE_ATTRIBUTES, and CREATE_ATTRIBUTES' `type` and `product_id`.
const STRING_KEYS = ["header", "default_product_sort", "button_label", "featured_product_id"];
const BOOLEAN_KEYS = ["hide_header", "show_filters", "add_new_products"];
const LIST_KEYS = ["shown_products", "shown_posts", "shown_wishlists"];
const COMMON_KEYS = ["header", "hide_header", "product_id"];

// Only an implicit `head :no_content` leaves Vary without Accept: the actions that render JSON keep it.
const json = (value: unknown, status = 200) => ({ ...sellerJson(value, status), paramsRead: false });

export const unsupported = (what: string) => new NotPortedError(what, "app/controllers/profile_sections_controller.rb");

// `params.permit(...)`: a key whose value has the wrong shape is dropped by Rails, which here is a request to leave to it.
export function permitted(params: Params, create: boolean): Params {
  const out: Params = {};
  const take = (key: string, accepts: (value: unknown) => boolean) => {
    if (!(key in params)) return;
    if (!accepts(params[key])) throw unsupported(`a ${key} parameter that is not permitted`);
    out[key] = params[key];
  };
  if (create) {
    take("type", (value) => typeof value === "string");
    take("product_id", (value) => value === null || typeof value === "string");
  }
  for (const key of STRING_KEYS) take(key, (value) => value === null || typeof value === "string");
  // A string `show_filters` is permitted (a scalar) and then breaks the products schema, which the model answers with its messages.
  for (const key of BOOLEAN_KEYS)
    take(key, (value) => typeof value === "boolean" || (key === "show_filters" && typeof value === "string"));
  for (const key of LIST_KEYS)
    take(key, (value) => Array.isArray(value) && value.every((item) => typeof item === "string"));
  if ("text" in params) throw unsupported("a rich text section's text");
  return out;
}

// String#blank?
export const blank = (value: unknown) =>
  value === null || (typeof value === "string" && /^\p{White_Space}*$/u.test(value));

// SaveService#decrypt_ids: an id that does not decrypt becomes nil, which the schema then refuses.
const decryptedList = (value: unknown) => (value as string[]).map((item) => decrypt(item));
const decryptedId = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? decrypt(value) : value);

// Writes the permitted attributes onto the record the way `section.update!` / `create!` assign them, then SaveService#derive_hide_header.
export function assign(
  record: ModelRecord<SellerProfileSection>,
  section: { rubyClass: string; keys: readonly string[] },
  attributes: Params,
): void {
  const hash = { ...hashOf(record.get("json_data")) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "type") continue;
    if (!COMMON_KEYS.includes(key) && !section.keys.includes(key))
      throw unsupported(`${key} on a ${section.rubyClass}`);
    if (key === "header") record.set("header", value as string | null);
    else if (key === "hide_header") setHideHeader(record, value as boolean);
    else if (key === "product_id")
      record.set("product_id", (typeof value === "string" && value.trim() !== "" ? decrypt(value) : null) as never);
    else if (LIST_KEYS.includes(key)) hash[key] = decryptedList(value);
    else if (key === "featured_product_id") hash[key] = decryptedId(value);
    else hash[key] = value;
  }
  record.set("json_data", hash as never);
  // The header is the single source of truth for whether the name shows.
  if ("header" in attributes) setHideHeader(record, blank(attributes.header));
}

function setHideHeader(record: ModelRecord<SellerProfileSection>, hidden: boolean): void {
  const flags = BigInt(record.get("flags") as bigint | number);
  record.set("flags", (hidden ? flags | HIDE_HEADER_FLAG : flags & ~HIDE_HEADER_FLAG) as never);
}

// Everything that runs before the action: authenticate_user! is left to the route gate, and Pundit's refusal is a 401 JSON.
async function guard(
  input: MutationInput,
  query: (typeof profileSectionPolicy)[keyof typeof profileSectionPolicy],
): Promise<ActionResult | null> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const denied = await authorizeJson(input, (context) => authorize(query, context));
  return denied && { ...denied, paramsRead: false };
}

// `current_seller.seller_profile_sections.find_by_external_id!`
async function findSection(input: MutationInput) {
  const id = decrypt(input.routeParams.id!);
  const [row] =
    id === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`seller_profile_sections`.*")} FROM ${table(SECTIONS)} WHERE ${column(SECTIONS, "seller_id")} = ${input.context.currentSeller!.id} AND ${column(SECTIONS, "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  const section = castRow<SellerProfileSection>("SellerProfileSection", row);
  if (!SECTION_KINDS.has(section.type)) throw unsupported(`a ${section.type} profile section`);
  return section;
}

// `ActiveRecord::SubclassNotFound` from SaveService#create!, which the batched profile editor shares: the caller answers it.
export class InvalidSectionType extends Error {}

export async function createSection(sellerId: bigint | number, attributes: Params, explainBreaks = false) {
  const type = attributes.type;
  if (typeof type !== "string" || blank(type) || type === BASE_CLASS || type.includes("::"))
    throw unsupported("a section without a usable type");
  // A name that is no subclass of SellerProfileSection, whether or not it is a constant at all.
  if (!SECTION_KINDS.has(type)) {
    if (!RUBY_CONSTANT.test(type)) throw unsupported("a type that is not a constant name");
    throw new InvalidSectionType();
  }
  if (type === "SellerProfileRichTextSection") throw unsupported("a rich text section");

  const model = sectionModelFor(type, explainBreaks);
  const record = model.build({ seller_id: sellerId, type, json_data: {} } as never);
  assign(record, SECTION_KINDS.get(type)!, attributes);
  await model.saveBang(record);
  return record.get("id");
}

// `render json: { error: e.record.errors.full_messages.to_sentence }, status: :unprocessable_entity`
const toSentence = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)!}`;
const invalidRecord = (error: RecordInvalid) =>
  json({ error: toSentence(error.errors.fullMessages()) }, UNPROCESSABLE_ENTITY);

async function create(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, profileSectionPolicy.create);
  if (denied) return denied;
  try {
    const id = await createSection(input.context.currentSeller!.id, permitted(input.params, true), true);
    return json({ id: encrypt(id) });
  } catch (error) {
    if (error instanceof RecordInvalid) return invalidRecord(error);
    if (error instanceof InvalidSectionType) return json({ error: "Invalid section type" }, UNPROCESSABLE_ENTITY);
    throw error;
  }
}

async function update(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, profileSectionPolicy.update);
  if (denied) return denied;
  const row = await findSection(input);
  // The legacy endpoint does not mutate shown_posts, and `type` and `product_id` are excepted.
  const { shown_posts: _posts, ...attributes } = permitted(input.params, false);
  if (row.json_data === null) throw unsupported("a section with no json_data");
  const model = sectionModelFor(row.type, true);
  // The driver may hand the JSON column back as text; change tracking compares parsed values.
  const record = model.load({ ...row, json_data: hashOf(row.json_data) as never });
  assign(record, SECTION_KINDS.get(row.type)!, attributes);
  try {
    await model.saveBang(record);
  } catch (error) {
    if (error instanceof RecordInvalid) return invalidRecord(error);
    throw error;
  }
  return noContent();
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, profileSectionPolicy.destroy);
  if (denied) return denied;
  const row = await findSection(input);
  const model = sectionModelFor(row.type);
  await model.destroy(model.load(row));
  return noContent();
}

registerMutations(
  { method: "POST", pattern: "/profile_sections", json: true, run: create },
  ...["PATCH", "PUT"].map((method) => ({ method, pattern: "/profile_sections/:id", json: true, run: update })),
  { method: "DELETE", pattern: "/profile_sections/:id", json: true, run: destroy },
);
