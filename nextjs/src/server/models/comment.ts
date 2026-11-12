// Port of app/models/comment.rb with the concerns it includes (Deletable, JsonData) and the
// callbacks of `has_ancestry cache_depth: true` (ancestry 4.3.3) and `has_paper_trail`, in the order
// Rails runs them. Golden: src/worker/jobs/__fixtures__/comment.golden.json, recorded from the real
// model (generate-comment-golden.rb).
//
// Refused with NotPortedError rather than approximated: destroy (ancestry's orphan strategy
// destroys the subtree), moving a persisted comment (descendants are rewritten after update),
// writing json_data on a persisted comment (JsonData's row merge), mark_subtree_(un)deleted!, and
// creating a root `user_submitted` comment on anything but a post (notify_seller_of_new_comment).
import { type Comment, Prisma } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { isAdult } from "./concerns/adult-keyword-detector.ts";
import { deletable } from "./concerns/deletable.ts";
import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { mergeJsonDataWithCurrentRow } from "./concerns/json-data.ts";
import { hasPaperTrail } from "./concerns/paper-trail.ts";
import { loadBelongsTo } from "./concerns/rails-validations.ts";
import { defineModel, type Callback, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import {
  isBlank,
  validatesFormatOf,
  validatesLengthOf,
  validatesNumericalityOf,
  validatesPresenceOf,
} from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError, UserFlags } from "./user.ts";

export type CommentRecord = ModelRecord<Comment>;

export const COMMENTS = "comments";

export const COMMENT_TYPES = {
  NOTE: "note",
  USER_SUBMITTED: "user_submitted",
  PAYOUT_NOTE: "payout_note",
  COMPLIANT: "compliant",
  ON_PROBATION: "on",
  NOT_REVIEWED: "not_reviewed",
  FLAGGED: "flagged",
  FLAG_NOTE: "flag_note",
  SUSPENDED: "suspended",
  SUSPENSION_NOTE: "suspension_note",
  BALANCE_FORFEITED: "balance_forfeited",
  COUNTRY_CHANGED: "country_changed",
  PAYOUTS_PAUSED: "payouts_paused",
  PAYOUTS_RESUMED: "payouts_resumed",
  REFUND_BALANCE: "refund_balance",
  REFUND_ALL_FOR_FRAUD: "refund_all_for_fraud",
} as const;
export const RISK_STATE_COMMENT_TYPES = [
  COMMENT_TYPES.COMPLIANT,
  COMMENT_TYPES.NOT_REVIEWED,
  COMMENT_TYPES.ON_PROBATION,
  COMMENT_TYPES.FLAGGED,
  COMMENT_TYPES.SUSPENDED,
] as const;
export const MAX_ALLOWED_DEPTH = 4;
const MAX_CONTENT_LENGTH = 10_000;

// ContentModeration::ModerateRecordService
export const CONTENT_MODERATION_AUTHOR_NAME = "ContentModeration";
export const CONTENT_MODERATION_ADMIN_COMMENT_DEDUP_WINDOW = { minutes: 5 } as const;

// The tables `commentable_object_exists` checks; any other commentable_type fails without a query.
const COMMENTABLE_TABLES: Record<string, string> = {
  Installment: "installments",
  Link: "links",
  Purchase: "purchases",
  User: "users",
};

// Ancestry.default_primary_key_format is "[0-9]+", joined by the "/" delimiter.
const ANCESTRY_FORMAT = /^[0-9]+(?:\/[0-9]+)*$/u;

// Ruby String#to_i: the leading integer, else 0.
function rubyToI(value: string): number {
  const match = /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
  return match ? Number.parseInt(match[0].replaceAll("_", ""), 10) : 0;
}

// MaterializedPath#parse_ancestry_column: split on "/", drop blanks, to_i each.
export function ancestorIds(record: CommentRecord): number[] {
  const ancestry = record.get("ancestry");
  if (ancestry == null) return [];
  return ancestry
    .split("/")
    .filter((part) => !isBlank(part))
    .map(rubyToI);
}

export const depth = (record: CommentRecord) => ancestorIds(record).length;
export const isRoot = (record: CommentRecord) => ancestorIds(record).length === 0;

