// CommentsController#create, #update and #destroy (app/controllers/comments_controller.rb), for a signed-in visitor on a seller's
// host: the post's seller (and an admin or marketing team member) and the author of a comment.
//
// Left to Rails, before anything is written: a signed-out visitor, a purchase_id param or a visitor who bought the post's product
// (purchase-based access), a visitor who is neither the seller nor the author of a comment they create (User#visible_posts_for),
// a root comment that notifies the seller (mail), a comment that fails validation, and deleting a comment that has replies.
import { Prisma, type Comment, type Installment, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { THROTTLE_RULES } from "../infra/rack-attack-rules.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { autoLink } from "../html/rinku.ts";
import { CommentDeletable, Comments, COMMENT_TYPES } from "../models/comment.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { avatarUrl, displayName } from "../page-props/signed-in/presenters.ts";
import { timeAgoInWords } from "../page-props/storefront/time-ago.ts";
import { commentContextPolicy, type CommentContextRecord } from "../policies/comment-context.ts";
import { MembershipNotFoundError } from "../policies/seller-context.ts";
import { loadSellerContext, type SellerContext } from "../policies/seller-context.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const DEFAULT_COMMENT_AVATAR = "gumroad-default-avatar-5.png";
const LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer nofollow"';

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
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

type Row = Record<string, unknown>;

async function findById<T extends Row>(tableName: string, id: unknown): Promise<T | null> {
  if (id === null) return null;
  const [row] = await selectRows<T>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `Installment.published.find_by_external_id(id)`
async function findPost(externalId: string): Promise<Installment | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "published_at")} IS NOT NULL AND ${column("installments", "id")} = ${id} LIMIT 1`,
  );
  return row ? castRow<Installment>("Installment", row) : null;
}

type Prelude = { user: User; sellerContext: SellerContext; post: Installment };

// authenticate-less set_post, then set_purchase: the visitor's purchase decides what Rails would let them do, and none is ported.
async function prelude(input: MutationInput): Promise<Prelude | ActionResult> {
  const { context, routeParams } = input;
  const user = railsLoggedInUser(context);
  if (user === null || context.currentSeller === null) throw new HandBackToRails("a signed-out request");
  const post = await findPost(routeParams.post_id!);
  if (post === null) return { ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND), rescued: true };
  return { user, sellerContext: await loadSellerContext(context), post };
}

const isPrelude = (value: Prelude | ActionResult): value is Prelude => "post" in value && "sellerContext" in value;

// set_purchase: the post author needs none; anyone else gets the purchase they made of the post's product, which is not ported.
async function assertNoPurchase(input: MutationInput, { user, post }: Prelude): Promise<void> {
  if (input.context.currentSeller!.id === BigInt(post.seller_id ?? -1)) return;
  if ("purchase_id" in input.params) throw new HandBackToRails("a comment request with a purchase_id");
  if (post.link_id === null) return;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${user.id} AND ${column("purchases", "link_id")} = ${post.link_id} LIMIT 1`,
  );
  if (rows.length > 0) throw new HandBackToRails("a visitor who bought the post's product");
}

// `params.require(:comment).permit(...)`: a missing or blank comment raises ParameterMissing in Rails.
function commentParams(input: MutationInput): Record<string, unknown> {
  const comment = input.params.comment;
  if (comment === null || typeof comment !== "object" || Array.isArray(comment) || Object.keys(comment).length === 0)
    throw new HandBackToRails("a comment parameter that is not a populated hash");
  return comment as Record<string, unknown>;
}

// The attributes the policy reads, without touching the record's attribute order.
const snapshot = (comment: ModelRecord<Comment>): Comment => comment.untracked(() => comment.attributes) as Comment;

function commentContext(comment: Comment, post: Installment): CommentContextRecord {
  return {
    comment: { author_id: comment.author_id, purchase_id: comment.purchase_id, commentable_seller_id: post.seller_id },
    commentable: { seller_id: post.seller_id },
    purchase: null,
  };
}

// The refusal PunditAuthorization#default_user_not_authorized renders for a JSON request.
function refused(sellerContext: SellerContext): ActionResult {
  return { ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
}

function allowed(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (error instanceof MembershipNotFoundError) throw new HandBackToRails("a role the seller context cannot resolve");
    throw error;
  }
}

// CommentPresenter#comment_component_props
async function commentProps(comment: ModelRecord<Comment>, sellerContext: SellerContext, post: Installment) {
  const authorId = comment.get("author_id");
  const author = authorId === null ? null : await findById<User>("users", authorId);
  const content = comment.get("content") ?? "";
  const ancestry = comment.get("ancestry");
  const parentId = ancestry === null || ancestry === "" ? null : Number(ancestry.split("/").at(-1));
  const record = commentContext(snapshot(comment), post);
  const { assetHost, domainConfig } = await import("../page-props/domain.ts");
  return {
    id: encrypt(comment.get("id")),
    parent_id: parentId === null ? null : encrypt(parentId),
    author_id: author?.external_id ?? null,
    author_name: author ? displayName(author) : present(comment.get("author_name")) ? comment.get("author_name") : null,
    author_avatar_url: author
      ? await avatarUrl(author)
      : `${assetHost(domainConfig(process.env)) ?? ""}/images/${DEFAULT_COMMENT_AVATAR}`,
    purchase_id: null,
    content: { original: content, formatted: autoLink(escapeHtml(content), LINK_ATTRIBUTES) },
    depth: comment.get("ancestry_depth"),
    created_at: iso8601(comment.get("created_at")),
    created_at_humanized: `${timeAgoInWords(comment.get("created_at"))} ago`,
    is_editable: allowed(() => commentContextPolicy.update(sellerContext, record)),
    is_deletable: allowed(() => commentContextPolicy.destroy(sellerContext, record)),
  };
}

