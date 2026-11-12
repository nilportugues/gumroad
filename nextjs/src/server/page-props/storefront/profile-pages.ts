// UsersController#show, #subscribe, AffiliateRequestsController#new on a seller's subdomain or custom
// domain (`seller:/`, `seller:/subscribe`, `seller:/affiliates`), for visitors who are not signed in.
//
// Handed to Rails (HandBackToRails, decided in the filters): a featured product or wishlists section whose product
// or card the port cannot prove (see featured-and-wishlist-sections.ts), a products section whose cards the
// port cannot prove (see presenters/product.ts), a nested visitor search param other than the list and hash forms of `tags` and the list of `filetypes`, a nested or oversized
// affiliate param, a seller with custom HTML pages, a seller with an uploaded subscribe preview, and any non-HTML
// format.
import { Prisma, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { decrypt, encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { affiliateCookieForParams } from "../../controllers/affiliate-redirect.ts";
import {
  type Chain,
  type FilterOutcome,
  HandBackToRails,
  RoutingError,
} from "../../controllers/application-controller.ts";
import { requestCookies } from "../../controllers/rack-cookies.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { LinkFlags } from "../../models/link.ts";
import { customStyles, withDefaults } from "../../models/seller-profile-styles.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import {
  isAccountActive,
  isCompliant,
  isFlagSet,
  nameOrUsername,
  sellerProfile as loadSellerProfile,
  tiktokPixelId,
  username,
  Users,
} from "../../models/user.ts";
import type { PresenterRequest } from "../../presenters/product.ts";
import type { Params } from "../../search/ruby-params.ts";
import { domainConfig } from "../domain.ts";
import type { MetaTagBuilder } from "../meta-tags.ts";
import type { PageSpec } from "../pages.ts";
import { creatorProfile } from "../settings/profile.ts";
import { avatarUrl, displayName } from "../signed-in/presenters.ts";
import { avatarAttachmentOf } from "../signed-in/reads.ts";

import {
  FEATURED_PRODUCT_SECTION_TYPE,
  featuredProductSectionProps,
  WISHLISTS_SECTION_TYPE,
  wishlistsSectionProps,
} from "./featured-and-wishlist-sections.ts";
import { requireHtmlPage, setHostMeta } from "./post-pages.ts";
import { setFaviconMetaTags } from "./post.ts";
import {
  assertProductSectionsRender,
  NESTED_VISITOR_PARAMS,
  DEFAULT_PRODUCTS_SECTION_ID,
  PRODUCTS_SECTION_TYPE,
  productsSectionProps,
  sectionHeader,
  visitorSearchParams,
  type ProductsSectionRow,
} from "./product-sections.ts";
import { sellerOfHost } from "./seller-host.ts";

const DEFAULT_CURRENCY = "usd";
const DEFAULT_PRODUCTS_TAB_NAME = "Products";
const POSTS_PER_SECTION = 999;
const SHOWN_ON_PROFILE_FLAG = 2 ** 7;
const PROFILE_SECTION_FLAG_HIDE_HEADER = 2 ** 1;
const SUPPORTED_SECTION_TYPES = [
  "SellerProfileRichTextSection",
  "SellerProfileSubscribeSection",
  "SellerProfilePostsSection",
  PRODUCTS_SECTION_TYPE,
  FEATURED_PRODUCT_SECTION_TYPE,
  WISHLISTS_SECTION_TYPE,
];

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const squish = (value: string) => value.replace(/\s+/gu, " ").trim();

const hostUrl = (chain: Chain) => new URL(`${chain.request.protocol}${chain.request.hostWithPort}`);

// ApplicationController#set_noindex_header_for_unproven_storefront
export async function setNoindexForUnprovenStorefront(chain: Chain, seller: User): Promise<void> {
  if (isCompliant(Users.load(seller))) return;
  const [sale] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${seller.id} AND ${column("purchases", "purchase_state")} = 'successful' AND ${column("purchases", "price_cents")} != 0 LIMIT 1`,
  );
  if (!sale) chain.headers.set("x-robots-tag", "noindex");
}

// CustomDomainConfig#set_user for `/:username/...` on the Gumroad domain, then #error_if_user_not_found.
async function sellerOfUsername(encoded: string): Promise<User> {
  const name = decodeURIComponent(encoded);
  const user =
    (await db.user.findFirst({ where: { username: name }, orderBy: { id: "asc" } })) ??
    (await db.user.findFirst({ where: { external_id: name }, orderBy: { id: "asc" } }));
  if (!user || !isAccountActive(Users.load(user)) || user.username === null) throw new RoutingError("Not Found");
  return user;
}

async function storefrontFilters(
  chain: Chain,
  options: { noindex: boolean; affiliateCookie?: boolean; customHtml?: boolean; visitorFilters?: boolean },
): Promise<User> {
  requireHtmlPage(chain, options.visitorFilters ? NESTED_VISITOR_PARAMS : []);
  const seller = await sellerOfHost(hostUrl(chain));
  if (options.affiliateCookie) {
    const cookie = await affiliateCookieForParams(chain.request, chain.now);
    if (cookie !== null) chain.cookies.push(cookie);
  }
  if (options.noindex) await setNoindexForUnprovenStorefront(chain, seller);
  if (options.customHtml) {
    const page = await db.page.findFirst({
      where: { pageable_type: "User", pageable_id: seller.id, slug: null },
      orderBy: { id: "asc" },
    });
    if (present(page?.custom_html) && (await isFeatureEnabled("custom_html_pages", userActor(seller.id))))
      throw new HandBackToRails();
  }
  return seller;
}

// PageMeta::ShareCard.for(user): a generated preview or an uploaded avatar makes the card, whose URLs
// come from Active Storage.
async function assertNoShareCard(seller: User): Promise<void> {
  const subscribePreview = await db.activeStorageAttachment.findFirst({
    where: { record_type: "User", record_id: seller.id, name: "subscribe_preview" },
  });
  if (subscribePreview) throw new HandBackToRails();
}

// PageMeta::User#set_user_page_meta
async function setUserPageMeta(meta: MetaTagBuilder, seller: User): Promise<void> {
  const record = Users.load(seller);
  const name = nameOrUsername(record);
  meta.set({ property: "og:site_name", content: "Gumroad" });
  meta.set({ property: "og:type", content: "website" });
  const title = present(seller.bio) ? `Subscribe to ${name} on Gumroad` : `Subscribe to ${name}`;
  const description = present(seller.bio)
    ? Array.from(squish(seller.bio)).slice(0, 300).join("")
    : `Get the latest products and updates from ${name} on Gumroad.`;
  meta.set({ property: "og:title", content: title });
  meta.set({ name: "description", content: description });
  meta.set({ property: "og:description", content: description });

  // The generated subscribe preview hands back (assertNoShareCard); an uploaded avatar is the card.
  const avatar = await avatarAttachmentOf(seller.id);
  if (avatar) {
    const url = await avatarUrl(seller);
    const alt = `${name}'s profile picture`;
    meta.set({ property: "og:image", content: url });
    meta.set({ property: "og:image:alt", content: alt });
  }
  if (present(seller.name)) meta.set({ property: "og:title", content: seller.name });

  const profile = await loadSellerProfile(record);
  const styles = customStyles(withDefaults(profileStyle(profile)));
  if (styles !== "") meta.set({ tag_name: "style", inner_content: styles, head_key: "custom_styles" });
  if (profile.get("font") === "ABC Favorit") {
    const { assetHost } = await import("../domain.ts");
    meta.set({
      tag_name: "link",
      rel: "preload",
      href: `${assetHost(domainConfig(process.env)) ?? ""}/fonts/ABCFavorit-Regular.woff2`,
      as: "font",
      type: "font/woff2",
      crossorigin: "anonymous",
      head_key: "default_font_preload",
    });
  }
}

