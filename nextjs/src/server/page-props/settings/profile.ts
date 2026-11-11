// ProfilePresenter#profile_settings_props (app/presenters/profile_presenter.rb) for
// Settings::ProfileController#show. A profile with saved sections, a membership product
// throws NotPortedError: those need ProfileSectionsPresenter's Elasticsearch product search and
// ProductPresenter.card_for_web. An uploaded avatar is served unless Rails has yet to process its variant.
import { createHash } from "node:crypto";

import { db } from "../../../lib/db.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { blobSignedId } from "../../infra/active-storage.ts";
import { getConfig } from "../../infra/config.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { LinkFlags } from "../../models/link.ts";
import { FONT_CHOICES, normalizeHexColor } from "../../models/seller-profile.ts";
import { reputationProps } from "../../models/user-reputation-summary.ts";
import { sellerProfile, subdomain, UserFlags, Users, username } from "../../models/user.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { settingsMainUserPolicy } from "../../policies/settings/main-user.ts";
import { settingsProfilePolicy } from "../../policies/settings/profile.ts";
import { NotPortedError } from "../not-ported.ts";
import { avatarUrl } from "../signed-in/presenters.ts";
import { avatarAttachmentOf } from "../signed-in/reads.ts";

type Seller = NonNullable<SellerContext["seller"]>;

