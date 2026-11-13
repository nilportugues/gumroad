// Settings::ProfileController#update (app/controllers/settings/profile_controller.rb) for the JSON request the profile editor sends:
// the profile columns, the seller_profile theme, the batched sections upsert with its layout version check, and the tabs.
//
// Handed back to Rails whole, before the first write: anything that touches Active Storage (a `profile_picture_blob_id` key of any
// value: attaching, purging, the signed-id lookup), the refusals of an Inertia-format request (only its saved redirect is ported), a blank `custom_html` on a root page that has a title or content (it edits the page), a rich text section (SaveContentUpsellsService), and a
// layout or section whose data breaks its JSON schema (JSON::Validator's messages are not reproduced; the transaction rolls back).
import { Prisma } from "@prisma/client";
import type { SellerProfileSection } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { hashOf } from "../models/seller-profile-products-sections.ts";
import { sectionModelFor, SECTION_KINDS } from "../models/seller-profile-section-kinds.ts";
import {
  buildSellerProfile,
  findSellerProfile,
  type SellerProfileRecord,
  SellerProfiles,
} from "../models/seller-profile.ts";
import { castRow, column, execute, selectRows, table } from "../models/sql.ts";
import { findUserBang, setFlag, setSellerProfileTarget, Users, type UserFlag } from "../models/user.ts";
import { storedTabs, layoutVersion } from "../page-props/settings/profile.ts";
import { authorize } from "../policies/authorize.ts";
import { settingsProfilePolicy } from "../policies/settings/profile.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import {
  assign,
  blank,
  createSection,
  InvalidSectionType,
  permitted as permittedSection,
  unsupported,
} from "./profile-sections-mutations.ts";
import type { Params } from "./rails-body.ts";
import { requestFormat } from "./rails-params.ts";
import { accountEmailRequired, authorizeJson, json } from "./seller-json.ts";
import { isPermittedScalar, stringValue, toSentence, TRUE_VALUES } from "./settings-mutations.ts";

const STALE_PROFILE_MESSAGE = "Your profile was changed somewhere else. Please reload the page and try again.";
const UNCONFIRMED_MESSAGE = "You have to confirm your email address before you can do that.";
const CUSTOM_HTML_MESSAGE = "Custom HTML can only be edited through the Gumroad CLI or API.";
const INVALID_SECTION_TYPE_MESSAGE = "Invalid section type";

// Settings::ProfilePolicy#permitted_attributes
const USER_STRING_KEYS = [
  { key: "name", column: "varchar" },
  { key: "bio", column: "text" },
] as const;
const USER_FLAG_KEYS: Record<string, UserFlag> = {
  product_page_storefront_enabled: "product_page_storefront_enabled",
  hide_follow_form: "hide_follow_form",
};
const SELLER_PROFILE_KEYS = ["font", "background_color", "highlight_color", "border_radius", "button_hover"] as const;

class StaleProfileError extends Error {}

type Tab = { name: string; sections: string[] };
type SectionParams = { id: string | null | undefined; attributes: Params };
type Permitted = {
  version: unknown;
  user: Params | undefined;
  sellerProfile: Params | undefined;
  tabs: Tab[] | undefined;
  sections: SectionParams[] | undefined;
};

const isHash = (value: unknown): value is Params =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Rails leaves Vary: Accept on every answer of this action, whatever it read.
const respondError = (message: string): ActionResult => ({
  ...json({ success: false, error_message: message }),
  paramsRead: false,
});
const respondSuccess = (): ActionResult => ({ ...json({ success: true }), paramsRead: false });
const SUCCESS_BODY = (respondSuccess() as { body: string }).body;
const PROFILE_PATH = "/profile";
const SEE_OTHER = 303;

// `params.permit(...)`, where a shape Rails would filter or reshape is a request to leave to it.
function permitParams(params: Params): Permitted {
  if ("profile_picture_blob_id" in params)
    throw new HandBackToRails("a profile picture, which attaches or purges an Active Storage blob");
  if ("user" in params && !isHash(params.user)) throw new HandBackToRails("a user parameter that is not a hash");
  if ("seller_profile" in params && !isHash(params.seller_profile))
    throw new HandBackToRails("a seller_profile parameter that is not a hash");

  const user = isHash(params.user)
    ? permittedHash(params.user, [
        ...USER_STRING_KEYS.map((entry) => entry.key),
        "custom_html",
        ...Object.keys(USER_FLAG_KEYS),
      ])
    : undefined;
  const sellerProfile = isHash(params.seller_profile)
    ? permittedHash(params.seller_profile, SELLER_PROFILE_KEYS)
    : undefined;

  let tabs: Tab[] | undefined;
  if ("tabs" in params) {
    if (!Array.isArray(params.tabs)) throw new HandBackToRails("tabs that are not a list");
    tabs = params.tabs.map((tab) => {
      if (!isHash(tab)) throw new HandBackToRails("a tab that is not a hash");
      const sections = tab.sections;
      if (sections !== undefined && !(Array.isArray(sections) && sections.every((id) => typeof id === "string")))
        throw new HandBackToRails("tab sections that are not a list of strings");
      // A missing or non-string name breaks the profile's JSON schema.
      if (typeof tab.name !== "string") throw new HandBackToRails("a tab without a string name");
      return { name: tab.name, sections: sections ?? [] };
    });
  }

  let sections: SectionParams[] | undefined;
  if ("sections" in params) {
    if (!Array.isArray(params.sections)) throw new HandBackToRails("sections that are not a list");
    sections = params.sections.map((section) => {
      if (!isHash(section)) throw new HandBackToRails("a section that is not a hash");
      const { id, ...attributes } = section;
      if (id !== undefined && id !== null && typeof id !== "string")
        throw new HandBackToRails("a section id that is not a string");
      return { id: id as string | null | undefined, attributes: permittedSection(attributes, true) };
    });
  }

  return { version: params.profile_version, user, sellerProfile, tabs, sections };
}

