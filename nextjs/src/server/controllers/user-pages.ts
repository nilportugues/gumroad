// UserPagesController (app/controllers/user_pages_controller.rb): a seller's slugged pages, served at /<slug> on their own host.
//
// Ported: #show (a rich text page's document, a custom HTML page's sandboxed wrapper), #landing_iframe_content and #landing_version.
// Handed to Rails before any write:
//   - a slug no page of the seller has: other Rails routes on the seller's host share the one-segment shape, and Rails 404s the rest;
//   - a rich text page's share card when the seller has an avatar or a generated subscribe preview (Active Storage URLs).
import type { Page, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { classifyHost } from "../../lib/navigation/proxy/hosts.ts";
import { generateCspNonce } from "../infra/secure-headers.ts";
import { Users, nameOrUsername, subdomainWithProtocol } from "../models/user.ts";
import { formAuthenticityToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { avatarUrl } from "../page-props/signed-in/presenters.ts";
import { avatarAttachmentOf } from "../page-props/signed-in/reads.ts";
import { setNoindexForUnprovenStorefront } from "../page-props/storefront/profile-pages.ts";
import { sellerOfHost } from "../page-props/storefront/seller-host.ts";
import { customDomainByHost } from "../presenters/product-reads.ts";
import { customHtmlStoreHostnames } from "../services/custom-domain-hosts.ts";
import { documentTitleFor, richTextDocument } from "../services/pages-documents.ts";
import { interpolateProfile } from "../services/pages-interpolator.ts";

import { HandBackToRails, RoutingError, type ActionResult, type Rendered } from "./application-controller.ts";
import {
  customHtmlCsp,
  customHtmlNavigationBridgeScript,
  escapeHtml,
  pagesTailwindHead,
  themeBackgroundCss,
} from "./custom-html-document.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";
import { userPageEmbedDocument, userPageWrapperDocument } from "./user-page-documents.ts";

// The route constraint on /:slug (config/routes.rb), mirroring the model's slug format
const PAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HTML = "text/html; charset=utf-8";
const DEFAULT_BACKGROUND_COLOR = "#ffffff";

// Not a seller's host: the Gumroad domain routes `/:username/...` to UsersController.
export function isSellerHost(input: MutationInput): boolean {
  const host = classifyHost(input.request.host, domainConfig(process.env));
  return !host.gumroad && (host.sellerSubdomain !== null || host.customDomainLookup !== null);
}

type Located = { user: User; page: Page };

// set_user_by_domain, then set_page. `json` is for landing_version, which answers any format.
async function locate(input: MutationInput, slug: string): Promise<Located> {
  if (!isSellerHost(input)) throw new HandBackToRails("a request outside a seller's host");
  const user = await sellerOfHost(input.url);
  if (!PAGE_SLUG.test(slug)) throw new HandBackToRails("a slug the page route does not match");
  const page = await db.page.findFirst({
    where: { pageable_type: "User", pageable_id: user.id, slug },
    orderBy: { id: "asc" },
  });
  if (page === null) throw new HandBackToRails("a slug no page of the seller has");
  return { user, page };
}

function requireHtml(input: MutationInput): void {
  if (requestFormat(input.request) !== "html") throw new HandBackToRails("a request whose format is not HTML");
}

const emptyNotFound = (input: MutationInput): Rendered => ({
  status: 404,
  body: "",
  contentType: "text/html",
  paramsRead: true,
  headers: input.chain.headers.has("x-robots-tag") ? { "x-robots-tag": input.chain.headers.get("x-robots-tag")! } : {},
});

// ApplicationController#seller_custom_domain_url's test: UserCustomDomainRequestService.valid?
async function isUserCustomDomain(input: MutationInput): Promise<boolean> {
  const config = domainConfig(process.env);
  const custom = await customDomainByHost(input.request.host);
  return (
    !classifyHost(input.request.host, config).gumroad &&
    input.request.host !== config.validDiscoverRequestHost &&
    custom?.product_id == null
  );
}

// PageMeta::ShareCard.for(user): a generated preview or an uploaded avatar makes a card, whose URLs come from Active Storage.
async function assertNoShareCard(user: User): Promise<void> {
  const preview = await db.activeStorageAttachment.findFirst({
    where: { record_type: "User", record_id: user.id, name: "subscribe_preview" },
  });
  if (preview !== null || (await avatarAttachmentOf(user.id)) !== null)
    throw new HandBackToRails("a seller whose share card comes from Active Storage");
}

// UserPagesController#page_meta_head
async function pageMetaHead(input: MutationInput, user: User, page: Page): Promise<string> {
  await assertNoShareCard(user);
  const title = escapeHtml(page.seo_title ?? page.title ?? "");
  const canonical = escapeHtml(`${domainConfig(process.env).protocol}://${input.request.hostWithPort}/${page.slug}`);
  const favicon = escapeHtml(await avatarUrl(user));
  const description = isPresent(page.seo_description)
    ? [
        `<meta name="description" content="${escapeHtml(page.seo_description!)}">`,
        `<meta property="og:description" content="${escapeHtml(page.seo_description!)}">`,
      ].join("\n")
    : "";
  return [
    `<link rel="canonical" href="${canonical}">`,
    `<link rel="shortcut icon" href="${favicon}">`,
    `<link rel="apple-touch-icon" href="${favicon}">`,
    `<meta property="og:title" content="${title}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${canonical}">`,
    description,
    "",
    "",
  ].join("\n");
}

// UserPagesController#page_store_hostnames
async function pageStoreHostnames(input: MutationInput, user: User): Promise<string[]> {
  const config = domainConfig(process.env);
  const own = config.validRequestHosts.includes(input.request.host) ? [] : [input.request.host];
  return [...new Set([...own, ...(await customHtmlStoreHostnames(user, input.chain.now))])];
}

const owns = (input: MutationInput, user: User) =>
  input.context.currentSeller !== null && input.context.currentSeller.id === user.id;

// GET /:slug
export async function userPageShow(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const { user, page } = await locate(input, input.routeParams.slug ?? "");
  await setNoindexForUnprovenStorefront(input.chain, user);

  const record = Users.load(user);
  const sellerName = nameOrUsername(record);

  if (!isPresent(page.custom_html)) {
    const profileHref = (await isUserCustomDomain(input)) ? "/" : subdomainWithProtocol(record)!;
    const body = richTextDocument({
      page,
      sellerName,
      profileHref,
      headExtra: await pageMetaHead(input, user, page),
    });
    return { status: 200, body, contentType: HTML, paramsRead: true };
  }

  const nonce = generateCspNonce();
  const profile = await db.sellerProfile.findFirst({ where: { seller_id: user.id }, orderBy: { id: "asc" } });
  const config = domainConfig(process.env);
  const body = userPageWrapperDocument({
    slug: page.slug!,
    pageTitle: page.title,
    documentTitle: documentTitleFor({ pageTitle: page.title, sellerName, seoTitle: page.seo_title }),
    metaHead: await pageMetaHead(input, user, page),
    // SellerProfile#after_initialize defaults a missing colour
    themeBackgroundCss: themeBackgroundCss(
      profile === null ? DEFAULT_BACKGROUND_COLOR : (profile.background_color ?? DEFAULT_BACKGROUND_COLOR),
    ),
    storeHostnames: await pageStoreHostnames(input, user),
    validRequestHosts: config.validRequestHosts,
    sellerExternalId: user.external_id!,
    nonce,
    csrfToken: formAuthenticityToken(input.chain.csrfToken),
    liveReload: owns(input, user),
  });
  return { status: 200, body, contentType: HTML, paramsRead: true, cspNonce: nonce };
}

// GET /:slug/landing/embed
export async function userPageEmbed(input: MutationInput): Promise<ActionResult> {
  requireHtml(input);
  const { user, page } = await locate(input, input.routeParams.username ?? input.routeParams.slug ?? "");
  await setNoindexForUnprovenStorefront(input.chain, user);
  if (!isPresent(page.custom_html)) return emptyNotFound(input);

  const config = domainConfig(process.env);
  const interpolated = interpolateProfile(page.custom_html!, {
    profile: { name_or_username: nameOrUsername(Users.load(user)), bio: user.bio },
  });
  const body = userPageEmbedDocument(interpolated, {
    navigationBridge: customHtmlNavigationBridgeScript(await pageStoreHostnames(input, user), config.validRequestHosts),
    tailwindHead: pagesTailwindHead(`${config.protocol}://${config.assetDomain}`),
  });
  return {
    status: 200,
    body,
    contentType: HTML,
    paramsRead: true,
    optOutOfCsp: true,
    headers: {
      "Content-Security-Policy": customHtmlCsp(),
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
    },
  };
}

// GET /:slug/landing/version
export async function userPageVersion(input: MutationInput): Promise<ActionResult> {
  if (requestFormat(input.request) === "other")
    throw new HandBackToRails("a format whose content type is not modelled");
  let located: Located;
  try {
    located = await locate(input, input.routeParams.username ?? input.routeParams.slug ?? "");
  } catch (error) {
    if (error instanceof RoutingError && requestFormat(input.request) !== "html")
      throw new HandBackToRails("an unknown account requested as JSON");
    throw error;
  }
  const { user, page } = located;
  const visible = owns(input, user) && isPresent(page.custom_html);
  return json({ present: visible, version: visible ? Math.floor(page.updated_at.getTime() / 1000) : null });
}

registerMutations({ method: "GET", pattern: "/:slug", skipForgeryProtection: true, run: userPageShow });
