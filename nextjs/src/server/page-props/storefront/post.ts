// PostPresenter#post_component_props for a visitor who is not signed in, and the meta tags
// PostsController#show sets around it (PageMeta::Post, PageMeta::Favicon). A signed-in visitor, a
// `purchase_id` param and a post with files are left to Rails (see storefront-filters.ts): they need
// SellerContext-dependent visibility, purchase eligibility and UrlRedirect writes.
import { Prisma, type Installment, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { allElements, getAttribute, textContent } from "../../html/libxml2-tree.ts";
import { html4Fragment } from "../../html/loofah.ts";
import { autoLink } from "../../html/rinku.ts";
import { MAX_ALLOWED_DEPTH } from "../../models/comment.ts";
import { customStyles, withDefaults } from "../../models/seller-profile-styles.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { sellerProfile as loadSellerProfile, Users } from "../../models/user.ts";
import { loofahText, squish } from "../../search/plaintext.ts";
import type { MetaTagBuilder } from "../meta-tags.ts";
import { NotPortedError } from "../not-ported.ts";
import { creatorProfile } from "../settings/profile.ts";
import { avatarUrl, displayName } from "../signed-in/presenters.ts";

import { timeAgoInWords } from "./time-ago.ts";

export const AUDIENCE_TYPE = "audience";
// Installment flag 8, :shown_on_profile (flag_shih_tzu stores flag n as 2**(n - 1)).
const SHOWN_ON_PROFILE_FLAG = 2 ** 7;
const RECENT_UPDATES_LIMIT = 5;
const COMMENTS_PER_PAGE = 20;
const LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer nofollow"';
const SNIPPET_LENGTH = 150;
const DESCRIPTION_LENGTH = 255;
const OMISSION = "...";
const DEFAULT_COMMENT_AVATAR = "gumroad-default-avatar-5.png";

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// TextScrubber.format(text): `Loofah.fragment(text).to_text.strip`, with the special characters encoded.
// Both callers squish the result, which absorbs Loofah's whitespace clean-up.
function scrubbedText(message: string | null): string {
  if (message === null) throw new NotPortedError("TextScrubber.format(nil) raises in Loofah");
  return squish(
    loofahText(message)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\r", "&#13;"),
  );
}

// String#truncate(length): "..." included in the length, counted in characters.
function truncate(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length <= length ? text : `${chars.slice(0, length - OMISSION.length).join("")}${OMISSION}`;
}

// PostPresenter#snippet
export const postSnippet = (message: string | null) =>
  Array.from(scrubbedText(message)).slice(0, SNIPPET_LENGTH).join("");

// Installment#truncated_description
export const truncatedDescription = (message: string | null) => truncate(scrubbedText(message), DESCRIPTION_LENGTH);

// Post::SocialImage: the first <figure> that holds an <img>.
export function socialImage(message: string | null): { url: string | null; caption: string | null } {
  const empty = { url: null, caption: null };
  if (!present(message)) return empty;
  const figure = allElements(html4Fragment(message)).find(
    (element) => element.name === "figure" && allElements(element).some((child) => child.name === "img"),
  );
  if (!figure) return empty;
  const image = allElements(figure).find((element) => element.name === "img")!;
  const caption = allElements(figure).find((element) =>
    (getAttribute(element, "class") ?? "").split(/\s+/u).includes("figcaption"),
  );
  const src = getAttribute(image, "src");
  return { url: present(src ?? null) ? (src as string) : null, caption: caption ? textContent(caption) : null };
}

// `seller.installments.visible_on_profile`-style conditions shared by the visible posts of a visitor who
// is not signed in: User::Posts#visible_posts_for(shown_on_profile: false) keeps only the audience posts
// the seller shows on their profile, that are alive, published and not part of a workflow.
const publicPosts = (sellerId: number) =>
  Prisma.sql`${column("installments", "seller_id")} = ${sellerId} AND ${column("installments", "installment_type")} = ${AUDIENCE_TYPE} AND ${column("installments", "flags")} & ${SHOWN_ON_PROFILE_FLAG} > 0 AND ${column("installments", "workflow_id")} IS NULL AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL`;

// PostPresenter#e404? with no purchase: `visible_posts.exclude?(post)`
export async function isPostVisible(post: Installment): Promise<boolean> {
  if (post.seller_id === null) return false;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE ${column("installments", "id")} = ${post.id} AND ${publicPosts(post.seller_id)} LIMIT 1`,
  );
  return rows.length > 0;
}

type RecentPostRow = { name: string | null; slug: string | null; published_at: Date; message: string | null };

async function recentPosts(post: Installment, sellerId: number) {
  const rows = await selectRows<RecentPostRow>(
    Prisma.sql`SELECT ${column("installments", "name")}, ${column("installments", "slug")}, ${column("installments", "published_at")}, ${column("installments", "message")} FROM ${table("installments")} WHERE ${publicPosts(sellerId)}${post.link_id === null ? Prisma.empty : Prisma.sql` AND ${column("installments", "link_id")} = ${post.link_id}`} AND ${column("installments", "id")} <> ${post.id} ORDER BY ${column("installments", "published_at")} DESC LIMIT ${RECENT_UPDATES_LIMIT}`,
  );
  return rows.map((row) => ({
    name: row.name,
    slug: row.slug,
    published_at: row.published_at.toISOString(),
    truncated_description: truncatedDescription(row.message),
    purchase_id: null,
  }));
}

type CommentRow = {
  id: bigint;
  author_id: bigint | null;
  author_name: string | null;
  content: string | null;
  created_at: Date;
  ancestry: string | null;
  ancestry_depth: number;
};

// What CommentContextPolicy#update? and #destroy? answer for a visitor, per comment. The post page serves a signed-out visitor, for
// whom neither holds.
export type CommentPermissions = {
  editable(comment: { author_id: bigint | null }): boolean;
  deletable(comment: { author_id: bigint | null }): boolean;
};
const NO_PERMISSIONS: CommentPermissions = { editable: () => false, deletable: () => false };

// CommentPresenter#comment_component_props (no purchase is attached).
async function commentProps(comment: CommentRow, authors: Map<string, User>, permissions: CommentPermissions) {
  const author = comment.author_id === null ? undefined : authors.get(String(comment.author_id));
  const content = comment.content ?? "";
  const parentId =
    comment.ancestry === null || comment.ancestry === "" ? null : Number(comment.ancestry.split("/").at(-1));
  return {
    id: externalId(comment.id),
    parent_id: parentId === null ? null : externalId(parentId),
    author_id: author?.external_id ?? null,
    author_name: author ? displayName(author) : present(comment.author_name) ? comment.author_name : null,
    author_avatar_url: author ? await avatarUrl(author) : `${await assetImagePrefix()}/${DEFAULT_COMMENT_AVATAR}`,
    purchase_id: null,
    content: {
      original: content,
      formatted: autoLink(escapeHtml(content), LINK_ATTRIBUTES),
    },
    depth: comment.ancestry_depth,
    created_at: iso8601(comment.created_at),
    created_at_humanized: `${timeAgoInWords(comment.created_at)} ago`,
    is_editable: permissions.editable(comment),
    is_deletable: permissions.deletable(comment),
  };
}

// CGI.escapeHTML
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// Time#iso8601
const iso8601 = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

async function assetImagePrefix(): Promise<string> {
  const { assetHost, domainConfig } = await import("../domain.ts");
  return `${assetHost(domainConfig(process.env)) ?? ""}/images`;
}

// PaginatedCommentsPresenter#result
export async function paginatedComments(
  post: Installment,
  page: number,
  permissions: CommentPermissions = NO_PERMISSIONS,
) {
  const commentable = Prisma.sql`${column("comments", "commentable_type")} = 'Installment' AND ${column("comments", "commentable_id")} = ${post.id} AND ${column("comments", "deleted_at")} IS NULL`;
  const [totalRow] = await selectRows<{ total: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS total FROM ${table("comments")} WHERE ${commentable}`,
  );
  const count = Number(totalRow!.total);
  const [rootsRow] = await selectRows<{ roots: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS roots FROM ${table("comments")} WHERE ${commentable} AND ${column("comments", "ancestry")} IS NULL`,
  );
  const roots = rootsRow!.roots;
  const pages = Math.max(Math.ceil(Number(roots) / COMMENTS_PER_PAGE), 1);
  // Pagy raises OverflowError for a page past the last; Rails answers 404.
  if (page > pages) throw new NotPortedError("A comments page past the last (Pagy::OverflowError)");

  const rootRows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("comments", "id")} FROM ${table("comments")} WHERE ${commentable} AND ${column("comments", "ancestry")} IS NULL ORDER BY ${column("comments", "created_at")}, ${column("comments", "id")} LIMIT ${COMMENTS_PER_PAGE} OFFSET ${(page - 1) * COMMENTS_PER_PAGE}`,
  );
  let comments: CommentRow[] = [];
  if (rootRows.length > 0) {
    const subtree = rootRows.map(
      (root) =>
        Prisma.sql`(${column("comments", "id")} = ${root.id} OR ${column("comments", "ancestry")} = ${String(root.id)} OR ${column("comments", "ancestry")} LIKE ${`${root.id}/%`})`,
    );
    comments = await selectRows<CommentRow>(
      Prisma.sql`SELECT ${column("comments", "id")}, ${column("comments", "author_id")}, ${column("comments", "author_name")}, ${column("comments", "content")}, ${column("comments", "created_at")}, ${column("comments", "ancestry")}, ${column("comments", "ancestry_depth")} FROM ${table("comments")} WHERE ${commentable} AND (${Prisma.join(subtree, " OR ")}) AND ${column("comments", "ancestry_depth")} <= ${MAX_ALLOWED_DEPTH} ORDER BY ${column("comments", "created_at")}, ${column("comments", "id")}`,
    );
  }
  const authorIds = [
    ...new Set(comments.flatMap((comment) => (comment.author_id === null ? [] : [comment.author_id]))),
  ];
  const authors = new Map(
    (await db.user.findMany({ where: { id: { in: authorIds } } })).map((author) => [String(author.id), author]),
  );
  return {
    comments: await Promise.all(comments.map((comment) => commentProps(comment, authors, permissions))),
    count,
    pagination: {
      count: Number(roots),
      items: COMMENTS_PER_PAGE,
      page,
      pages,
      prev: page > 1 ? page - 1 : null,
      next: page < pages ? page + 1 : null,
      last: pages,
    },
  };
}