// `@post.comments.find_by_external_id(id)`
async function findComment(post: Installment, externalId: string): Promise<ModelRecord<Comment> | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${column("comments", "commentable_id")} = ${post.id} AND ${column("comments", "commentable_type")} = 'Installment' AND ${column("comments", "id")} = ${id} LIMIT 1`,
  );
  return row ? Comments.load(castRow<Comment>("Comment", row)) : null;
}

const NOT_FOUND_JSON = (): ActionResult => ({
  ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND),
  rescued: true,
});

async function create(input: MutationInput): Promise<ActionResult> {
  const found = await prelude(input);
  if (!isPrelude(found)) return found;
  const { user, sellerContext, post } = found;
  await assertNoPurchase(input, found);

  // build_post_comment
  const params = commentParams(input);
  if (typeof params.content !== "string" || (params.parent_id != null && typeof params.parent_id !== "string"))
    throw new HandBackToRails("a comment whose content or parent is not text");
  let ancestry: string | null = null;
  if (typeof params.parent_id === "string" && params.parent_id !== "") {
    const parentId = decrypt(params.parent_id);
    const parent = parentId === null ? null : await findById<Comment>("comments", parentId);
    if (parent)
      ancestry =
        parent.ancestry === null || parent.ancestry === "" ? String(parent.id) : `${parent.ancestry}/${parent.id}`;
  }
  const comment = Comments.build({
    commentable_id: post.id as never,
    commentable_type: "Installment",
    content: params.content,
    ancestry,
    author_id: user.id,
    author_name: displayName(user),
    comment_type: COMMENT_TYPES.USER_SUBMITTED,
  } as Partial<Comment>);

  if (!allowed(() => commentContextPolicy.create(sellerContext, commentContext(snapshot(comment), post))))
    return refused(sellerContext);
  // notify_seller_of_new_comment: a root comment by anyone but the post's seller mails the seller.
  if (ancestry === null && post.seller_id !== null && BigInt(post.seller_id) !== user.id)
    throw new HandBackToRails("a root comment that notifies the seller");
  if (!(await Comments.save(comment))) throw new HandBackToRails("a comment that fails validation");
  return jsonResponse({ success: true, comment: await commentProps(comment, sellerContext, post) });
}

async function update(input: MutationInput): Promise<ActionResult> {
  const found = await prelude(input);
  if (!isPrelude(found)) return found;
  const { sellerContext, post } = found;
  const comment = await findComment(post, input.routeParams.id!);
  if (comment === null) return NOT_FOUND_JSON();
  await assertNoPurchase(input, found);

  if (!allowed(() => commentContextPolicy.update(sellerContext, commentContext(snapshot(comment), post))))
    return refused(sellerContext);
  const params = commentParams(input);
  if (typeof params.content !== "string") throw new HandBackToRails("a comment whose content is not text");
  if (!(await Comments.update(comment, { content: params.content } as Partial<Comment>)))
    throw new HandBackToRails("a comment that fails validation");
  return jsonResponse({ success: true, comment: await commentProps(comment, sellerContext, post) });
}

async function destroy(input: MutationInput): Promise<ActionResult> {
  const found = await prelude(input);
  if (!isPrelude(found)) return found;
  const { sellerContext, post } = found;
  const comment = await findComment(post, input.routeParams.id!);
  if (comment === null) return NOT_FOUND_JSON();
  await assertNoPurchase(input, found);

  if (!allowed(() => commentContextPolicy.destroy(sellerContext, commentContext(snapshot(comment), post))))
    return refused(sellerContext);
  // mark_subtree_deleted! tags each reply it deletes in its json_data, which the Comment model leaves to Rails.
  const ancestry = comment.get("ancestry");
  const path = ancestry === null || ancestry === "" ? String(comment.get("id")) : `${ancestry}/${comment.get("id")}`;
  const replies = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("comments")} WHERE ${column("comments", "deleted_at")} IS NULL AND (${column("comments", "ancestry")} = ${path} OR ${column("comments", "ancestry")} LIKE ${`${path}/%`}) LIMIT 1`,
  );
  if (replies.length > 0) throw new HandBackToRails("a comment with replies");
  const deleted: string[] = [];
  if (comment.get("deleted_at") === null) {
    await CommentDeletable.markDeletedBang(comment);
    deleted.push(encrypt(comment.get("id")));
  }
  return jsonResponse({ success: true, deleted_comment_ids: deleted });
}

registerMutations(
  { method: "POST", pattern: "/posts/:post_id/comments", formats: ["json"], throttles: [THROTTLE_RULES.commentCreate], run: create },
  { method: "PUT", pattern: "/posts/:post_id/comments/:id", formats: ["json"], throttles: [THROTTLE_RULES.commentUpdate], run: update },
  { method: "DELETE", pattern: "/posts/:post_id/comments/:id", formats: ["json"], run: destroy },
);
