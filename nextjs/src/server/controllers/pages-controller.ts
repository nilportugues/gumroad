// The write and preview actions of PagesController (app/controllers/pages_controller.rb); #index, #new and #edit are pages
// (page-props/seller-pages.ts).
//
// Ported: the RequireAccountEmail and `set_page` redirects, the policy refusals, the validation errors of #create and #update for a
// page whose title and content are both blank (moderation returns before it calls the service), #update of the profile entry
// when it has nothing to write, #destroy (the row and the touch of the seller; the profile entry has nothing to delete), and the
// 404 of #preview and #products for a profile with no custom HTML or a page that is not the profile.
// Handed to Rails whole, before any write: a save that passes validation (HTML sanitizing, content moderation, the slug), any
// change to the profile entry, and the rendered preview and catalogue slices.
import { Prisma } from "@prisma/client";

import { isBlank } from "../models/compliance-countries.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, execute, selectRows, table } from "../models/sql.ts";
import { rubyStrip, Users } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { pagePolicy } from "../policies/page.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { squish } from "../search/plaintext.ts";

import { HandBackToRails, type ActionResult, type Redirected } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requireHtml } from "./users-controller.ts";

const FOUND = 302;
const SEE_OTHER = 303;
const NOT_FOUND = 404;
const PAGES_PATH = "/pages";
const NEW_PAGE_PATH = "/pages/new";
const PROFILE_SLUG = "profile";
// Page::MAX_SEO_TITLE_LENGTH, MAX_SEO_DESCRIPTION_LENGTH and MAX_CONTENT_LENGTH
const MAX_SEO_TITLE_LENGTH = 70;
const MAX_SEO_DESCRIPTION_LENGTH = 320;

type Hash = Record<string, unknown>;

type PageRow = { id: bigint; custom_html: string | null };

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
    if (removal !== undefined && removal !== null && removal !== false)
      throw new HandBackToRails("the removal of the custom HTML of the profile, which writes the user");
    if (seoParams(input.params).size === 0) return { status: FOUND, location: PAGES_PATH };
    throw new HandBackToRails("a change to the search fields of the profile, which writes the seller profile");
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

  const customHtml = profile ? await profileCustomHtml(sellerContext.seller!.id) : page!.custom_html;
  if (isBlank(customHtml) && profile) return headNotFound;
  throw new HandBackToRails("a rendered page preview");
}

// GET /pages/:slug/products
async function products(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const result = await guarded(input, pagePolicy.products, input.routeParams.slug ?? "");
  if ("redirect" in result) return result.redirect;
  if (!result.found.profile) return headNotFound;
  throw new HandBackToRails("the catalogue slices of the profile preview");
}

registerMutations(
  { method: "POST", pattern: PAGES_PATH, run: create },
  { method: "PATCH", pattern: `${PAGES_PATH}/:slug`, run: update },
  { method: "PUT", pattern: `${PAGES_PATH}/:slug`, run: update },
  { method: "DELETE", pattern: `${PAGES_PATH}/:slug`, run: destroy },
  { method: "GET", pattern: `${PAGES_PATH}/:slug/preview`, skipForgeryProtection: true, run: preview },
  { method: "GET", pattern: `${PAGES_PATH}/:slug/products`, skipForgeryProtection: true, run: products },
);
