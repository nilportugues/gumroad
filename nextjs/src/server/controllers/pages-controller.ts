// The write and preview actions of PagesController (app/controllers/pages_controller.rb); #index, #new and #edit are pages
// (page-props/seller-pages.ts).
//
// Ported: the RequireAccountEmail and `set_page` redirects, the policy refusals, the validation errors of #create and #update for a
// page whose title and content are both blank (moderation returns before it calls the service), #update of the profile entry
// when it has nothing to write, the removal of its custom HTML (a page with no content or title of its own) and a change to its
// search fields (a seller profile row that exists), #destroy (the row and the touch of the seller; the profile entry has nothing to delete), and the
// 404 of #preview and #products for a profile with no custom HTML or a page that is not the profile, and the catalogue slices
// of the profile preview for a page that references no price, and the preview documents (rich text, slugged and profile custom HTML).
// Handed to Rails whole, before any write: a save that passes validation (HTML sanitizing, content moderation, the slug), the
// other changes to the profile entry, and the preview of a profile that references prices.
import { Prisma } from "@prisma/client";

import { isBlank } from "../models/compliance-countries.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { findSellerProfile, SellerProfiles } from "../models/seller-profile.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import {
  findUserBang,
  nameOrUsername,
  rubyStrip,
  setSellerProfileTarget,
  subdomainWithProtocol,
  Users,
} from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { pagePolicy } from "../policies/page.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { squish } from "../search/plaintext.ts";
import { enqueueRoutabilityRefresh } from "../services/custom-domain-hosts.ts";
import { richTextDocument } from "../services/pages-documents.ts";
import { interpolateProfile } from "../services/pages-interpolator.ts";
import { referencedInPrices } from "../services/pages-product-prices.ts";
import { loadProfileDataFacts, profileDataJson } from "../services/pages-profile-data.ts";

import { HandBackToRails, type ActionResult, type Redirected } from "./application-controller.ts";
import {
  customHtmlCsp,
  FOLLOW_BRIDGE_SCRIPT,
  pagesTailwindHead,
  PRODUCTS_BRIDGE_SCRIPT,
  profileCustomHtmlDocument,
} from "./custom-html-document.ts";
import { customHtmlProductsSlice } from "./custom-html-products-slice.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { pagePreviewDocument } from "./user-page-documents.ts";
import { requireHtml } from "./users-controller.ts";

const FOUND = 302;
const SEE_OTHER = 303;
const NOT_FOUND = 404;
const PAGES_PATH = "/pages";
const NEW_PAGE_PATH = "/pages/new";
const PROFILE_SLUG = "profile";
const HTML = "text/html; charset=utf-8";
// Page::MAX_SEO_TITLE_LENGTH, MAX_SEO_DESCRIPTION_LENGTH and MAX_CONTENT_LENGTH
const MAX_SEO_TITLE_LENGTH = 70;
const MAX_SEO_DESCRIPTION_LENGTH = 320;

type Hash = Record<string, unknown>;

type PageRow = { id: bigint; custom_html: string | null };
type RootPageRow = PageRow & { title: string | null; content: string | null };

const guardInput = (input: MutationInput) => ({
  context: input.context,
  config: domainConfig(process.env),
  url: input.url,
  params: input.routeParams,
  urlOptions: input.urlOptions,
});

// `current_seller.pages.find_by(slug:)`
async function slugged(sellerId: bigint, slug: string): Promise<PageRow | null> {
  const [row] = await selectRows<PageRow>(
    Prisma.sql`SELECT ${column("pages", "id")}, ${column("pages", "custom_html")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${sellerId} AND ${column("pages", "slug")} = ${slug} LIMIT 1`,
  );
  return row ?? null;
}

// `current_seller.custom_html`: the root page of the seller.
async function profileCustomHtml(sellerId: bigint): Promise<string | null> {
  const [row] = await selectRows<PageRow>(
    Prisma.sql`SELECT ${column("pages", "id")}, ${column("pages", "custom_html")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${sellerId} AND ${column("pages", "slug")} IS NULL LIMIT 1`,
  );
  return row?.custom_html ?? null;
}

