// Port of the parts of app/models/seller_profile.rb a User save reaches: loading `user.seller_profile`,
// building the default one `User#seller_profile` falls back to, and inserting it when the user is
// saved again (has_one autosave). Validations and callbacks are in seller_profile.rb's order.
//
// Not ported: `validate :validate_json_data` (a JSON schema validator), so saving a profile with
// json_data is refused; the page/section methods and custom_styles.
import { Prisma, type SellerProfile } from "@prisma/client";

import { railsCache } from "../cache/rails-cache.ts";

import { belongsToRequired, loadBelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank, validatesInclusionOf, validatesLengthOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export type SellerProfileRecord = ModelRecord<SellerProfile>;

export const FONT_CHOICES = ["ABC Favorit", "Inter", "Domine", "Merriweather", "Roboto Slab", "Roboto Mono"];
export const BORDER_RADIUS_CHOICES = ["none", "small", "medium", "large"];
export const BUTTON_HOVER_CHOICES = ["lift", "none"];
// SellerProfile::BORDER_RADIUS_CHOICES and BUTTON_HOVER_OFFSETS: the CSS lengths.
export const BORDER_RADIUS_CSS: Record<string, string> = { none: "0rem", small: "0.25rem", medium: "0.5rem", large: "1rem" };
export const BUTTON_HOVER_OFFSET_CSS: Record<string, string> = { lift: "0.25rem", none: "0rem" };
// Page::MAX_SEO_TITLE_LENGTH, Page::MAX_SEO_DESCRIPTION_LENGTH
const MAX_SEO_TITLE_LENGTH = 70;
const MAX_SEO_DESCRIPTION_LENGTH = 320;
const STYLE_PROPERTIES = ["highlight_color", "background_color", "font", "border_radius", "button_hover"] as const;

// HexColorValidator (lib/validators/hex_color_validator.rb)
const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/iu;
const SHORTHAND_HEX_COLOR_REGEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu;

export function normalizeHexColor(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = SHORTHAND_HEX_COLOR_REGEX.exec(value);
  if (!match) return value;
  return `#${match.slice(1).map((c) => `${c}${c}`).join("")}`.toLowerCase();
}

function hexColor(attribute: "background_color" | "highlight_color"): Callback<SellerProfile> {
  return {
    name: `validates :${attribute}, hex_color: true`,
    run(record) {
      const value = record.get(attribute);
      if (!(typeof value === "string" && HEX_COLOR_REGEX.test(value))) record.errors.add(attribute, "is not a valid hexadecimal color");
    },
  };
}

const seller = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" } as const;

export const SellerProfiles = defineModel<SellerProfile>({
  rubyClass: "SellerProfile",
  prismaModel: "SellerProfile",
  delegate: (tx) => tx.sellerProfile as never,
  beforeValidation: [
    {
      name: "normalize_colors",
      run(record) {
        record.set("background_color", normalizeHexColor(record.get("background_color")) as string | null);
        record.set("highlight_color", normalizeHexColor(record.get("highlight_color")) as string | null);
      },
    },
  ],
  validations: [
    belongsToRequired<SellerProfile>(seller),
    validatesInclusionOf<SellerProfile>(["font"], { in: FONT_CHOICES }),
    hexColor("background_color"),
    hexColor("highlight_color"),
    validatesInclusionOf<SellerProfile>(["border_radius"], { in: BORDER_RADIUS_CHOICES }),
    validatesInclusionOf<SellerProfile>(["button_hover"], { in: BUTTON_HOVER_CHOICES }),
    {
      name: "validate :validate_json_data",
      if: (record) => !isBlank(record.get("json_data")),
      run() {
        throw new Error("SellerProfile#validate_json_data (JSON::Validator over lib/json_schemas/seller_profile.json) is not ported to Node yet");
      },
    },
    validatesLengthOf<SellerProfile>(["seo_title"], { maximum: MAX_SEO_TITLE_LENGTH }),
    validatesLengthOf<SellerProfile>(["seo_description"], { maximum: MAX_SEO_DESCRIPTION_LENGTH }),
  ],
  afterCommit: [
    {
      name: "clear_custom_style_cache",
      if: (record) => STYLE_PROPERTIES.some((property) => record.savedChangeTo(property)),
      async run(record, ctx) {
        // custom_style_cache_name reads `seller.id`, loaded by the presence validation.
        const owner = await loadBelongsTo(record, seller, { ...ctx, tx: { $queryRaw: (sql: Prisma.Sql) => selectRows(sql) } as never });
        await sellerProfileCache.delete(`users/${String(owner?.id)}/custom_styles_v5`);
      },
    },
  ],
});

// Rails.cache for the after_commit; tests replace it.
export let sellerProfileCache: { delete(name: string): Promise<unknown> } = { delete: (name) => railsCache().delete(name) };

export function setSellerProfileCacheForTesting(cache: { delete(name: string): Promise<unknown> }): void {
  sellerProfileCache = cache;
}

// SellerProfile's after_initialize defaults, which a built profile carries as changes.
export function buildSellerProfile(sellerId: bigint): SellerProfileRecord {
  const record = SellerProfiles.build({ seller_id: sellerId });
  if (record.get("font") == null) record.set("font", "ABC Favorit");
  if (record.get("background_color") == null) record.set("background_color", "#ffffff");
  if (record.get("highlight_color") == null) record.set("highlight_color", "#ff90e8");
  if (record.get("border_radius") == null) record.set("border_radius", "small");
  if (record.get("button_hover") == null) record.set("button_hover", "lift");
  return record;
}

// `has_one :seller_profile, foreign_key: :seller_id`, as loaded (after_initialize applies the same
// defaults to a stored row whose columns are NULL).
export async function findSellerProfile(sellerId: unknown): Promise<SellerProfileRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`seller_profiles`.*")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${sellerId} LIMIT 1`,
  );
  if (!row) return null;
  const record = SellerProfiles.load(castRow<SellerProfile>("SellerProfile", row));
  if (record.get("font") == null) record.set("font", "ABC Favorit");
  if (record.get("background_color") == null) record.set("background_color", "#ffffff");
  if (record.get("highlight_color") == null) record.set("highlight_color", "#ff90e8");
  if (record.get("border_radius") == null) record.set("border_radius", "small");
  if (record.get("button_hover") == null) record.set("button_hover", "lift");
  return record;
}
