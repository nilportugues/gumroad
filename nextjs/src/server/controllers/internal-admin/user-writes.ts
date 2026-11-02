// Api::Internal::Admin::UsersController#create_comment (the admin note with an idempotency key). The other writes of the controller
// (risk state transitions, mail, Stripe, refunds, product take-downs, watchlists, 2FA) stay with Rails: the ported risk state
// machine does not yet reproduce Rails' side effects for them (see CONVERTING.md, WS-17e).
import { Prisma, type Comment } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { COMMENT_TYPES, Comments, normalizeContent } from "../../models/comment.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { type AdminRequest, failure, isBlank, jsonRendered, paramToS, recordAdminWrite, timeJson } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
const USER_ID_REQUIRED_MESSAGE = "user_id is required for mutating admin actions. Use /internal/admin/users/info to look up the user_id by email or username.";
const WRAPPER = { key: "user", model: "User" };

type WriteUser = { id: bigint; external_id: string | null; email: string | null };

const toSentence = (messages: string[]) => (messages.length <= 2 ? messages.join(" and ") : `${messages.slice(0, -1).join(", ")}, and ${messages.at(-1)}`);

// find_internal_admin_user_for_write_or_render
async function findUserForWrite(admin: AdminRequest, includeDeleted: boolean): Promise<{ user: WriteUser } | { refusal: ReturnType<typeof failure> }> {
  if (isBlank(admin.params.user_id)) return { refusal: failure(USER_ID_REQUIRED_MESSAGE, 400) };
  const user = await db.user.findFirst({ where: { ...(includeDeleted ? {} : { deleted_at: null }), external_id: paramToS(admin.params.user_id, SOURCE) }, select: { id: true, external_id: true, email: true } });
  if (user === null) return { refusal: failure("User not found", 404) };
  if (isBlank(admin.params.expected_email) || (user.email ?? "").toLowerCase() === paramToS(admin.params.expected_email, SOURCE).toLowerCase()) return { user };
  return { refusal: failure("expected_email does not match the user's current email", 409) };
}

async function serializeComment(comment: Comment) {
  const author = comment.author_id === null ? null : await db.user.findFirst({ where: { id: comment.author_id }, select: { name: true } });
  return {
    id: encrypt(comment.id),
    author_name: !isBlank(comment.author_name) ? comment.author_name : (author?.name ?? "System"),
    content: comment.content,
    comment_type: comment.comment_type,
    created_at: timeJson(comment.created_at),
    deleted_at: timeJson(comment.deleted_at),
    alive: comment.deleted_at === null,
  };
}

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/users/create_comment",
  run: async (admin) => {
    if (isBlank(admin.params.content)) return failure("content is required", 400);
    if (isBlank(admin.params.idempotency_key)) return failure("idempotency_key is required", 400);
    // Comments are an audit trail, so a soft-deleted account takes one too.
    const found = await findUserForWrite(admin, true);
    if ("refusal" in found) return found.refusal;
    const { user } = found;
    return recordAdminWrite(admin, { action: "users.create_comment", target: { type: "User", id: user.id, externalId: user.external_id }, wrapper: WRAPPER }, async () => {
      const content = paramToS(admin.params.content, SOURCE);
      const idempotencyKey = paramToS(admin.params.idempotency_key, SOURCE);
      const [existing] = await selectRows<Comment>(
        Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${column("comments", "commentable_id")} = ${user.id} AND ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "idempotency_key")} = ${idempotencyKey} LIMIT 1`,
      );
      if (existing !== undefined) {
        if (existing.content !== normalizeContent(content)) return failure("Idempotency key already used with different content", 409);
        return jsonRendered({ success: true, user_id: user.external_id, comment: await serializeComment(existing) });
      }
      const comment = await Comments.create({ commentable_id: user.id, commentable_type: "User", content, comment_type: COMMENT_TYPES.NOTE, author_id: admin.admin.actor.id, idempotency_key: idempotencyKey } as Partial<Comment>);
      if (!comment.persisted) return failure(toSentence(comment.errors.fullMessages()), 422);
      return jsonRendered({ success: true, user_id: user.external_id, comment: await serializeComment({ ...comment.attributes } as Comment) });
    });
  },
});
