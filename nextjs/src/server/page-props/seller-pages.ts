// PagesController index, new and edit (WS-55): the seller's page management UI. Registered in pages.ts
// through public-pages.ts. The save, delete and preview endpoints stay in Rails.
import { Prisma } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { column, selectRows, table } from "../models/sql.ts";
import { nameOrUsername, subdomainWithProtocol, username, Users } from "../models/user.ts";
import { pagePolicy } from "../policies/page.ts";
import { loadSellerContext } from "../policies/seller-context.ts";
import { squish } from "../search/plaintext.ts";

import type { PageGuard } from "./guards.ts";
import { NotPortedError } from "./not-ported.ts";
import { matchPagePath, type PageSpec } from "./pages.ts";
import { ADD_EMAIL_MESSAGE, notAllowedMessage } from "./settings/guard.ts";

// Page::MAX_SEO_TITLE_LENGTH and MAX_SEO_DESCRIPTION_LENGTH
const SEO_MAX_LENGTHS = { title: 70, description: 320 };
// Pages::ProfileData::MAX_ITEMS
const PRODUCTS_PAGE_LIMIT = 100;

type SlugRow = {
  slug: string | null;
  title: string | null;
  content: string | null;
  custom_html: string | null;
  seo_title: string | null;
  seo_description: string | null;
};

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// Pages::DocumentTitle.for(page_title:, seller_name:)
function documentTitle(pageTitle: string | null, sellerName: string | null): string {
  const title = pageTitle ?? "";
  const seller = (sellerName ?? "").trim();
  if (seller === "" || title.trim().toLowerCase().endsWith(seller.toLowerCase())) return title;
  if (title.trim() === "") return seller;
  return `${title} — ${seller}`;
}

// `current_seller.pages`: slugged, oldest first.
const sluggedPages = (sellerId: bigint) =>
  selectRows<SlugRow>(
    Prisma.sql`SELECT ${column("pages", "slug")}, ${column("pages", "title")}, ${column("pages", "content")}, ${column("pages", "custom_html")}, ${column("pages", "seo_title")}, ${column("pages", "seo_description")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${sellerId} AND ${column("pages", "slug")} IS NOT NULL ORDER BY ${column("pages", "created_at")} ASC`,
  );

async function hasRootCustomHtml(sellerId: bigint): Promise<boolean> {
  const [row] = await selectRows<{ custom_html: string | null }>(
    Prisma.sql`SELECT ${column("pages", "custom_html")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${sellerId} AND ${column("pages", "slug")} IS NULL LIMIT 1`,
  );
  return present(row?.custom_html);
}

