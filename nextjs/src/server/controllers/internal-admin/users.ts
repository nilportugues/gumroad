// Api::Internal::Admin::UsersController: the read endpoints that only need the user's own rows (#suspension, #credits, #comments).
// The rest of the controller drives state machines, mails and Stripe, and stays with Rails.
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { type AdminRequest, failure, isBlank, jsonRendered, paramToS } from "./base.ts";
import { paginateWithCursor } from "./cursor.ts";
import { defineAdminRoute } from "./registry.ts";

const SOURCE = "app/controllers/api/internal/admin/users_controller.rb";
const LOOKUP_BAD_REQUEST_MESSAGE = "email, user_id, or username is required";
const RISK_STATE_COMMENT_TYPES = ["compliant", "not_reviewed", "on", "flagged", "suspended"];
// Comment::COMMENT_TYPE_* in declaration order.
const VALID_COMMENT_TYPES = [
  "note",
  "user_submitted",
  "payout_note",
  "compliant",
  "on",
  "not_reviewed",
  "flagged",
  "flag_note",
  "suspended",
  "suspension_note",
  "balance_forfeited",
  "country_changed",
  "payouts_paused",
  "payouts_resumed",
  "refund_balance",
  "refund_all_for_fraud",
];
const SUSPENDED_STATES = ["suspended_for_tos_violation", "suspended_for_fraud"];
const FLAGGED_STATES = ["flagged_for_tos_violation", "flagged_for_fraud"];

type LookedUpUser = { id: bigint; external_id: string | null; user_risk_state: string | null };

const iso = (time: Date | null) => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

// find_internal_admin_user_for_read_or_render
async function findUserForRead(admin: AdminRequest, includeDeleted: boolean): Promise<{ user: LookedUpUser } | { refusal: ReturnType<typeof failure> }> {
  const userId = !isBlank(admin.params.user_id) ? admin.params.user_id : !isBlank(admin.params.external_id) ? admin.params.external_id : null;
  if (isBlank(admin.params.email) && userId === null && isBlank(admin.params.username)) return { refusal: failure(LOOKUP_BAD_REQUEST_MESSAGE, 400) };
  const alive = includeDeleted ? {} : { deleted_at: null };
  const select = { id: true, external_id: true, user_risk_state: true };
  let user: LookedUpUser | null;
  if (userId !== null) {
    user = await db.user.findFirst({ where: { ...alive, external_id: paramToS(userId, SOURCE) }, select });
  } else if (!isBlank(admin.params.email)) {
    user = await db.user.findFirst({ where: { ...alive, email: paramToS(admin.params.email, SOURCE) }, orderBy: { id: "asc" }, select });
  } else {
    const username = paramToS(admin.params.username, SOURCE);
    // Subdomain.find_seller_by_username scopes to live users either way for a seller; here the scope is the caller's.
    user = await db.user.findFirst({ where: { ...alive, username: username.replaceAll("-", "_") }, select });
    user ??= await db.user.findFirst({ where: { ...alive, external_id: username }, select });
  }
  return user === null ? { refusal: failure("User not found", 404) } : { user };
}

const successPayload = (user: LookedUpUser, payload: Record<string, unknown>) => ({ success: true, user_id: user.external_id, ...payload });

function parseCommentTypes(raw: unknown): string[] | ReturnType<typeof failure> {
  const text = paramToS(raw, SOURCE);
  if (isBlank(text)) return [];
  const values = text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => !isBlank(value));
  const invalid = values.filter((value) => !VALID_COMMENT_TYPES.includes(value));
  if (values.length === 0 || invalid.length > 0) return failure(`comment_type contains invalid value: ${invalid[0] ?? text}`, 400);
  return values;
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/users/suspension",
    run: async (admin) => {
      const found = await findUserForRead(admin, false);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const state = user.user_risk_state;
      const status = state !== null && SUSPENDED_STATES.includes(state) ? "Suspended" : state !== null && FLAGGED_STATES.includes(state) ? "Flagged" : "Compliant";
      const [latest] = await db.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM comments WHERE commentable_id = ${user.id} AND commentable_type = 'User' AND comment_type IN (${Prisma.join(RISK_STATE_COMMENT_TYPES)}) ORDER BY created_at DESC LIMIT 1`;
      return jsonRendered(successPayload(user, { status, updated_at: iso(latest?.created_at ?? null), appeal_url: null }));
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/credits",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      type Row = { id: number; amount_cents: number | null; reason: string | null; crediting_user_id: number | null; created_at_iso: string; created_at: Date };
      const page = await paginateWithCursor<Row>("credits", Prisma.sql`\`credits\`.\`user_id\` = ${user.id}`, admin.params, Prisma.raw("`credits`.`id`, `credits`.`amount_cents`, `credits`.`reason`, `credits`.`crediting_user_id`, `credits`.`created_at`"));
      if ("invalid" in page) return page.invalid;
      const crediting = page.rows.map((row) => row.crediting_user_id).filter((id): id is number => id !== null);
      const users = crediting.length === 0 ? [] : await db.user.findMany({ where: { id: { in: crediting } }, select: { id: true, external_id: true } });
      const externalIds = new Map(users.map((row) => [Number(row.id), row.external_id]));
      const credits = page.rows.map((row) => ({
        id: String(row.id),
        amount_cents: row.amount_cents,
        reason: row.reason,
        crediting_user_id: row.crediting_user_id === null ? null : (externalIds.get(row.crediting_user_id) ?? null),
        created_at: iso(row.created_at),
      }));
      return jsonRendered(successPayload(user, { credits, pagination: page.pagination }));
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/users/comments",
    run: async (admin) => {
      const found = await findUserForRead(admin, true);
      if ("refusal" in found) return found.refusal;
      const { user } = found;
      const types = parseCommentTypes(admin.params.comment_type);
      if (!Array.isArray(types)) return types;
      const typeFilter = types.length === 0 ? Prisma.empty : Prisma.sql`AND \`comments\`.\`comment_type\` IN (${Prisma.join(types)})`;
      type Row = { id: bigint; author_id: bigint | null; author_name: string | null; content: string | null; comment_type: string | null; created_at: Date; deleted_at: Date | null; created_at_iso: string };
      const page = await paginateWithCursor<Row>(
        "comments",
        Prisma.sql`\`comments\`.\`commentable_id\` = ${user.id} AND \`comments\`.\`commentable_type\` = 'User' ${typeFilter}`,
        admin.params,
        Prisma.raw("`comments`.`id`, `comments`.`author_id`, `comments`.`author_name`, `comments`.`content`, `comments`.`comment_type`, `comments`.`created_at`, `comments`.`deleted_at`"),
      );
      if ("invalid" in page) return page.invalid;
      const authorIds = [...new Set(page.rows.map((row) => row.author_id).filter((id): id is bigint => id !== null))];
      const authors = authorIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
      const names = new Map(authors.map((author) => [author.id, author.name]));
      const comments = page.rows.map((row) => ({
        id: encrypt(row.id),
        author_name: !isBlank(row.author_name) ? row.author_name : ((row.author_id === null ? null : names.get(row.author_id)) ?? "System"),
        content: row.content,
        comment_type: row.comment_type,
        created_at: iso(row.created_at),
        deleted_at: iso(row.deleted_at),
        alive: row.deleted_at === null,
      }));
      return jsonRendered(successPayload(user, { comments, pagination: page.pagination }));
    },
  },
);