// `text.strip.gsub(/(\R){3,}/, '\1\1')`. \R is atomic in Onigmo, so a CRLF is never split to make
// up the count; the lookahead-and-backreference keeps that in JavaScript.
const RUBY_STRIP_LEADING = /^[\0\t\n\v\f\r ]+/u;
const RUBY_STRIP_TRAILING = /[\0\t\n\v\f\r ]+$/u;
const THREE_OR_MORE_LINEBREAKS = /(?:(?=(\r\n|[\n\v\f\r\u0085\u2028\u2029]))\1){3,}/gu;

export function normalizeContent(text: string): string {
  return text
    .replace(RUBY_STRIP_LEADING, "")
    .replace(RUBY_STRIP_TRAILING, "")
    .replace(THREE_OR_MORE_LINEBREAKS, "$1$1");
}

const contentChanged = (record: CommentRecord) => record.attributeChanged("content");

function refuseUnported(record: CommentRecord): void {
  if (record.persisted && record.untracked(() => record.attributeChanged("ancestry")))
    throw new NotPortedError(
      "Moving a comment (ancestry's update_descendants_with_new_ancestry)",
      "ancestry 4.3.3 instance_methods.rb:9",
    );
  // Only a post answers `seller` the way notify_seller_of_new_comment reads it.
  if (
    record.newRecord &&
    record.get("comment_type") === COMMENT_TYPES.USER_SUBMITTED &&
    isRoot(record) &&
    record.get("commentable_type") !== "Installment"
  )
    throw new NotPortedError(
      "notify_seller_of_new_comment for a non-post commentable",
      "app/models/comment.rb:102 notify_seller_of_new_comment",
    );
}

// Ancestry#cache_depth, a before_validation and again a before_save.
const cacheDepth: Callback<Comment> = {
  name: "cache_depth",
  run(record) {
    record.set("ancestry_depth", depth(record));
  },
};

const author = { name: "author", foreignKey: "author_id", targetTable: "users", targetModel: "User" } as const;

async function commentableObjectExists(record: CommentRecord, ctx: CallbackContext): Promise<void> {
  const target = COMMENTABLE_TABLES[record.get("commentable_type") ?? ""];
  const id = record.get("commentable_id");
  // `Model.exists?(nil)` is false without a query.
  let exists = false;
  if (target && id != null) {
    const rows = await ctx.tx.$queryRaw<unknown[]>(
      Prisma.sql`SELECT 1 AS one FROM ${table(target)} WHERE ${column(target, "id")} = ${id} LIMIT 1`,
    );
    exists = rows.length > 0;
  }
  if (!exists) record.errors.add("base", "object to annotate does not exist");
}

async function contentCannotContainAdultKeywords(record: CommentRecord, ctx: CallbackContext): Promise<void> {
  const authorRow = await loadBelongsTo(record, author, ctx);
  if (authorRow && UserFlags.isSet(authorRow.flags as bigint, "is_team_member")) return;
  if (!authorRow && record.get("author_name") === CONTENT_MODERATION_AUTHOR_NAME) return;
  if (isAdult(record.get("content"))) record.errors.add("base", "Adult keywords are not allowed");
}

// `CommentMailer.notify_seller_of_new_comment(id).deliver_later`; swappable for tests.
export const commentMailer = {
  notifySellerOfNewComment: async (commentId: unknown): Promise<unknown> =>
    deliverLater(
      currentJobsRuntime(),
      { mailer: "CommentMailer", method: "notify_seller_of_new_comment", args: [Number(commentId)] },
      mailRoute("CommentMailer", "notify_seller_of_new_comment"),
    ),
};