// Installment flag 11 (:allow_comments)
const ALLOW_COMMENTS_FLAG = 2 ** 10;

// Installment#subject
async function subject(post: Installment, seller: User): Promise<string> {
  if (present(post.name)) return post.name;
  const link = post.link_id === null ? null : await db.link.findFirst({ where: { id: post.link_id } });
  return `${link?.name ?? seller.name ?? "Creator"} - Update`;
}

export async function postProps(post: Installment, seller: User) {
  const sellerId = Number(seller.id);
  const hasPostsSection =
    (await db.sellerProfileSection.count({
      where: { seller_id: seller.id, product_id: null, type: "SellerProfilePostsSection" },
    })) > 0;
  const profile = await loadSellerProfile(Users.load(seller));
  return {
    creator_profile: await creatorProfile(seller, false),
    subject: await subject(post, seller),
    slug: post.slug,
    external_id: externalId(post.id),
    purchase_id: null,
    published_at: post.published_at?.toISOString() ?? null,
    message: autoLink(post.message ?? "", LINK_ATTRIBUTES),
    call_to_action:
      present(post.call_to_action_url) && present(post.call_to_action_text)
        ? { url: post.call_to_action_url, text: post.call_to_action_text }
        : null,
    download_url: null,
    has_posts_on_profile: hasPostsSection,
    recent_posts: await recentPosts(post, sellerId),
    paginated_comments: (post.flags & ALLOW_COMMENTS_FLAG) !== 0 ? await paginatedComments(post, 1) : null,
    comments_max_allowed_depth: MAX_ALLOWED_DEPTH,
    custom_styles: customStyles(
      withDefaults({
        font: profile.get("font"),
        background_color: profile.get("background_color"),
        highlight_color: profile.get("highlight_color"),
        border_radius: profile.get("border_radius"),
        button_hover: profile.get("button_hover"),
      }),
    ),
  };
}