function permittedHash(hash: Params, keys: readonly string[]): Params {
  const out: Params = {};
  for (const key of keys) if (key in hash && isPermittedScalar(hash[key])) out[key] = hash[key];
  return out;
}

// SellerProfile#layout_version over the rows as they are now.
async function currentLayoutVersion(sellerId: unknown, profile: SellerProfileRecord): Promise<string> {
  const [row] = await selectRows<{ updated_at: Date | null }>(
    Prisma.sql`SELECT MAX(${column("seller_profile_sections", "updated_at")}) AS updated_at FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${sellerId} AND ${column("seller_profile_sections", "product_id")} IS NULL`,
  );
  return layoutVersion(storedTabs(profile.get("json_data")), row?.updated_at ?? null);
}

// `permitted_params[:profile_version].blank? || layout_version != permitted_params[:profile_version]`
async function submittedVersionStale(
  version: unknown,
  sellerId: unknown,
  profile: SellerProfileRecord,
): Promise<boolean> {
  if (version === undefined || version === null || version === false || isHash(version) || Array.isArray(version))
    return true;
  if (typeof version === "string" && blank(version)) return true;
  return version !== (await currentLayoutVersion(sellerId, profile));
}

// `seller_profile.json_data`: the reader stores `{}` over a missing value, so a save that follows writes it.
function readJsonData(profile: SellerProfileRecord): Record<string, unknown> {
  if (profile.get("json_data") == null) profile.set("json_data", {} as never);
  return { ...hashOf(profile.get("json_data")) };
}

type RootPage = { id: bigint; custom_html: string | null; title: string | null; content: string | null };

// `User#page`, the root page: `user.custom_html = ""` sets its HTML to nil. A page with a title or content of its own would go
// through the sanitizer and content moderation when that save writes it.
async function rootPageToClear(sellerId: unknown): Promise<RootPage | null> {
  const [row] = await selectRows<RootPage>(
    Prisma.sql`SELECT ${column("pages", "id")}, ${column("pages", "custom_html")}, ${column("pages", "title")}, ${column("pages", "content")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${sellerId} AND ${column("pages", "slug")} IS NULL LIMIT 1`,
  );
  if (!row || row.custom_html === null) return null;
  if (row.content !== null || !blank(row.title ?? ""))
    throw new HandBackToRails("a blank custom_html on a root page that has a title or content");
  return row;
}

// SaveService#upsert!
async function upsertSection(sellerId: unknown, section: SectionParams): Promise<unknown> {
  const decrypted = typeof section.id === "string" && !blank(section.id) ? decrypt(section.id) : null;
  const [row] =
    decrypted === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`seller_profile_sections`.*")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${sellerId} AND ${column("seller_profile_sections", "id")} = ${decrypted} LIMIT 1`,
        );
  if (!row) return createSection(sellerId as bigint, section.attributes);

  const kind = castRow<SellerProfileSection>("SellerProfileSection", row);
  if (!SECTION_KINDS.has(kind.type)) throw unsupported(`a ${kind.type} profile section`);
  if (kind.json_data === null) throw unsupported("a section with no json_data");
  const { type: _type, product_id: _productId, ...attributes } = section.attributes;
  const model = sectionModelFor(kind.type);
  const record = model.load({ ...kind, json_data: hashOf(kind.json_data) as never });
  assign(record, SECTION_KINDS.get(kind.type)!, attributes);
  await model.saveBang(record);
  return record.get("id");
}

// Resolves each tab's section references to database ids, dropping any that no longer resolve; and prunes the profile sections no
// tab lists, but only when every reference resolved.
async function applyTabs(sellerId: unknown, tabs: Tab[], idsByParam: Map<string, unknown>) {
  let allResolved = true;
  const resolved = tabs.map((tab) => ({
    name: tab.name,
    sections: tab.sections.flatMap((paramId) => {
      const id = idsByParam.get(paramId) ?? decrypt(paramId);
      if (id === null || id === undefined) {
        allResolved = false;
        return [];
      }
      return [Number(id)];
    }),
  }));
  if (allResolved) {
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`seller_profile_sections`.*")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "seller_id")} = ${sellerId} AND ${column("seller_profile_sections", "product_id")} IS NULL`,
    );
    for (const row of rows) {
      const section = castRow<SellerProfileSection>("SellerProfileSection", row);
      if (resolved.some((tab) => tab.sections.includes(Number(section.id)))) continue;
      if (!SECTION_KINDS.has(section.type)) throw unsupported(`a ${section.type} profile section`);
      const model = sectionModelFor(section.type);
      await model.destroyBang(model.load(section));
    }
  }
  return resolved;
}