// The belongs_to readers outside the transaction; a nil association raises NoMethodError in Ruby.
async function findOne(tableName: string, id: unknown, method: string): Promise<Record<string, unknown>> {
  const [row] =
    id == null
      ? []
      : await selectRows<Record<string, unknown>>(
          Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1`,
        );
  if (!row) throw new TypeError(`undefined method '${method}' for nil`);
  return row;
}

async function notifySellerOfNewComment(record: CommentRecord): Promise<void> {
  if (record.get("comment_type") !== COMMENT_TYPES.USER_SUBMITTED || !isRoot(record)) return;
  // refuseUnported keeps every other commentable out, so this is an Installment.
  const installment = await findOne("installments", record.get("commentable_id"), "seller");
  // authored_by_seller?: Integer == Integer, and nil == nil.
  const sellerId = installment.seller_id == null ? null : String(installment.seller_id);
  const authorId = record.get("author_id") == null ? null : String(record.get("author_id"));
  if (sellerId === authorId) return;
  const seller = await findOne("users", installment.seller_id, "disable_comments_email?");
  if (UserFlags.isSet(seller.flags as bigint, "disable_comments_email")) return;
  await commentMailer.notifySellerOfNewComment(record.get("id"));
}

const paperTrail = hasPaperTrail<Comment>("Comment", { itemType: "Comment" });

export const Comments = defineModel<Comment>({
  rubyClass: "Comment",
  prismaModel: "Comment",
  delegate: (tx) => tx.comment as never,
  beforeValidation: [{ name: "refuse what is not ported", run: refuseUnported }, cacheDepth],
  validations: [
    // has_ancestry
    validatesFormatOf<Comment>(["ancestry"], { with: ANCESTRY_FORMAT, allow_nil: true }),
    {
      name: "ancestry_exclude_self",
      run(record) {
        if (record.get("id") != null && ancestorIds(record).includes(Number(record.get("id"))))
          record.errors.add("base", "Comment cannot be a descendant of itself.");
      },
    },
    validatesNumericalityOf<Comment>(["ancestry_depth"], { greater_than_or_equal_to: 0, only_integer: true }),
    // comment.rb
    validatesPresenceOf<Comment>(["commentable_id", "commentable_type", "comment_type", "content"]),
    validatesLengthOf<Comment>(["content"], { maximum: MAX_CONTENT_LENGTH }),
    {
      name: "validates :depth, numericality: { only_integer: true, less_than_or_equal_to: MAX_ALLOWED_DEPTH }",
      on: "create",
      run(record) {
        const value = depth(record);
        if (value > MAX_ALLOWED_DEPTH)
          record.errors.add("depth", "less_than_or_equal_to", { count: MAX_ALLOWED_DEPTH, value });
      },
    },
    { name: "commentable_object_exists", on: "create", run: commentableObjectExists },
    { name: "content_cannot_contain_adult_keywords", if: contentChanged, run: contentCannotContainAdultKeywords },
    {
      name: "author_name_or_author_id_is_present",
      run(record) {
        if (isBlank(record.get("author_name")) && isBlank(record.get("author_id")))
          record.errors.add("base", "author_name or author_id must be present");
      },
    },
  ],
  beforeSave: [
    // Again here for save(validate: false), which skips before_validation.
    { name: "refuse what is not ported", run: refuseUnported },
    mergeJsonDataWithCurrentRow<Comment>("comments"),
    cacheDepth,
    {
      name: "trim_extra_newlines",
      if: contentChanged,
      run(record) {
        record.set("content", normalizeContent(record.get("content") ?? ""));
      },
    },
  ],
  afterCreate: [...paperTrail.afterCreate],
  afterUpdate: [...paperTrail.afterUpdate],
  afterCommit: [{ name: "notify_seller_of_new_comment", on: "create", run: notifySellerOfNewComment }],
  // ensure_json_data_fits_column only checks varchar columns (json_data is mediumtext) and
  // touch_ancestors_callback is off without `touch: true`; neither does anything here.
  beforeDestroy: [
    {
      name: "apply_orphan_strategy",
      run() {
        throw new NotPortedError(
          "Comment#destroy (ancestry's orphan strategy :destroy)",
          "ancestry 4.3.3 instance_methods.rb:24",
        );
      },
    },
    ...paperTrail.beforeDestroy,
  ],
});

export const CommentDeletable = deletable(Comments);

// `<commentable>.comments`: the polymorphic has_many conditions.
export function commentsOf(commentableType: string, commentableId: unknown): Prisma.Sql {
  return Prisma.sql`${column(COMMENTS, "commentable_id")} = ${commentableId} AND ${column(COMMENTS, "commentable_type")} = ${commentableType}`;
}

// Scopes, as the SQL fragments ActiveRecord appends.
export const withType = (commentType: string) => Prisma.sql`${column(COMMENTS, "comment_type")} = ${commentType}`;
export const alive = Prisma.sql`${column(COMMENTS, "deleted_at")} IS NULL`;
