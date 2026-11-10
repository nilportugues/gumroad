// Api::V2::UsersController: the seller's own profile for a token (GET/PUT /v2/user, theme, profile layout, the custom HTML page)
// and the IFTTT routes that share its actions.
import type { Link, OauthAccessToken, Purchase, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { LinkFlags } from "../../models/link.ts";
import { formEmail, isConfirmed, Users, sellerProfile as loadSellerProfile } from "../../models/user.ts";
import { profileUrl } from "../../page-props/buyer/users.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { avatarUrl, displayName } from "../../page-props/signed-in/presenters.ts";
import { plaintextDescription } from "../../presenters/description.ts";
import { formattedTotalPrice } from "../../presenters/mobile-serializers.ts";
import { longUrl } from "../../presenters/product.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { authorize, errorWithObject, halted, permittedScalar, PUBLIC_READ_SCOPES, renderJson, renderResponse, successWithObject, type ApiCall, type Params } from "./ws17c-base.ts";

// Api::V2::UsersController::THEME_SURFACES
const THEME_SURFACES = [
  "storefront profile page",
  "product pages",
  "the checkout page, but only when every product being bought is this seller's",
  "the pages buyers see for products they bought",
  "posts",
  "the emails a seller sends to their audience",
];
const SEO_PARAMS = ["seo_title", "seo_description"] as const;
// Page::MAX_CUSTOM_HTML_LENGTH
const MAX_CUSTOM_HTML_LENGTH = 500_000;
const DEFAULT_PRODUCTS_SECTION_ID = "default-products";
const DEFAULT_PRODUCTS_SECTION_TYPE = "SellerProfileProductsSection";
const DEFAULT_PRODUCTS_TAB_NAME = "Products";
// SellerProfileSection: has_flags 2 => :hide_header
const HIDE_HEADER_FLAG = 2n;
const CONFIRM_EMAIL_MESSAGE = "You have to confirm your email address before you can do that.";
const CUSTOM_HTML_FEATURE = "custom_html_pages";

export const tokenScopes = (token: OauthAccessToken): string[] => (token.scopes ?? "").split(/\s+/u).filter(Boolean);

const hasAny = (held: string[], wanted: string[]) => wanted.some((scope) => held.includes(scope));

// User#as_json(api_scopes:) (app/models/concerns/user/as_json.rb)
export async function userAsJson(user: User, scopes: string[], overrides: { name?: string | null } = {}): Promise<Record<string, unknown>> {
  const name = overrides.name !== undefined ? overrides.name : user.name;
  const links = await db.link.findMany({ where: { user_id: user.id }, orderBy: { id: "asc" } });
  const permalinks = links.length === 0 ? null : links.filter((link) => link.purchase_disabled_at === null && link.banned_at === null && link.deleted_at === null).map((link) => (link.custom_permalink && link.custom_permalink.trim() !== "" ? link.custom_permalink : link.unique_permalink));
  const avatar = await avatarUrl(user);
  const common = { id: user.external_id, user_id: encrypt(user.id), url: profileUrl(user), profile_picture_url: avatar, links: permalinks };
  const valid = hasAny(scopes, ["edit_products", "view_sales", "revenue_share", "ifttt", "view_profile", "account"]);
  const result: Record<string, unknown> = valid
    ? { name, currency_type: user.currency_type, bio: user.bio, twitter_handle: user.twitter_handle, ...common, profile_url: avatar, email: formEmail(Users.load(user)) }
    : { ...Object.fromEntries(Object.entries({ name, bio: user.bio, twitter_handle: user.twitter_handle }).filter(([, value]) => value !== null && value !== undefined)), ...common };
  if (hasAny(scopes, ["view_profile", "account"])) result.display_name = displayName(user);
  if (hasAny(scopes, ["view_profile", "edit_profile", "account"])) {
    const profile = await db.sellerProfile.findFirst({ where: { seller_id: user.id }, select: { seo_title: true, seo_description: true } });
    result.seo_title = profile?.seo_title ?? null;
    result.seo_description = profile?.seo_description ?? null;
  }
  return result;
}

const truthy = (value: unknown) => value !== undefined && value !== null && value !== false;

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const scopes = tokenScopes(auth.token);
  if (truthy(call.params.is_ifttt)) {
    const blank = auth.owner.name === null || auth.owner.name.trim() === "";
    return successWithObject("data", await userAsJson(auth.owner, scopes, { name: blank ? auth.owner.email : auth.owner.name }));
  }
  return successWithObject("user", await userAsJson(auth.owner, scopes));
}