// Page.roots.where(pageable_type: "Link", pageable_id: current_seller.links.alive.select(:id)).where.not(custom_html: nil).count
async function productPagesCount(sellerId: bigint): Promise<number> {
  const [row] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("pages")} WHERE ${column("pages", "slug")} IS NULL AND ${column("pages", "pageable_type")} = 'Link' AND ${column("pages", "pageable_id")} IN (SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL) AND ${column("pages", "custom_html")} IS NOT NULL`,
  );
  return Number(row?.count ?? 0);
}

type PageJson = {
  slug: string | null;
  title: string;
  content: string;
  custom_html: boolean;
  seo_title: string;
  seo_description: string;
  default_seo_title: string;
  default_seo_description: string | null;
};

function pageProps(page: SlugRow, sellerName: string | null): PageJson {
  return {
    slug: page.slug,
    title: page.title ?? "",
    content: page.content ?? "",
    custom_html: present(page.custom_html),
    seo_title: page.seo_title ?? "",
    seo_description: page.seo_description ?? "",
    default_seo_title: documentTitle(page.title, sellerName),
    default_seo_description: null,
  };
}

// PageMeta::User#profile_meta_description
function profileMetaDescription(bio: string | null, name: string | null): string {
  if (present(bio)) return Array.from(squish(bio)).slice(0, 300).join("");
  return `Get the latest products and updates from ${name} on Gumroad.`;
}

// The before_actions between `authenticate_user!` (signed-out visitors never reach this: the routes are
// signedInOnly) and the render: RequireAccountEmail, set_page, then `authorize :page` in the action and
// PunditAuthorization#user_not_authorized for a refusal.
const pagesGuard =
  (query: "index" | "new" | "edit"): PageGuard =>
  async (input) => {
    const context = await loadSellerContext(input.context);
    if (!context.user) throw new NotPortedError("authenticate_user! for a signed-out visitor");

    const { user } = context;
    if (!present(user.email) && !present(user.unconfirmed_email) && input.context.impersonatedUser === null) {
      return { status: 302, location: "/settings", rescued: true, flash: { warning: ADD_EMAIL_MESSAGE } };
    }

    const slug = matchPagePath(input.url.pathname)?.params.slug;
    if (query === "edit" && slug !== "profile") {
      const found = (await sluggedPages(context.seller!.id)).some((page) => page.slug === slug);
      if (!found) return { status: 302, location: "/pages", rescued: true };
    }

    if (!pagePolicy[query](context)) {
      // `params["account_switched"]` is truthy for any value, an empty one included.
      const flash = input.url.searchParams.has("account_switched") ? undefined : { alert: notAllowedMessage(context) };
      return { status: 302, location: Routes.dashboard_url(input.urlOptions), rescued: true, ...(flash && { flash }) };
    }
    return null;
  };

export const SELLER_PAGES: Record<string, PageSpec> = {
  "/pages": {
    component: "Pages/Index",
    guard: pagesGuard("index"),
    props: async (_, { context }) => {
      const seller = context.currentSeller!;
      const record = Users.load(seller);
      const sellerName = nameOrUsername(record);
      return {
        pages: (await sluggedPages(seller.id)).map((page) => pageProps(page, sellerName)),
        profile: {
          username: username(record) ?? "",
          profile_url: subdomainWithProtocol(record),
          custom_html: await hasRootCustomHtml(seller.id),
        },
        product_pages_count: await productPagesCount(seller.id),
      };
    },
  },
  "/pages/new": {
    component: "Pages/Edit",
    guard: pagesGuard("new"),
    props: (_, { context }) => {
      const record = Users.load(context.currentSeller!);
      const sellerName = nameOrUsername(record);
      return {
        page: {
          slug: null,
          title: "",
          content: "",
          custom_html: false,
          seo_title: "",
          seo_description: "",
          default_seo_title: sellerName,
          default_seo_description: null,
        },
        is_profile: false,
        is_new: true,
        username: username(record) ?? "",
        profile_url: subdomainWithProtocol(record),
        products_page_limit: PRODUCTS_PAGE_LIMIT,
        seo_max_lengths: SEO_MAX_LENGTHS,
        seller_name: sellerName,
      };
    },
  },
  "/pages/:slug/edit": {
    component: "Pages/Edit",
    guard: pagesGuard("edit"),
    props: async ({ slug }, { context }) => {
      const seller = context.currentSeller!;
      const record = Users.load(seller);
      const sellerName = nameOrUsername(record);
      let page: PageJson;
      if (slug === "profile") {
        const [profile] = await selectRows<{ seo_title: string | null; seo_description: string | null }>(
          Prisma.sql`SELECT ${column("seller_profiles", "seo_title")}, ${column("seller_profiles", "seo_description")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${seller.id} LIMIT 1`,
        );
        page = {
          slug: "profile",
          title: "Home",
          content: "",
          custom_html: await hasRootCustomHtml(seller.id),
          seo_title: profile?.seo_title ?? "",
          seo_description: profile?.seo_description ?? "",
          default_seo_title: sellerName ?? "",
          default_seo_description: profileMetaDescription(seller.bio, sellerName),
        };
      } else {
        // `redirect` has already sent unknown slugs away.
        page = pageProps((await sluggedPages(seller.id)).find((candidate) => candidate.slug === slug)!, sellerName);
      }
      return {
        page,
        is_profile: slug === "profile",
        is_new: false,
        username: username(record) ?? "",
        profile_url: subdomainWithProtocol(record),
        products_page_limit: PRODUCTS_PAGE_LIMIT,
        seo_max_lengths: SEO_MAX_LENGTHS,
        seller_name: sellerName,
      };
    },
  },
};