// PageMeta::Post#set_post_page_meta
export function setPostPageMeta(meta: MetaTagBuilder, post: Installment) {
  const snippet = postSnippet(post.message);
  const image = socialImage(post.message);
  meta.set({ name: "description", content: snippet });
  meta.set({ property: "og:title", content: post.name });
  meta.set({ property: "og:description", content: snippet });
  if (present(image.url)) {
    meta.set({ property: "og:image", content: image.url });
    meta.set({ property: "og:image:alt", content: image.caption });
  }
  meta.set({ property: "twitter:title", content: post.name });
  meta.set({ property: "twitter:description", content: snippet });
  meta.set({ property: "twitter:domain", content: "Gumroad" });
  if (present(image.url)) {
    meta.set({ property: "twitter:card", content: "summary_large_image" });
    meta.set({ property: "twitter:image", content: image.url });
    meta.set({ property: "twitter:image:alt", content: image.caption });
  } else {
    meta.set({ property: "twitter:card", content: "summary" });
  }
}

// PageMeta::Favicon#set_favicon_meta_tags
export async function setFaviconMetaTags(meta: MetaTagBuilder, user: User) {
  const url = await avatarUrl(user);
  meta.set({ tag_name: "link", rel: "shortcut icon", href: url, head_key: "shortcut-icon" });
  meta.set({ tag_name: "link", rel: "apple-touch-icon", href: url, head_key: "apple-touch-icon" });
}

export { ALLOW_COMMENTS_FLAG };