export async function iftttStatus(): Promise<ActionResult> {
  return renderJson({ status: "success" });
}

export async function theme(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const profile = await loadSellerProfile(Users.load(auth.owner));
  return renderResponse(true, {
    theme: {
      background_color: profile.get("background_color"),
      highlight_color: profile.get("highlight_color"),
      font: profile.get("font"),
      applies_to: THEME_SURFACES,
      editable_by_seller: true,
      how_to_change: "The seller changes these themselves in Settings > Profile > Design, which previews the change before saving.",
    },
  });
}

type Tab = { name?: string | null; sections?: (number | string)[] | null };

async function rootPage(user: User) {
  return db.page.findFirst({ where: { pageable_type: "User", pageable_id: user.id, slug: null }, orderBy: { id: "asc" } });
}

const customHtmlLive = async (user: User) => {
  const page = await rootPage(user);
  return page?.custom_html != null && page.custom_html.trim() !== "" ? page.custom_html : null;
};

export async function profileLayout(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["view_profile"], { requireScope: ["view_profile"] });
  if (halted(auth)) return auth.halt;
  const seller = auth.owner;
  const profile = await loadSellerProfile(Users.load(seller));
  const sections = await db.sellerProfileSection.findMany({ where: { seller_id: seller.id, product_id: null }, orderBy: { id: "asc" } });
  const byId = new Map(sections.map((section) => [Number(section.id), section]));
  let tabs: Tab[] = (((profile.get("json_data") as Record<string, unknown> | null) ?? {}).tabs as Tab[] | undefined) ?? [];
  if (sections.length === 0) {
    const products = await db.link.findMany({ where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null }, select: { flags: true } });
    if (products.some((product) => !LinkFlags.isSet(product.flags, "archived"))) tabs = [{ name: DEFAULT_PRODUCTS_TAB_NAME, sections: [DEFAULT_PRODUCTS_SECTION_ID] }];
  }
  const customVisible = (await isFeatureEnabled(CUSTOM_HTML_FEATURE, userActor(seller.id))) && (await customHtmlLive(seller)) !== null;
  return renderResponse(true, {
    profile_layout: {
      rendering: customVisible ? "custom_html" : "tabs_and_sections",
      tab_bar_visible: tabs.length > 1,
      tabs: tabs.map((tab) => ({
        name: tab.name ?? null,
        sections: (tab.sections ?? []).flatMap((id) => {
          if (id === DEFAULT_PRODUCTS_SECTION_ID) return [{ header: null, type: DEFAULT_PRODUCTS_SECTION_TYPE }];
          const section = byId.get(Number(id));
          if (!section) return [];
          const hidden = (section.flags & HIDE_HEADER_FLAG) !== 0n;
          const header = section.header !== null && section.header.trim() !== "" ? section.header : null;
          return [{ header: hidden ? null : header, type: section.type }];
        }),
      })),
      editable_by_seller: true,
      how_to_change: "The seller edits these in the dashboard under Settings > Profile. You have no endpoint for them — you can read this layout but not change it.",
    },
  });
}

export async function update(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_profile"]);
  if (halted(auth)) return auth.halt;
  const user = auth.owner;
  if (!isConfirmed(Users.load(user))) return renderResponse(false, { message: CONFIRM_EMAIL_MESSAGE });
  for (const key of SEO_PARAMS) {
    const value = call.params[key];
    if (key in call.params && value !== null && typeof value !== "string") return renderResponse(false, { message: `${key} must be a string.` });
  }
  // The profile's SEO fields are written under `with_locked_seller_profile`, with SellerProfile's `normalizes` and JSON-schema validation.
  if (SEO_PARAMS.some((key) => permittedScalar(call.params, key).present)) throw new HandBackToRails("an SEO field update");

  const record = Users.load(user);
  const attributes: Record<string, unknown> = {};
  for (const key of ["name", "bio"] as const) {
    const permitted = permittedScalar(call.params, key);
    if (permitted.present) attributes[key] = permitted.value === null ? null : String(permitted.value);
  }
  if (await Users.update(record, attributes as never)) return successWithObject("user", await userAsJson(await db.user.findUniqueOrThrow({ where: { id: user.id } }), tokenScopes(auth.token)));
  return errorWithObject("user", record.errors.fullMessages());
}