// `current_seller.custom_html = nil; current_seller.save!`: the autosaved root page loses its HTML and touches the seller. A page that
// holds a title or content of its own would go through the sanitizer and content moderation on that save.
async function removeProfileTakeover(input: MutationInput): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  const [root] = await selectRows<RootPageRow>(
    Prisma.sql`SELECT ${column("pages", "id")}, ${column("pages", "custom_html")}, ${column("pages", "title")}, ${column("pages", "content")} FROM ${table("pages")} WHERE ${column("pages", "pageable_type")} = 'User' AND ${column("pages", "pageable_id")} = ${seller.id} AND ${column("pages", "slug")} IS NULL LIMIT 1`,
  );
  if (root && root.custom_html !== null) {
    if (root.content !== null || !isBlank(root.title))
      throw new HandBackToRails("the removal of the custom HTML of a profile page that has a title or content");
    await transaction(async () => {
      await execute(
        Prisma.sql`UPDATE ${table("pages")} SET ${column("pages", "custom_html")} = NULL, ${column("pages", "updated_at")} = ${new Date()} WHERE ${column("pages", "id")} = ${root.id}`,
      );
      await Users.touch(Users.load(seller), { deferred: true });
    });
  }
  return {
    status: SEE_OTHER,
    location: `${PAGES_PATH}/${PROFILE_SLUG}/edit`,
    flash: { notice: "Custom page removed — your profile is back on the default template." },
  };
}

// `current_seller.with_locked_seller_profile { |profile| profile.update(seo_params) }` for a seller whose profile row exists; a first
// save builds the row with its defaults, which is Rails'.
async function saveProfileSearchFields(input: MutationInput, seo: ReturnType<typeof seoParams>): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  if ((await findSellerProfile(seller.id)) === null)
    throw new HandBackToRails("a change to the search fields of a seller with no profile row");
  const editPath = `${PAGES_PATH}/${PROFILE_SLUG}/edit`;
  return Users.withLock(await findUserBang(seller.id), async () => {
    const owner = await findUserBang(seller.id);
    const profile = (await findSellerProfile(seller.id, { lock: true }))!;
    setSellerProfileTarget(owner, profile);
    for (const [name, value] of seo) profile.set(name, value);
    if (await SellerProfiles.save(profile)) {
      return { status: SEE_OTHER, location: editPath, flash: { notice: "Changes saved!" } };
    }
    const errors: Record<string, string> = {};
    for (const detail of profile.errors.details) errors[detail.attribute] ??= detail.message;
    return withErrors(editPath, errors);
  });
}

type Found = { profile: boolean; page: PageRow | null; sellerContext: SellerContext };

// RequireAccountEmail, `authenticate_user!`, `set_page` (a redirect to the list for an unknown slug) and the action's `authorize`.
async function guarded(
  input: MutationInput,
  query: (context: SellerContext) => boolean,
  slug: string | null,
): Promise<{ redirect: Redirected } | { found: Found }> {
  const state: { missing: boolean } = { missing: false };
  let found: Found | null = null;
  const redirect = await sellerGuard(guardInput(input), async (sellerContext) => {
    const profile = slug === PROFILE_SLUG;
    const page = slug === null || profile ? null : await slugged(sellerContext.seller!.id, slug);
    if (slug !== null && !profile && page === null) {
      state.missing = true;
      return;
    }
    authorize(query, sellerContext);
    found = { profile, page, sellerContext };
  });
  if (redirect !== null) return { redirect };
  // `rescued`: the before_action halts, so the after_action that sets the XSRF cookie does not run.
  if (state.missing) return { redirect: { status: FOUND, location: PAGES_PATH, rescued: true } };
  return { found: found! };
}

// `params[:title].to_s`: a scalar only; anything else is a string Ruby would inspect.
function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  throw new HandBackToRails("a title or content that is not text");
}

