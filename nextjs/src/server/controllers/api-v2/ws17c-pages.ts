// Api::V2::PagesController: the seller's slugged storefront pages. Reads are served here; the writes go through Page's sanitizer, moderation and
// the owner's `touch`, which stay in Rails once the request has passed the controller's own checks.
import type { Page, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { isConfirmed, Users } from "../../models/user.ts";
import { profileUrl } from "../../page-props/buyer/users.ts";
import { HandBackToRails, type ActionResult } from "../application-controller.ts";
import { authorize, halted, PUBLIC_READ_SCOPES, renderResponse, successWithObject, timeJson, type ApiCall } from "./ws17c-base.ts";

const SEO_PARAMS = ["seo_title", "seo_description"] as const;
// Page::MAX_CUSTOM_HTML_LENGTH
const MAX_CUSTOM_HTML_LENGTH = 500_000;
const CONFIRM_EMAIL_MESSAGE = "You have to confirm your email address before you can do that.";

// `current_resource_owner.pages`: slugged, oldest first.
const pagesOf = (owner: User) => db.page.findMany({ where: { pageable_type: "User", pageable_id: owner.id, slug: { not: null } }, orderBy: { created_at: "asc" } });

function metadata(owner: User, page: Pick<Page, "slug" | "title" | "created_at" | "updated_at">) {
  return {
    slug: page.slug,
    title: page.title ?? "",
    url: owner.username !== null && owner.username.trim() !== "" ? `${profileUrl(owner)}/${page.slug}` : null,
    created_at: timeJson(page.created_at),
    updated_at: timeJson(page.updated_at),
  };
}

const pageJson = (owner: User, page: Page) => ({ ...metadata(owner, page), content: page.content, custom_html: page.custom_html, seo_title: page.seo_title, seo_description: page.seo_description });

export async function index(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const pages = await pagesOf(auth.owner);
  return successWithObject("pages", call.params.metadata_only === "true" ? pages.map((page) => metadata(auth.owner, page)) : pages.map((page) => pageJson(auth.owner, page)));
}

// before_action :set_page
async function setPage(owner: User, slug: string) {
  return db.page.findFirst({ where: { pageable_type: "User", pageable_id: owner.id, slug }, orderBy: { created_at: "asc" } });
}

const pageNotFound = (): ActionResult => ({ ...renderResponse(false, { message: "The page was not found." }), rescued: true });

export async function show(call: ApiCall): Promise<ActionResult> {
  const auth = await authorize(call, PUBLIC_READ_SCOPES);
  if (halted(auth)) return auth.halt;
  const page = await setPage(auth.owner, call.routeParams.id!);
  if (page === null) return pageNotFound();
  const result: Record<string, unknown> = { page: pageJson(auth.owner, page) };
  if (call.params.source_only !== "true") {
    // Pages::RichTextDocument renders the page as a standalone document; a custom HTML page returns its stored HTML.
    if (page.custom_html === null || page.custom_html.trim() === "") throw new HandBackToRails("the rendered document of a rich text page");
    result.rendered_html = page.custom_html;
  }
  return renderResponse(true, result);
}

// #validate_content_params: a message to refuse with, or null.
async function contentParamsError(call: ApiCall, owner: User): Promise<string | null> {
  const { params } = call;
  if ("content" in params && "custom_html" in params) return "Send either content or custom_html, not both.";
  if ("content" in params && params.content !== null && typeof params.content !== "string") return "content must be a string.";
  for (const key of SEO_PARAMS) if (key in params && params[key] !== null && typeof params[key] !== "string") return `${key} must be a string.`;
  if ("custom_html" in params) {
    if (params.custom_html !== null && typeof params.custom_html !== "string") return "custom_html must be a string.";
    if (!(await isFeatureEnabled("custom_html_pages", userActor(owner.id)))) return "You do not have access to custom HTML pages.";
    if ([...String(params.custom_html ?? "")].length > MAX_CUSTOM_HTML_LENGTH) return `custom_html is too long (maximum is ${MAX_CUSTOM_HTML_LENGTH} characters).`;
  }
  return null;
}

// before_actions of the writes: edit_profile (and the scope itself, not the `account` fallback), then a confirmed email.
async function authorizeWrite(call: ApiCall) {
  const auth = await authorize(call, ["edit_profile"], { requireScope: ["edit_profile"] });
  if (halted(auth)) return auth;
  if (!isConfirmed(Users.load(auth.owner))) return { halt: { ...renderResponse(false, { message: CONFIRM_EMAIL_MESSAGE }), rescued: true } };
  return auth;
}

export async function create(call: ApiCall): Promise<ActionResult> {
  const auth = await authorizeWrite(call);
  if (halted(auth)) return auth.halt;
  const { title } = call.params;
  if (typeof title !== "string" || title.trim() === "") return renderResponse(false, { message: "title is required." });
  const error = await contentParamsError(call, auth.owner);
  if (error) return renderResponse(false, { message: error });
  // Page.generate_slug_for, the sanitizer and the content moderation run in Rails.
  throw new HandBackToRails("a page write");
}

export async function update(call: ApiCall): Promise<ActionResult> {
  const auth = await authorizeWrite(call);
  if (halted(auth)) return auth.halt;
  const page = await setPage(auth.owner, call.routeParams.id!);
  if (page === null) return pageNotFound();
  const error = await contentParamsError(call, auth.owner);
  if (error) return renderResponse(false, { message: error });
  throw new HandBackToRails("a page write");
}

export async function destroy(call: ApiCall): Promise<ActionResult> {
  const auth = await authorizeWrite(call);
  if (halted(auth)) return auth.halt;
  const page = await setPage(auth.owner, call.routeParams.id!);
  if (page === null) return pageNotFound();
  // Destroying a page touches its owner, which runs the user's commit callbacks.
  throw new HandBackToRails("a page deletion");
}
