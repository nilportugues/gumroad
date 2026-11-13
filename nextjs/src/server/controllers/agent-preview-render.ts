// AgentCustomHtmlPreviewsController#create from the point it holds the resulting page: sanitize, mark, interpolate, wrap in the sandboxed
// document and stage it in Redis. Every step before the staging only reads, so a NotPortedError from any of them (the sanitizer, the
// profile payload, the interpolator) reaches Rails with nothing written.
import { randomBytes } from "node:crypto";

import { db } from "../../lib/db.ts";
import { rubyBlank as blank, sanitizeWithReport } from "../ai/page-sanitizer.ts";
import { type ParentNode, removeNode } from "../html/libxml2-tree.ts";
import { fragmentToHtml, html4Fragment } from "../html/loofah.ts";
import { getRedis } from "../infra/redis.ts";
import { domainConfig, assetHost } from "../page-props/domain.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { enqueueRoutabilityRefresh } from "../services/custom-domain-hosts.ts";

import { avatarAttachmentOf } from "../page-props/signed-in/reads.ts";
import { defaultProfileDocument } from "../services/pages-default-profile-document.ts";
import { interpolateProfile } from "../services/pages-interpolator.ts";
import { referencedInPrices } from "../services/pages-product-prices.ts";
import { loadProfileDataFacts, profileDataJson } from "../services/pages-profile-data.ts";

import { PREVIEW_CHANGED_MARKER_TEXT, pagesTailwindHead, profileCustomHtmlDocument } from "./custom-html-document.ts";

// AgentCustomHtmlPreviewsController::PREVIEW_DOCUMENT_TTL (24.hours) and MAX_STAGED_PREVIEWS_PER_SELLER
const PREVIEW_DOCUMENT_TTL_SECONDS = 24 * 60 * 60;
const MAX_STAGED_PREVIEWS_PER_SELLER = 20;
// SecureRandom.urlsafe_base64(24)
const TOKEN_BYTES = 24;

export type PreviewSeller = {
  id: bigint;
  name: string | null;
  username: string | null;
  external_id: string | null;
  bio: string | null;
};

// User#username and User#name_or_username
const usernameOf = (seller: PreviewSeller) => (blank(seller.username) ? seller.external_id : seller.username);
const nameOrUsername = (seller: PreviewSeller) => (blank(seller.name) ? usernameOf(seller) : seller.name);

// strip_preview_markers: the page with every marker comment removed, reserialized.
function stripPreviewMarkers(html: string): string {
  const fragment = html4Fragment(html);
  const visit = (parent: ParentNode) => {
    for (const child of [...parent.children]) {
      if (child.type === "element") visit(child);
      if (child.type === "comment" && child.content === PREVIEW_CHANGED_MARKER_TEXT) removeNode(child);
    }
  };
  visit(fragment);
  return fragmentToHtml(fragment);
}

// marked_preview_html: the marker-carrying variant is served only when, markers aside, it sanitizes to exactly the published page.
function markedPreviewHtml(sanitized: string, markedHtml: string | null): [string, boolean] {
  if (markedHtml === null) return [sanitized, false];
  const sanitizedMarked = sanitizeWithReport(markedHtml).html;
  if (stripPreviewMarkers(sanitizedMarked) !== stripPreviewMarkers(sanitized)) return [sanitized, false];
  return [sanitizedMarked, true];
}

// The Redis side of stage_preview_document; returns internal_agent_custom_html_preview_document_path(token).
async function stageDocument(sellerId: bigint, document: string): Promise<string> {
  const redis = getRedis("main");
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const indexKey = `agent_custom_html_preview_index:${sellerId}`;
  await redis.set(`agent_custom_html_preview:${sellerId}:${token}`, document, "EX", PREVIEW_DOCUMENT_TTL_SECONDS);
  await redis.lpush(indexKey, token);
  await redis.expire(indexKey, PREVIEW_DOCUMENT_TTL_SECONDS);
  // Read what is trimmed in one MULTI so a concurrent stage cannot slip between the two.
  const answers = await redis
    .multi()
    .lrange(indexKey, MAX_STAGED_PREVIEWS_PER_SELLER, -1)
    .ltrim(indexKey, 0, MAX_STAGED_PREVIEWS_PER_SELLER - 1)
    .exec();
  const evicted = (answers?.[0]?.[1] ?? []) as string[];
  if (evicted.length > 0) await redis.del(...evicted.map((old) => `agent_custom_html_preview:${sellerId}:${old}`));
  return `/internal/agent/custom_html_previews/${token}`;
}

// create, once `resulting_custom_html` produced a page. Returns the preview URL.
export async function stagePreview(
  seller: PreviewSeller,
  resultingHtml: string,
  markedHtml: string | null,
): Promise<string> {
  const sanitized = sanitizeWithReport(resultingHtml).html;
  // A page that sanitizes down to nothing unpublishes: previewed as the default storefront.
  if (blank(sanitized)) return stageClearedPreview(seller);

  const [displayHtml, scrollToChange] = markedPreviewHtml(sanitized, markedHtml);
  if (referencedInPrices(sanitized)) throw new NotPortedError("Pages::ProductPrices.build");
  const interpolated = interpolateProfile(displayHtml, {
    profile: { name_or_username: nameOrUsername(seller), bio: seller.bio },
    prices: {},
  });
  const facts = await loadProfileDataFacts(seller, new Date());
  const dataJson = profileDataJson(facts);
  const { protocol, assetDomain } = domainConfig(process.env);
  const document = profileCustomHtmlDocument(interpolated, {
    dataJson,
    pricesJson: null,
    scrollToChange,
    tailwindHead: pagesTailwindHead(`${protocol}://${assetDomain}`),
  });
  await enqueueRoutabilityRefresh(facts.routabilityRefresh);
  return stageDocument(seller.id, document);
}

const DEFAULT_AVATAR = "gumroad-default-avatar-5.png";

// render_cleared_page_preview: a proposal that unpublishes the page previews as the default storefront. Only a seller who lists nothing
// and has no uploaded avatar is rendered here (see pages-default-profile-document.ts); the checks read before anything is staged.
export async function stageClearedPreview(seller: PreviewSeller): Promise<string> {
  const profile = await db.sellerProfile.findFirst({ where: { seller_id: seller.id }, orderBy: { id: "asc" } });
  // Pages::ProfileData.build, which the document reads: lists products and posts, so it throws for a seller who has any.
  const facts = await loadProfileDataFacts(seller, new Date());
  profileDataJson(facts);
  await enqueueRoutabilityRefresh(facts.routabilityRefresh);
  if (await avatarAttachmentOf(seller.id)) throw new NotPortedError("User#avatar_url of an uploaded avatar");
  const document = defaultProfileDocument({
    nameOrUsername: nameOrUsername(seller),
    bio: seller.bio,
    avatarUrl: `${assetHost(domainConfig(process.env)) ?? ""}/images/${DEFAULT_AVATAR}`,
    profile: profile && { background_color: profile.background_color, highlight_color: profile.highlight_color },
  });
  return stageDocument(seller.id, document);
}