// before_action :ensure_custom_html_pages_enabled
async function customHtmlEnabled(owner: User): Promise<ActionResult | null> {
  if (await isFeatureEnabled(CUSTOM_HTML_FEATURE, userActor(owner.id))) return null;
  return { ...renderResponse(false, { message: "You do not have access to custom HTML pages." }), rescued: true };
}

// Api::V2::BaseController#custom_html_length_error
function customHtmlLengthError(params: Record<string, unknown>): string | null {
  const value = params.custom_html;
  return typeof value === "string" && [...value].length > MAX_CUSTOM_HTML_LENGTH ? `custom_html is too long (maximum is ${MAX_CUSTOM_HTML_LENGTH} characters).` : null;
}

export async function customHtml(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const disabled = await customHtmlEnabled(auth.owner);
  if (disabled) return disabled;
  const html = await customHtmlLive(auth.owner);
  // Pages::DefaultProfileDocument renders the storefront as a standalone document.
  if (html === null) throw new HandBackToRails("a profile with no custom HTML to read back");
  const page = await rootPage(auth.owner);
  return renderResponse(true, { custom_html: page!.custom_html, rendered_html: html, has_landing_page: true, profile_url: profileUrlOrNull(auth.owner) });
}

const profileUrlOrNull = (user: User) => (user.username !== null && user.username.trim() !== "" ? profileUrl(user) : null);

export async function updateCustomHtml(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_profile"]);
  if (halted(auth)) return auth.halt;
  const disabled = await customHtmlEnabled(auth.owner);
  if (disabled) return disabled;
  if (!isConfirmed(Users.load(auth.owner))) return renderResponse(false, { message: CONFIRM_EMAIL_MESSAGE });
  if (!("custom_html" in call.params)) return renderResponse(false, { message: "custom_html is required." });
  if (call.params.custom_html !== null && typeof call.params.custom_html !== "string") return renderResponse(false, { message: "custom_html must be a string." });
  const tooLong = customHtmlLengthError(call.params);
  if (tooLong) return renderResponse(false, { message: tooLong });
  // Pages::CustomHtmlWriter sanitizes the HTML (Ai::PageSanitizer, Nokogiri) and moderates it before the write.
  throw new HandBackToRails("a custom HTML write");
}

export async function editCustomHtml(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_profile"]);
  if (halted(auth)) return auth.halt;
  const disabled = await customHtmlEnabled(auth.owner);
  if (disabled) return disabled;
  if (!isConfirmed(Users.load(auth.owner))) return renderResponse(false, { message: CONFIRM_EMAIL_MESSAGE });
  const { find, replace } = call.params;
  if (typeof find !== "string" || find.trim() === "") return renderResponse(false, { message: "find is required and must be a non-empty string copied exactly from the current custom HTML." });
  if (typeof replace !== "string") return renderResponse(false, { message: 'replace is required and must be a string (use "" to delete the snippet).' });
  throw new HandBackToRails("a targeted custom HTML edit");
}

export async function previewCustomHtml(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, ["edit_profile"]);
  if (halted(auth)) return auth.halt;
  const disabled = await customHtmlEnabled(auth.owner);
  if (disabled) return disabled;
  if (!("custom_html" in call.params)) return renderResponse(false, { message: "custom_html is required." });
  const value = call.params.custom_html;
  if (value !== null && typeof value !== "string") return renderResponse(false, { message: "custom_html must be a string." });
  const tooLong = customHtmlLengthError(call.params);
  if (tooLong) return renderResponse(false, { message: tooLong });
  throw new HandBackToRails("a custom HTML preview");
}