const profileStyle = (profile: Awaited<ReturnType<typeof loadSellerProfile>>) => ({
  font: profile.get("font"),
  background_color: profile.get("background_color"),
  highlight_color: profile.get("highlight_color"),
  border_radius: profile.get("border_radius"),
  button_hover: profile.get("button_hover"),
});

type SellerProfileJson = { tabs?: { name: string; sections: number[] }[] | null } | null;

async function profileTabs(seller: User): Promise<{ name: string; sections: number[] }[]> {
  const row = await db.sellerProfile.findFirst({ where: { seller_id: seller.id }, select: { json_data: true } });
  return ((row?.json_data as SellerProfileJson)?.tabs ?? []).map((tab) => ({ name: tab.name, sections: tab.sections }));
}

// The request a card reads (ActionDispatch::Request#host, #protocol, ...), from the page's URL.
function presenterRequest(url: URL, headers: Headers): PresenterRequest {
  return {
    host: url.hostname,
    hostWithPort: url.host,
    protocol: `${url.protocol}//`,
    remoteIp: headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    params: Object.fromEntries(url.searchParams),
    cookies: requestCookies(headers.get("cookie")),
  };
}

// `sections.empty? && seller.products.alive.not_archived.exists?`
async function defaultProductsSectionAvailable(seller: User): Promise<boolean> {
  const products = await db.link.findMany({
    where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
    select: { flags: true },
  });
  return products.some((product) => !LinkFlags.isSet(product.flags, "archived"));
}

