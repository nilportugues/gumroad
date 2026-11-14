// Api::Internal::Admin::StripeRestraintNoticesController#create: the per-actor token check, StripeRestraintNoticeService's validation
// and account lookup, and the real send (the notice comment and the queued mail). A dry-run preview renders the mailer, so it goes to
// Rails whole once it resolves a live seller.
import { createHash } from "node:crypto";

import { Prisma, type Comment } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { rubyStrip } from "../../content-moderation/ruby.ts";
import { enqueue } from "../../jobs/enqueue.ts";
import { COMMENT_TYPES, Comments, normalizeContent } from "../../models/comment.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { findUserBang, Users } from "../../models/user.ts";
import type { Rendered } from "../application-controller.ts";

import {
  failure,
  halted,
  jsonRendered,
  recordAdminWrite,
  requirePerActorToken,
  timeJson,
  type AdminRequest,
} from "./base.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";
import { toSentence } from "./user-writes.ts";

const SOURCE = "app/services/stripe_restraint_notice_service.rb";
const STRIPE_ACCOUNT_ID_FORMAT = /^acct_[A-Za-z0-9]{1,100}$/u;
const FIRM_EMAIL_FORMAT =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const NOTICE_KEY_FORMAT = /^[\x21-\x7E]{1,200}$/u;
const MAX_FIRM_NAME_LENGTH = 200;
const MAX_FIRM_EMAIL_LENGTH = 254;
const NOTICE_KEY_PREFIX = "stripe_restraint_notice";
const ACCEPTED_KEY_PREFIX = "stripe_restraint_notice_accepted";
const WRAPPER = { key: "stripe_restraint_notice" };
// Line breaks and invisible formatting characters such as bidi overrides.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

// string_param
const stringParam = (value: unknown) => (typeof value === "string" ? value : "");

// `params.key?(:dry_run) && cast(params[:dry_run]) == false`
const sendRequested = (params: AdminRequest["params"]) =>
  "dry_run" in params &&
  (params.dry_run === false ||
    params.dry_run === 0 ||
    (typeof params.dry_run === "string" && FALSE_VALUES.has(params.dry_run)));

class NoticeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Params = { accountId: string; firmName: string; firmEmail: string; noticeKey: string };

// StripeRestraintNoticeService#validate!, then #resolve_user: the live seller the notice is for.
async function resolveSeller(params: Params): Promise<{ sellerId: bigint } | Rendered> {
  const { accountId, firmName, firmEmail, noticeKey } = params;
  if (!STRIPE_ACCOUNT_ID_FORMAT.test(accountId))
    return failure("stripe_account_id must be a Stripe account id (acct_...)", 422);
  if (firmName === "") return failure("firm_name is required", 422);
  if ([...firmName].length > MAX_FIRM_NAME_LENGTH) return failure("firm_name is too long", 422);
  if (UNSAFE_CHARACTERS.test(firmName)) return failure("firm_name contains control characters", 422);
  if ([...firmEmail].length > MAX_FIRM_EMAIL_LENGTH || !FIRM_EMAIL_FORMAT.test(firmEmail))
    return failure("firm_email must be a single email address", 422);
  if (!NOTICE_KEY_FORMAT.test(noticeKey))
    return failure("notice_key must be 1-200 printable characters without spaces", 422);

  // The column's collation ignores case; Stripe ids do not.
  const accounts = await db.merchantAccount.findMany({
    where: { charge_processor_id: "stripe", charge_processor_merchant_id: accountId },
    select: { charge_processor_merchant_id: true, user_id: true },
  });
  const ownerIds = [
    ...new Set(
      accounts
        .filter((row) => row.charge_processor_merchant_id === accountId && row.user_id !== null)
        .map((row) => row.user_id!),
    ),
  ];
  if (ownerIds.length === 0) return failure(`No Gumroad account uses Stripe account ${accountId}`, 404);
  const live = await db.user.findMany({
    where: { id: { in: ownerIds }, deleted_at: null },
    select: { id: true, email: true },
  });
  if (live.length === 0) return failure(`The Gumroad account for ${accountId} is deleted`, 422);
  if (live.length > 1) return failure(`Stripe account ${accountId} belongs to more than one live Gumroad account`, 409);
  const unreachable = unreachableMessage(accountId, live[0]!.email);
  return unreachable === null ? { sellerId: live[0]!.id } : failure(unreachable, 422);
}

// ensure_reachable!
const unreachableMessage = (accountId: string, email: string | null) =>
  email === null || rubyStrip(email) === "" ? `The Gumroad account for ${accountId} has no email address` : null;

const noticeKeyDigest = (noticeKey: string) =>
  `${NOTICE_KEY_PREFIX}:${createHash("sha256").update(noticeKey).digest("hex")}`;