// `respond_success` for a request.inertia? is a redirect with a notice; every refusal of the Inertia client is still Rails'.
async function update(input: MutationInput): Promise<ActionResult> {
  const inertia = Boolean(input.request.headers.get("x-inertia"));
  // The route is registered for HTML too so that the Inertia client's request arrives; any other HTML request is Rails'.
  if (!inertia && requestFormat(input.request) !== "json")
    throw new HandBackToRails("an HTML request that is not Inertia");
  const result = await save(input);
  if (!inertia) return result;
  if ("body" in result && result.body === SUCCESS_BODY)
    return { status: SEE_OTHER, location: PROFILE_PATH, flash: { notice: "Changes saved!" } };
  throw new HandBackToRails("a refusal answered to an Inertia request");
}

async function save(input: MutationInput): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null)
    throw new HandBackToRails("a signed-out request");
  const emailRequired = accountEmailRequired(input);
  if (emailRequired) return { ...emailRequired, paramsRead: false };
  const denied = await authorizeJson(input, (context) => authorize(settingsProfilePolicy.update, context));
  if (denied) return { ...denied, paramsRead: false };

  const permitted = permitParams(input.params);
  const currentSeller = input.context.currentSeller;
  if (currentSeller.confirmed_at === null) return respondError(UNCONFIRMED_MESSAGE);

  const customHtml = permitted.user?.custom_html;
  let pageToClear: RootPage | null = null;
  if (customHtml !== undefined) {
    // `.present?` is false for nil, false and a blank string; true for anything else a scalar can be.
    if (!(customHtml === null || customHtml === false || (typeof customHtml === "string" && blank(customHtml))))
      return respondError(CUSTOM_HTML_MESSAGE);
    pageToClear = await rootPageToClear(currentSeller.id);
  }

  if (permitted.tabs || permitted.sections) {
    const early = await findSellerProfile(currentSeller.id);
    if (early && (await submittedVersionStale(permitted.version, currentSeller.id, early)))
      return respondError(STALE_PROFILE_MESSAGE);
  }

  const seller = await findUserBang(currentSeller.id);
  try {
    return await Users.withLock(seller, async () => {
      const profile =
        (await findSellerProfile(seller.get("id"), { lock: true })) ?? buildSellerProfile(seller.get("id"));
      setSellerProfileTarget(seller, profile);
      if ((permitted.tabs || permitted.sections) && profile.persisted) {
        readJsonData(profile);
        if (await submittedVersionStale(permitted.version, seller.get("id"), profile)) throw new StaleProfileError();
      }

      const idsByParam = new Map<string, unknown>();
      for (const section of permitted.sections ?? []) {
        const id = await upsertSection(seller.get("id"), section);
        if (typeof section.id === "string") idsByParam.set(section.id, id);
      }
      if (permitted.tabs) {
        const tabs = await applyTabs(seller.get("id"), permitted.tabs, idsByParam);
        profile.set("json_data", { ...readJsonData(profile), tabs } as never);
      }
      if (permitted.sellerProfile && Object.keys(permitted.sellerProfile).length > 0) {
        for (const key of SELLER_PROFILE_KEYS)
          if (key in permitted.sellerProfile) profile.set(key, stringValue(permitted.sellerProfile[key]));
      }
      await SellerProfiles.saveBang(profile);

      if (permitted.user) {
        for (const { key, column: type } of USER_STRING_KEYS)
          if (key in permitted.user) seller.set(key, stringValue(permitted.user[key], type));
        for (const [key, flag] of Object.entries(USER_FLAG_KEYS))
          if (key in permitted.user) setFlag(seller, flag, TRUE_VALUES.includes(permitted.user[key]));
        await Users.saveBang(seller);
      }
      if (pageToClear)
        await execute(
          Prisma.sql`UPDATE ${table("pages")} SET ${column("pages", "custom_html")} = NULL, ${column("pages", "updated_at")} = ${new Date()} WHERE ${column("pages", "id")} = ${pageToClear.id}`,
        );
      return respondSuccess();
    });
  } catch (error) {
    if (error instanceof StaleProfileError) return respondError(STALE_PROFILE_MESSAGE);
    if (error instanceof RecordInvalid) return respondError(toSentence(error.errors.fullMessages()));
    if (error instanceof InvalidSectionType) return respondError(INVALID_SECTION_TYPE_MESSAGE);
    throw error;
  }
}

registerMutations(
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/profile",
    json: true,
    formats: ["json", "html"] as ("json" | "html")[],
    run: update,
  })),
);