// ProfileSectionsPresenter#cached_sections + #section_props for the visitor shape.
async function sectionsProps(seller: User, request: PresenterRequest, visitor: Params | null) {
  const sections = await db.sellerProfileSection.findMany({
    where: { seller_id: seller.id, product_id: null },
    orderBy: { id: "asc" },
  });
  return Promise.all(
    sections.map(async (section) => {
      const data = (section.json_data ?? {}) as Record<string, unknown>;
      const hideHeader = (section.flags & BigInt(PROFILE_SECTION_FLAG_HIDE_HEADER)) !== 0n;
      const base = { id: externalId(section.id), header: hideHeader ? null : section.header, type: section.type };
      switch (section.type) {
        case PRODUCTS_SECTION_TYPE:
          return productsSectionProps(
            seller,
            section as ProductsSectionRow,
            sectionHeader(section, hideHeader),
            request,
            visitor,
          );
        case FEATURED_PRODUCT_SECTION_TYPE:
          return featuredProductSectionProps(seller, base, data, request);
        case WISHLISTS_SECTION_TYPE:
          return wishlistsSectionProps(base, data);
        case "SellerProfileRichTextSection":
          return { ...base, text: data.text ?? null };
        case "SellerProfileSubscribeSection":
          return { ...base, button_label: data.button_label ?? null };
        default:
          return {
            ...base,
            posts: await visiblePosts(
              seller,
              section.type === "SellerProfilePostsSection" ? ((data.shown_posts ?? []) as number[]) : [],
            ),
          };
      }
    }),
  );
}

// ProfileSectionsPresenter#visible_posts(section:)
async function visiblePosts(seller: User, shownPosts: number[]) {
  const posts = await db.installment.findMany({
    where: {
      seller_id: Number(seller.id),
      deleted_at: null,
      published_at: { not: null },
      installment_type: "audience",
      workflow_id: null,
      id: { in: shownPosts },
    },
    orderBy: [{ published_at: "desc" }, { id: "asc" }],
  });
  return posts
    .filter((post) => (post.flags & SHOWN_ON_PROFILE_FLAG) !== 0)
    .slice(0, POSTS_PER_SECTION)
    .map((post) => ({
      id: externalId(post.id),
      name: post.name,
      slug: post.slug,
      published_at: post.published_at!.toISOString(),
    }));
}

// The sections the port does not render are known before the page does: see the file header.
async function assertSectionsSupported(chain: Chain, seller: User): Promise<void> {
  const sections = await db.sellerProfileSection.findMany({
    where: { seller_id: seller.id, product_id: null },
    select: { type: true },
  });
  if (sections.some((section) => !SUPPORTED_SECTION_TYPES.includes(section.type))) throw new HandBackToRails();
  const productsShown =
    sections.some((section) =>
      [PRODUCTS_SECTION_TYPE, FEATURED_PRODUCT_SECTION_TYPE, WISHLISTS_SECTION_TYPE].includes(section.type),
    ) ||
    (sections.length === 0 && (await defaultProductsSectionAvailable(seller)));
  if (!productsShown) return;
  const visitor = await visitorSearchParams(chain.request.queryString);
  // Render the sections once ahead of the page: a card the port cannot prove is Rails' to answer.
  const url = hostUrl(chain);
  url.pathname = chain.request.path;
  url.search = chain.request.queryString;
  await assertProductSectionsRender(
    () =>
      sectionsProps(seller, presenterRequest(url, chain.request.headers), visitor).then(() =>
        defaultSection(seller, presenterRequest(url, chain.request.headers), visitor),
      ),
    () => {
      throw new HandBackToRails();
    },
  );
}