const IFTTT_DEFAULT_LIMIT = 50;
// Beyond this a LIMIT is no longer a page of sales; Rails takes it.
const IFTTT_MAX_LIMIT = 10_000;
// Purchase::CHARGED_SUCCESS_STATES
const CHARGED_SUCCESS_STATES = ["preorder_authorization_successful", "successful"];
const DECIMAL_INTEGER = /^-?(0|[1-9]\d*)$/u;

// `params[:limit] || 50`, which ActiveRecord casts with Integer(): "010" is octal and "" raises, so only canonical integers are proven.
function iftttLimit(value: unknown): number {
  if (value === undefined || value === null || value === false) return IFTTT_DEFAULT_LIMIT;
  const limit =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(limit) || limit < 0 || limit > IFTTT_MAX_LIMIT)
    throw new NotPortedError("an IFTTT trigger limit that is not a plain integer");
  return limit;
}

// `params[:after].present?` and `.to_i`: null when absent, a whole number of seconds when proven.
function iftttTime(value: unknown): number | null {
  if (value === undefined || value === null || value === false || (typeof value === "string" && value.trim() === ""))
    return null;
  const seconds =
    typeof value === "number" ? value : typeof value === "string" && DECIMAL_INTEGER.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || Math.abs(seconds) > 10 ** 11)
    throw new NotPortedError("an IFTTT trigger time that is not a plain integer");
  return seconds;
}

export type IftttSaleQuery = { where: { gte?: Date; lte?: Date }; direction: "asc" | "desc"; limit: number };

// The `after` branch wins over `before`; both order by created_at.
export function iftttSaleQuery(params: Params): IftttSaleQuery {
  const limit = iftttLimit(params.limit);
  const after = iftttTime(params.after);
  if (after !== null) return { where: { gte: new Date(after * 1000) }, direction: "asc", limit };
  const before = iftttTime(params.before);
  if (before !== null) return { where: { lte: new Date(before * 1000) }, direction: "desc", limit };
  return { where: {}, direction: "desc", limit };
}

// Purchase#as_json_for_ifttt for a product without a cover (ProductImageURL needs an attached preview file).
export function purchaseAsJsonForIfttt(
  purchase: Purchase,
  link: Link | null,
  seller: User,
  purchaserEmail: string | null,
): Record<string, unknown> {
  if (!link) throw new NotPortedError("a purchase without a product");
  if (purchase.created_at === null) throw new NotPortedError("a purchase without created_at");
  return {
    meta: { id: encrypt(purchase.id), timestamp: Math.floor(purchase.created_at.getTime() / 1000) },
    Price: formattedTotalPrice(purchase),
    ProductName: link.name,
    PurchaseEmail: purchaserEmail ?? purchase.email,
    ProductDescription: plaintextDescription(link.description),
    ProductURL: longUrl(link as never, seller as never),
  };
}

export async function iftttSaleTrigger(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const query = iftttSaleQuery(call.params);
  const sales = await db.purchase.findMany({
    where: {
      seller_id: auth.owner.id,
      purchase_state: { in: CHARGED_SUCCESS_STATES },
      ...(Object.keys(query.where).length > 0 ? { created_at: query.where } : {}),
    },
    include: { link: true, purchaser: { select: { email: true } } },
    orderBy: [{ created_at: query.direction }, { id: query.direction }],
    take: query.limit,
  });
  const productIds = [...new Set(sales.flatMap((sale) => (sale.link_id === null ? [] : [sale.link_id])))];
  // Link#preview_image_path? and the cover URL are not ported: a product with a preview goes to Rails whole.
  if (
    productIds.length > 0 &&
    (await db.assetPreview.count({ where: { link_id: { in: productIds }, deleted_at: null } })) > 0
  ) {
    throw new NotPortedError("Purchase#as_json_for_ifttt for a product with a cover");
  }
  return successWithObject(
    "data",
    sales.map((sale) => purchaseAsJsonForIfttt(sale, sale.link, auth.owner, sale.purchaser?.email ?? null)),
  );
}