// `params.permit(:seo_title, :seo_description).to_h`, normalized by `squish.presence`.
function seoParams(params: Hash): Map<"seo_title" | "seo_description", string | null> {
  const seo = new Map<"seo_title" | "seo_description", string | null>();
  for (const key of ["seo_title", "seo_description"] as const) {
    if (!(key in params)) continue;
    const value = params[key];
    if (value !== null && typeof value !== "string") throw new HandBackToRails("a search field that is not text");
    const squished = value === null ? "" : squish(value);
    seo.set(key, squished === "" ? null : squished);
  }
  return seo;
}

const tooLong = (max: number) => `is too long (maximum is ${max} characters)`;

// `page.errors.to_hash.transform_values(&:first)` for a page with a blank title and content, in validation order. A page with
// any text goes through content moderation, which Node does not run.
function blankPageErrors(
  title: string,
  content: string,
  seo: ReturnType<typeof seoParams>,
): Redirected["inertiaErrors"] {
  if (!isBlank(title) || !isBlank(content))
    throw new HandBackToRails("a page with text, which is sanitized and moderated before it is saved");
  const errors: Record<string, string> = {};
  const seoTitle = seo.get("seo_title");
  const seoDescription = seo.get("seo_description");
  if (seoTitle && [...seoTitle].length > MAX_SEO_TITLE_LENGTH) errors.seo_title = tooLong(MAX_SEO_TITLE_LENGTH);
  if (seoDescription && [...seoDescription].length > MAX_SEO_DESCRIPTION_LENGTH)
    errors.seo_description = tooLong(MAX_SEO_DESCRIPTION_LENGTH);
  errors.title = "can't be blank";
  return errors;
}

const withErrors = (location: string, inertiaErrors: Redirected["inertiaErrors"]): Redirected => ({
  status: FOUND,
  location,
  inertiaErrors,
});

// POST /pages
async function create(input: MutationInput): Promise<ActionResult> {
  const result = await guarded(input, pagePolicy.create, null);
  if ("redirect" in result) return result.redirect;

  const title = rubyStrip(text(input.params.title));
  const content = text(input.params.content);
  return withErrors(NEW_PAGE_PATH, blankPageErrors(title, content, seoParams(input.params)));
}

// PATCH|PUT /pages/:slug
async function update(input: MutationInput): Promise<ActionResult> {
  const result = await guarded(input, pagePolicy.update, input.routeParams.slug ?? "");
  if ("redirect" in result) return result.redirect;
  const { profile, page } = result.found;

  if (profile) {
    // `if params[:remove_custom_html]` is Ruby truthiness; only a missing, null or false value reaches the SEO fields.
    const removal = input.params.remove_custom_html;
    if (removal !== undefined && removal !== null && removal !== false) return removeProfileTakeover(input);
    const seo = seoParams(input.params);
    if (seo.size === 0) return { status: FOUND, location: PAGES_PATH };
    return saveProfileSearchFields(input, seo);
  }

  const seo = seoParams(input.params);
  if (!isBlank(page!.custom_html))
    throw new HandBackToRails("a custom HTML page, whose title and content the editor does not write");
  const title = rubyStrip(text(input.params.title));
  const content = text(input.params.content);
  return withErrors(`${PAGES_PATH}/${input.routeParams.slug}/edit`, blankPageErrors(title, content, seo));
}

// DELETE /pages/:slug
async function destroy(input: MutationInput): Promise<ActionResult> {
  const result = await guarded(input, pagePolicy.destroy, input.routeParams.slug ?? "");
  if ("redirect" in result) return result.redirect;
  if (result.found.profile) return { status: FOUND, location: PAGES_PATH };
  // `@page.destroy!`, then `belongs_to :pageable, touch: true` touches the seller, which writes its paper_trail version.
  const seller = input.context.currentSeller!;
  await transaction(async () => {
    await execute(Prisma.sql`DELETE FROM ${table("pages")} WHERE ${column("pages", "id")} = ${result.found.page!.id}`);
    await Users.touch(Users.load(seller), { deferred: true });
  });
  return { status: SEE_OTHER, location: PAGES_PATH, flash: { notice: "Page deleted!" } };
}