// ProfileSectionsPresenter#cached_default_products_section, for a seller with no saved sections and products to show.
async function defaultSection(
  seller: User,
  request: PresenterRequest,
  visitor: Params | null,
): Promise<Record<string, unknown> | null> {
  const saved = await db.sellerProfileSection.count({ where: { seller_id: seller.id, product_id: null } });
  if (saved > 0 || !(await defaultProductsSectionAvailable(seller))) return null;
  return productsSectionProps(seller, null, { id: DEFAULT_PRODUCTS_SECTION_ID, header: null }, request, visitor);
}

// ProfilePresenter#seller_analytics
async function sellerAnalytics(seller: User) {
  const record = Users.load(seller);
  const config = domainConfig(process.env);
  let universal = false;
  if (
    (config.railsEnv === "production" || config.railsEnv === "staging") &&
    !isFlagSet(record, "disable_third_party_analytics") &&
    present(username(record))
  ) {
    universal =
      (await db.thirdPartyAnalytic.count({
        where: { user_id: Number(seller.id), link_id: null, deleted_at: null, location: "all" },
      })) > 0;
  }
  return {
    seller_id: seller.external_id,
    analytics: {
      google_analytics_id: seller.google_analytics_id,
      facebook_pixel_id: seller.facebook_pixel_id,
      tiktok_pixel_id: tiktokPixelId(record),
      free_sales: !isFlagSet(record, "skip_free_sale_analytics"),
    },
    has_universal_third_party_analytics: universal,
    username: username(record),
  };
}

// ProfilePresenter#profile_props (include_default_products_section; none applies once the filters passed)
async function profileProps(seller: User, request: PresenterRequest, visitor: Params | null) {
  const tabsStored = await profileTabs(seller);
  const defaultProducts = await defaultSection(seller, request, visitor);
  const sections = defaultProducts ? [defaultProducts] : await sectionsProps(seller, request, visitor);
  const ratings = (
    await db.link.findMany({
      where: { user_id: seller.id, purchase_disabled_at: null, banned_at: null, deleted_at: null },
      select: { flags: true },
    })
  ).some((link) => LinkFlags.isSet(link.flags, "display_product_reviews"));
  let tabs = tabsStored.map((tab) => ({ name: tab.name, sections: tab.sections.map((id) => externalId(id)) }));
  // The virtual default section replaces the tabs with one pointing at it.
  if (defaultProducts) tabs = [{ name: DEFAULT_PRODUCTS_TAB_NAME, sections: [DEFAULT_PRODUCTS_SECTION_ID] }];
  // Sections exist while no tab points at one of them: serve one tab with every section.
  const sectionIds = sections
    .map((section) => section.id as string)
    .sort(
      (a, b) =>
        (a === DEFAULT_PRODUCTS_SECTION_ID ? 0 : decrypt(a)!) - (b === DEFAULT_PRODUCTS_SECTION_ID ? 0 : decrypt(b)!),
    );
  if (
    !defaultProducts &&
    sectionIds.length > 0 &&
    !tabs.some((tab) => tab.sections.some((id) => sectionIds.includes(id)))
  ) {
    tabs = [{ name: tabs[0]?.name ?? DEFAULT_PRODUCTS_TAB_NAME, sections: sectionIds }];
  }
  return {
    currency_code: DEFAULT_CURRENCY,
    show_ratings_filter: ratings,
    creator_profile: await creatorProfile(seller, false),
    sections,
    bio: seller.bio,
    tabs,
    seller_analytics: await sellerAnalytics(seller),
  };
}