const noticeContent = ({ accountId, firmName, firmEmail, noticeKey }: Params) =>
  `Stripe court order notice for ${accountId}: Stripe paused this account's payouts under a court order. ` +
  `Queued an email to the seller with the law firm's contact: ${firmName} (${firmEmail}). Notice key: ${noticeKey}`;

// seller.comments.lock.find_by(idempotency_key:)
async function lockedComment(sellerId: bigint, idempotencyKey: string) {
  const [row] = await selectRows<Comment>(
    Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${column("comments", "commentable_id")} = ${sellerId} AND ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "idempotency_key")} = ${idempotencyKey} LIMIT 1 FOR UPDATE`,
  );
  return row;
}

// StripeRestraintNoticeService#perform
async function perform(params: Params, sellerId: bigint, actorId: bigint) {
  const seller = await findUserBang(sellerId);
  const digest = noticeKeyDigest(params.noticeKey);
  // The seller is locked before the comments, the same order as StripeRestraintNoticeEmailJob.
  return Users.withLock(seller, async () => {
    let comment = await lockedComment(sellerId, digest);
    if (comment !== undefined && comment.content !== normalizeContent(noticeContent(params)))
      throw new NoticeError("notice_key was already used for a different notice", 409);
    const accepted =
      comment === undefined ? undefined : await lockedComment(sellerId, `${ACCEPTED_KEY_PREFIX}:${comment.id}`);
    if (accepted === undefined) {
      const unreachable = unreachableMessage(params.accountId, seller.get("email") as string | null);
      if (unreachable !== null) throw new NoticeError(unreachable, 422);
      if (comment === undefined) {
        const created = await Comments.create({
          commentable_id: sellerId,
          commentable_type: "User",
          content: noticeContent(params),
          comment_type: COMMENT_TYPES.NOTE,
          author_id: actorId,
          idempotency_key: digest,
        } as Partial<Comment>);
        if (!created.persisted) throw new NoticeError(toSentence(created.errors.fullMessages()), 422);
        comment = { ...created.attributes } as Comment;
      }
      // Pushed before commit, so a push that fails rolls the new comment back; Rails then answers its own 503 and audits it.
      let jid: string | null = null;
      try {
        jid = await enqueue("StripeRestraintNoticeEmailJob", [
          Number(sellerId),
          Number(comment.id),
          params.firmName,
          params.firmEmail,
        ]);
      } catch {
        jid = null;
      }
      if (jid === null) return handBack("a notice email that could not be queued", SOURCE);
    }
    return { status: accepted === undefined ? "queued" : "already_sent", seller, comment: comment!, accepted };
  });
}

// notice_payload
function noticePayload(result: Awaited<ReturnType<typeof perform>>) {
  const { seller, comment, accepted, status } = result;
  return {
    success: true,
    status,
    already_sent: accepted !== undefined,
    delivery_status: accepted !== undefined ? "accepted" : "pending",
    accepted_at: accepted === undefined ? null : timeJson(accepted.created_at),
    user: { user_id: seller.get("external_id"), email: seller.get("email"), name: seller.get("name") },
    comment_id: encrypt(comment.id),
    comment: { content: comment.content, created_at: timeJson(comment.created_at) },
  };
}

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/stripe_restraint_notices",
  // A dry run writes nothing, so it skips the token's usage stamp too.
  recordsUse: sendRequested,
  run: async (admin) => {
    const unauthorized = requirePerActorToken(admin.admin);
    if (unauthorized !== null) return halted(unauthorized);
    const params: Params = {
      accountId: rubyStrip(stringParam(admin.params.stripe_account_id)),
      firmName: rubyStrip(stringParam(admin.params.firm_name)),
      firmEmail: rubyStrip(stringParam(admin.params.firm_email)),
      noticeKey: stringParam(admin.params.notice_key),
    };
    const resolved = await resolveSeller(params);
    if (!("sellerId" in resolved)) return resolved;
    if (!sendRequested(admin.params)) return handBack("a preview of a court order notice", SOURCE);
    const { sellerId } = resolved;
    const externalId = (await db.user.findUniqueOrThrow({ where: { id: sellerId }, select: { external_id: true } }))
      .external_id;
    return recordAdminWrite(
      admin,
      {
        action: "stripe_restraint_notices.create",
        target: { type: "User", id: sellerId, externalId },
        wrapper: WRAPPER,
      },
      async () => {
        try {
          return jsonRendered(noticePayload(await perform(params, sellerId, admin.admin.actor.id)));
        } catch (error) {
          if (error instanceof NoticeError) return failure(error.message, error.status);
          throw error;
        }
      },
    );
  },
});