// SellerProfile::BORDER_RADIUS_CHOICES and BUTTON_HOVER_OFFSETS
const BORDER_RADII: Record<string, string> = { none: "0rem", small: "0.25rem", medium: "0.5rem", large: "1rem" };
const BUTTON_HOVER_OFFSETS: Record<string, string> = { lift: "0.25rem", none: "0rem" };
const DEFAULT_FONT = "ABC Favorit";
const MAX_VISIBLE_POSTS = 999;
const AUDIENCE_INSTALLMENT_TYPE = "audience";
const DEFAULT_CURRENCY = "usd";
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// SellerProfile.seller_fonts_css_source: Addressable::URI.encode of Google Fonts' css2 URL.
export function sellerFontsCssSource(): string {
  const families = FONT_CHOICES.filter((font) => font !== DEFAULT_FONT)
    .sort()
    .map((font) => `family=${font}:wght@400;600`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`.replaceAll(" ", "%20");
}

// Time#iso8601(6)
const iso8601Micros = (date: Date) => date.toISOString().replace(/\.(\d{3})Z$/u, ".$1000Z");

// JSON text as ActiveSupport's encoder writes it for these values (U+2028 and U+2029 escaped).
const toJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

export type Tab = { name: string; sections: unknown[] };

// seller_profile.json_data["tabs"]
export function storedTabs(jsonData: unknown): Tab[] {
  const data = typeof jsonData === "string" ? (present(jsonData) ? (JSON.parse(jsonData) as unknown) : null) : jsonData;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  return ((data as { tabs?: Tab[] | null }).tabs ?? []) as Tab[];
}

// SellerProfile#layout_version
export function layoutVersion(tabs: Tab[], sectionUpdatedAt: Date | null): string {
  const layout = tabs.map((tab) => [tab.name, tab.sections ?? []]);
  const payload = toJson([layout, sectionUpdatedAt ? iso8601Micros(sectionUpdatedAt) : null]);
  if (/[<>&]/u.test(payload)) throw new NotPortedError("SellerProfile#layout_version for tab names with HTML entities");
  return createHash("sha256").update(payload).digest("hex");
}

// ProfilePresenter#creator_profile
export async function creatorProfile(seller: Seller, canEdit: boolean) {
  const record = Users.load(seller);
  const youtube = await db.userYoutubeIdentity.findFirst({ where: { user_id: seller.id } });
  return {
    external_id: seller.external_id,
    avatar_url: await avatarUrl(seller),
    name: seller.name ?? username(record),
    twitter_handle: seller.twitter_handle,
    youtube_channel_id: youtube?.channel_id ?? null,
    subdomain: subdomain(record),
    is_verified: Boolean(seller.verified),
    can_edit: canEdit,
    follow_recaptcha_site_key: followRecaptchaSiteKey(seller),
    hide_follow_form: UserFlags.isSet(seller.flags, "hide_follow_form"),
    ...(await reputationProps(seller.id)),
  };
}

// FollowRecaptcha.required?(seller) ? FollowRecaptcha.site_key : nil
export function followRecaptchaSiteKey(seller: { user_risk_state?: unknown; deleted_at: Date | null }): string | null {
  const riskState = typeof seller.user_risk_state === "string" ? seller.user_risk_state : "";
  const compliant = riskState === "compliant";
  const active = seller.deleted_at === null && !riskState.startsWith("suspended");
  if (compliant && active) return null;
  const siteKey = getConfig("RECAPTCHA_FOLLOW_SITE_KEY") ?? getConfig("RECAPTCHA_MONEY_SITE_KEY");
  return present(siteKey) ? siteKey : null;
}

type PostRow = { id: number | bigint; name: string | null; slug: string | null; flags: number | bigint; published_at: Date | null };

// The `shown_on_profile` filter and the 999-post page of ProfileSectionsPresenter#visible_posts, over rows already in
// `published_at DESC, id ASC` order.
export function shownProfilePosts(posts: PostRow[]) {
  const shown = posts.filter((post) => (Number(post.flags) & SHOWN_ON_PROFILE) !== 0).slice(0, MAX_VISIBLE_POSTS);
  return shown.map((post) => ({
    id: externalId(post.id),
    name: post.name,
    slug: post.slug,
    published_at: post.published_at!.toISOString(),
  }));
}

// ProfileSectionsPresenter#visible_posts
export async function visiblePosts(seller: { id: number | bigint }) {
  const posts = await db.installment.findMany({
    where: {
      seller_id: Number(seller.id),
      deleted_at: null,
      published_at: { not: null },
      installment_type: AUDIENCE_INSTALLMENT_TYPE,
      workflow_id: null,
    },
    orderBy: [{ published_at: "desc" }, { id: "asc" }],
  });
  return shownProfilePosts(posts);
}
// Installment flag 8, :shown_on_profile
const SHOWN_ON_PROFILE = 2 ** 7;

// ProfilePresenter#shared_profile_props
async function sharedProfileProps(
  seller: Seller,
  options: { editing: boolean; canEdit: boolean; currencyCode: string; tabs: Tab[] },
) {
  const sections = await db.sellerProfileSection.count({ where: { seller_id: seller.id, product_id: null } });
  if (sections > 0) throw new NotPortedError("ProfileSectionsPresenter#props for a profile with sections");
  const ratings = (
    await db.link.findMany({
      where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
      select: { flags: true },
    })
  ).some((link) => LinkFlags.isSet(link.flags, "display_product_reviews"));
  const props: Record<string, unknown> = {
    currency_code: options.currencyCode,
    show_ratings_filter: ratings,
    creator_profile: await creatorProfile(seller, options.canEdit),
    sections: [],
  };
  if (options.editing) {
    const products = await db.link.findMany({
      where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
      select: { id: true, name: true, flags: true },
      orderBy: { id: "asc" },
    });
    props.products = products
      .filter((product) => !LinkFlags.isSet(product.flags, "archived"))
      .map((product) => ({ id: externalId(product.id), name: product.name }));
    props.posts = await visiblePosts(seller);
    props.wishlist_options = (
      await db.wishlist.findMany({ where: { user_id: seller.id, deleted_at: null }, orderBy: { id: "asc" } })
    ).map((wishlist) => ({
      id: externalId(wishlist.id),
      name: wishlist.name,
    }));
  }
  props.bio = seller.bio;
  props.tabs = options.tabs.map((tab) => ({
    name: tab.name,
    sections: tab.sections.map((id) => externalId(id as number)),
  }));
  return props;
}

export async function profileProps(context: SellerContext) {
  const seller = context.seller!;
  const user = context.user!;
  const record = Users.load(seller);

  const memberships = (
    await db.link.findMany({
      where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
      select: { flags: true },
    })
  ).filter((link) => LinkFlags.isSet(link.flags, "is_recurring_billing") && !LinkFlags.isSet(link.flags, "archived"));
  if (memberships.length > 0)
    throw new NotPortedError("ProductPresenter.card_for_web for the membership products of the profile editor");

  const profile = await sellerProfile(record);
  const stored = await db.sellerProfile.findFirst({ where: { seller_id: seller.id }, select: { json_data: true } });
  const tabs = storedTabs(stored?.json_data ?? null);
  const sectionUpdatedAt = (
    await db.sellerProfileSection.aggregate({
      where: { seller_id: seller.id, product_id: null },
      _max: { updated_at: true },
    })
  )._max.updated_at;
  const profileVersion = layoutVersion(tabs, sectionUpdatedAt);

  const confirmed = seller.confirmed_at !== null;
  let emailConfirmation: { email: string | null; can_resend: boolean } | null = null;
  if (!confirmed) {
    const email = present(seller.unconfirmed_email)
      ? seller.unconfirmed_email
      : present(seller.email)
        ? seller.email
        : null;
    emailConfirmation = {
      email,
      can_resend: email !== null && settingsMainUserPolicy.resendConfirmationEmail(context),
    };
  }

  const canEdit = settingsProfilePolicy.update(context);
  const avatarAttachment = await avatarAttachmentOf(seller.id);

  const logoutShared = await sharedProfileProps(seller, {
    editing: false,
    canEdit: false,
    currencyCode: DEFAULT_CURRENCY,
    tabs,
  });
  const editable = await sharedProfileProps(seller, {
    editing: true,
    canEdit,
    currencyCode: user.currency_type ?? DEFAULT_CURRENCY,
    tabs,
  });
  const page = await db.page.findFirst({
    where: { pageable_type: "User", pageable_id: seller.id, slug: null },
    orderBy: { id: "asc" },
  });
  const featureActive = (name: string) => isFeatureEnabled(name, userActor(seller.id));

  return {
    ...logoutShared,
    profile_settings: {
      name: seller.name,
      bio: seller.bio,
      font: profile.get("font"),
      background_color: normalizeHexColor(profile.get("background_color")),
      highlight_color: normalizeHexColor(profile.get("highlight_color")),
      border_radius: profile.get("border_radius"),
      button_hover: profile.get("button_hover"),
      profile_picture_blob_id: avatarAttachment === null ? null : blobSignedId(avatarAttachment.blob_id),
      product_page_storefront_enabled: UserFlags.isSet(seller.flags, "product_page_storefront_enabled"),
      hide_follow_form: UserFlags.isSet(seller.flags, "hide_follow_form"),
    },
    editable_profile: editable,
    profile_version: profileVersion,
    memberships: [],
    seller_fonts_css_source: sellerFontsCssSource(),
    theme_options: { border_radii: BORDER_RADII, button_hover_offsets: BUTTON_HOVER_OFFSETS },
    email_confirmation: emailConfirmation,
    custom_html_pages_enabled: await featureActive("custom_html_pages"),
    has_custom_landing_page: present(page?.custom_html),
    username: username(record),
  };
}