export const PROFILE_PAGES: Record<string, PageSpec> = {
  "seller:/": {
    component: "Users/Show",
    buyerCurrencyFooter: true,
    options: {
      filters: async (chain): Promise<FilterOutcome> => {
        const seller = await storefrontFilters(chain, {
          noindex: true,
          affiliateCookie: true,
          customHtml: true,
          visitorFilters: true,
        });
        await assertNoShareCard(seller);
        await assertSectionsSupported(chain, seller);
        return { state: {} };
      },
    },
    props: async (_params, action) => {
      const seller = await sellerOfHost(action.url);
      await setHostMeta(action.meta, seller);
      action.meta.set({ title: nameOrUsername(Users.load(seller)) });
      await setUserPageMeta(action.meta, seller);
      const profile = await loadSellerProfile(Users.load(seller));
      if (present(profile.get("seo_title") ?? undefined)) {
        action.meta.set({ title: profile.get("seo_title") });
        action.meta.set({ property: "og:title", content: profile.get("seo_title") });
      }
      if (present(profile.get("seo_description") ?? undefined)) {
        action.meta.set({ name: "description", content: profile.get("seo_description") });
        action.meta.set({ property: "og:description", content: profile.get("seo_description") });
      }
      await setFaviconMetaTags(action.meta, seller);
      return profileProps(
        seller,
        presenterRequest(action.url, action.headers),
        await visitorSearchParams(action.url.search.replace(/^\?/u, "")),
      );
    },
  },
  "seller:/subscribe": {
    component: "Users/Subscribe",
    options: {
      filters: async (chain): Promise<FilterOutcome> => {
        const seller = await storefrontFilters(chain, { noindex: true });
        await assertNoShareCard(seller);
        return { state: {} };
      },
    },
    props: async (_params, action) => {
      const seller = await sellerOfHost(action.url);
      await setHostMeta(action.meta, seller);
      await setUserPageMeta(action.meta, seller);
      await setFaviconMetaTags(action.meta, seller);
      action.meta.set({ title: `Subscribe to ${present(seller.name) ? seller.name : username(Users.load(seller))}` });
      return { creator_profile: await creatorProfile(seller, false) };
    },
  },
  // UsersController#subscribe_preview on the Gumroad domain: the page SubscribePreviewGeneratorService screenshots.
  "/:username/subscribe_preview": {
    component: "Users/SubscribePreview",
    options: {
      filters: async (chain): Promise<FilterOutcome> => {
        requireHtmlPage(chain);
        const seller = await sellerOfUsername(chain.request.path.split("/")[1] ?? "");
        await setNoindexForUnprovenStorefront(chain, seller);
        await assertNoShareCard(seller);
        // The props carry a resized variant of the avatar, which comes from Active Storage.
        if (await avatarAttachmentOf(seller.id)) throw new HandBackToRails();
        return { state: {} };
      },
    },
    props: async ({ username }, action) => {
      const seller = await sellerOfUsername(username!);
      await setUserPageMeta(action.meta, seller);
      return {
        avatar_url: await avatarUrl(seller),
        title: nameOrUsername(Users.load(seller)),
        bio: present(seller.bio) ? seller.bio : null,
      };
    },
  },
  "seller:/affiliates": {
    component: "AffiliateRequests/New",
    options: {
      filters: async (chain): Promise<FilterOutcome> => {
        const seller = await storefrontFilters(chain, { noindex: false });
        const enabled = await db.selfServiceAffiliateProduct.findFirst({
          where: { seller_id: seller.id, enabled: true },
          select: { id: true },
        });
        if (!enabled) throw new RoutingError("Not Found");
        return { state: {} };
      },
    },
    props: async (_params, action) => {
      const seller = await sellerOfHost(action.url);
      await setHostMeta(action.meta, seller);
      action.meta.set({ title: `Become an affiliate for ${displayName(seller)}` });
      // Rails reads the last value of a repeated param.
      const param = (name: string) => action.url.searchParams.getAll(name).at(-1) ?? null;
      return {
        creator_profile: await creatorProfile(seller, false),
        success: param("success") === "true",
        requester_has_existing_account: param("requester_has_existing_account") === "true",
        email_param: param("email"),
      };
    },
  },
};