const headNotFound: ActionResult = { status: NOT_FOUND, body: "", contentType: "text/html", paramsRead: true };

// GET /pages/:slug/preview
async function preview(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const result = await guarded(input, pagePolicy.preview, input.routeParams.slug ?? "");
  if ("redirect" in result) return result.redirect;
  const { profile, page, sellerContext } = result.found;

  const seller = sellerContext.seller!;
  const customHtml = profile ? await profileCustomHtml(seller.id) : page!.custom_html;
  if (isBlank(customHtml) && profile) return headNotFound;
  const record = Users.load(seller);
  const config = domainConfig(process.env);
  const customHeaders = {
    "Content-Security-Policy": customHtmlCsp(),
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
  };

  if (isBlank(customHtml)) {
    const [row] = await selectRows<{ title: string | null; seo_title: string | null; content: string | null }>(
      Prisma.sql`SELECT ${column("pages", "title")}, ${column("pages", "seo_title")}, ${column("pages", "content")} FROM ${table("pages")} WHERE ${column("pages", "id")} = ${page!.id}`,
    );
    // `current_seller.profile_url` is a URI of nil without a subdomain, which raises.
    const profileHref = subdomainWithProtocol(record);
    if (profileHref === null) throw new HandBackToRails("a seller with no profile subdomain");
    const body = richTextDocument({ page: row!, sellerName: nameOrUsername(record), profileHref, headExtra: "" });
    return { status: 200, body, contentType: HTML, paramsRead: true };
  }

  const fields = { name_or_username: nameOrUsername(record), bio: seller.bio };
  const tailwindHead = pagesTailwindHead(`${config.protocol}://${config.assetDomain}`);
  if (!profile) {
    const interpolated = interpolateProfile(customHtml!, { profile: fields });
    const body = pagePreviewDocument(interpolated, { tailwindHead });
    return { status: 200, body, contentType: HTML, paramsRead: true, optOutOfCsp: true, headers: customHeaders };
  }

  // The prices come from the visitor's IP and currency, which Rails derives.
  if (referencedInPrices(customHtml)) throw new HandBackToRails("a profile preview that references product prices");
  const interpolated = interpolateProfile(customHtml!, { profile: fields, prices: {} });
  const facts = await loadProfileDataFacts(
    { id: seller.id, username: seller.username, external_id: seller.external_id },
    input.chain.now,
  );
  const body = profileCustomHtmlDocument(interpolated, {
    dataJson: profileDataJson(facts),
    pricesJson: null,
    followBridge: FOLLOW_BRIDGE_SCRIPT,
    productsBridge: PRODUCTS_BRIDGE_SCRIPT,
    tailwindHead,
  });
  await enqueueRoutabilityRefresh(facts.routabilityRefresh);
  return {
    status: 200,
    body,
    contentType: HTML,
    paramsRead: true,
    optOutOfCsp: true,
    headers: { ...customHeaders, "Cache-Control": "private, no-store" },
  };
}

// GET /pages/:slug/products
async function products(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const result = await guarded(input, pagePolicy.products, input.routeParams.slug ?? "");
  if ("redirect" in result) return result.redirect;
  const { profile, sellerContext } = result.found;
  if (!profile) return headNotFound;
  const seller = sellerContext.seller!;
  const customHtml = await profileCustomHtml(seller.id);
  return customHtmlProductsSlice(
    { id: seller.id, username: seller.username, external_id: seller.external_id },
    customHtml,
    input.params,
    input.chain.now,
  );
}

registerMutations(
  { method: "POST", pattern: PAGES_PATH, run: create },
  { method: "PATCH", pattern: `${PAGES_PATH}/:slug`, run: update },
  { method: "PUT", pattern: `${PAGES_PATH}/:slug`, run: update },
  { method: "DELETE", pattern: `${PAGES_PATH}/:slug`, run: destroy },
  { method: "GET", pattern: `${PAGES_PATH}/:slug/preview`, skipForgeryProtection: true, run: preview },
  { method: "GET", pattern: `${PAGES_PATH}/:slug/products`, skipForgeryProtection: true, run: products },
);
