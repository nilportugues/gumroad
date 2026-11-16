// Port of app/sidekiq/detect_failing_paypal_rails_job.rb: for each connected PayPal merchant account, counts the payee-side failed
// purchases of the last 7 days (grouped per account, at least 20, none completed) and leaves one admin note per account and week on
// the seller, under the user's row lock. An account whose note cannot be written is reported and the rest carry on.
// Golden: __fixtures__/detect-failing-paypal-rails-job.golden.json (scripts/golden/detect-failing-paypal-rails-job.rb).
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { COMMENT_TYPES, COMMENTS, commentsOf, Comments, withType } from "../../server/models/comment.ts";
import { ago, truncateToSeconds } from "../../server/models/concerns/ruby-time.ts";
import { findById } from "../../server/models/row-reads.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const AUTHOR_NAME = "failing-paypal-rail";
const LOOKBACK = { days: 7 } as const;
const MIN_FAILED_ATTEMPTS = 20;
const BATCH_SIZE = 500;
// PurchaseErrorCode::PAYPAL_PAYEE_COMPLIANCE_VIOLATION and PAYPAL_MERCHANT_ACCOUNT_RESTRICTED
const PAYEE_ERROR_CODE = "paypal_payee_compliance_violation";
const PAYEE_STRIPE_ERROR_CODE = "paypal_merchant_account_restricted";
const PAYPAL = "paypal";
const MERCHANT_ACCOUNTS = "merchant_accounts";
const PURCHASES = "purchases";

type AccountRow = { id: bigint; user_id: bigint; charge_processor_merchant_id: string | null };
type NoteInput = { userId: bigint; content: string };
export type DetectFailingPaypalRailsDeps = {
  notify: (error: unknown, context: Record<string, unknown>) => void;
  // `user.comments.create!` for the note
  createNote: (input: NoteInput, now: () => Date) => Promise<unknown>;
};

// `MerchantAccount.paypal.alive.charge_processor_alive.where.not(user_id: nil)`
const CONNECTED = Prisma.sql`${column(MERCHANT_ACCOUNTS, "charge_processor_id")} = ${PAYPAL} AND ${column(MERCHANT_ACCOUNTS, "deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_alive_at")} IS NOT NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "user_id")} IS NOT NULL`;

// Comment.sanitize_sql_like
const sanitizeLike = (text: string) => text.replace(/[\\%_]/gu, (char) => `\\${char}`);

const defaultDeps: DetectFailingPaypalRailsDeps = {
  notify: (error, context) => notifyError(error, context),
  createNote: ({ userId, content }, now) =>
    Comments.createBang(
      {
        commentable_id: userId,
        commentable_type: "User",
        author_name: AUTHOR_NAME,
        comment_type: COMMENT_TYPES.NOTE,
        content,
      },
      { now },
    ),
};

export const detectFailingPaypalRailsJobWith = (
  overrides: Partial<JobDeps> = {},
  detectOverrides: Partial<DetectFailingPaypalRailsDeps> = {},
) => {
  const detect = { ...defaultDeps, ...detectOverrides };
  return modelJob({ min: 0 }, async (_args, deps) => {
    const now = deps.now();
    const windowStart = truncateToSeconds(ago(LOOKBACK, now));
    const windowEnd = truncateToSeconds(now);
    const inWindow = Prisma.sql`${column(PURCHASES, "charge_processor_id")} = ${PAYPAL} AND ${column(PURCHASES, "created_at")} BETWEEN ${windowStart} AND ${windowEnd}`;

    // user.with_lock: the dedup check and the insert are atomic across jobs for different accounts of one seller.
    async function noteFailingRail(account: AccountRow, failedCount: number): Promise<void> {
      const user = await findById("User", account.user_id);
      if (user === null) return;
      const marker = `(${account.charge_processor_merchant_id})`;
      const content = `PayPal account ${marker} had ${failedCount} failed PayPal payee-side purchase attempts and no completed purchases in the last 7 days. Review the connected PayPal rail.`;
      await transaction(async () => {
        const [locked] = await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${account.user_id} LIMIT 1 FOR UPDATE`,
        );
        if (!locked) throw new Error(`Couldn't find User with 'id'=${String(account.user_id)}`);
        const since = ago(LOOKBACK, deps.now());
        const [existing] = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table(COMMENTS)} WHERE ${commentsOf("User", account.user_id)} AND ${withType(COMMENT_TYPES.NOTE)} AND ${column(COMMENTS, "author_name")} = ${AUTHOR_NAME} AND (content LIKE ${`%${sanitizeLike(marker)}%`}) AND (created_at > ${since}) LIMIT 1`,
        );
        if (existing) return;
        await detect.createNote({ userId: account.user_id, content }, deps.now);
      });
    }

    async function noteFailingAccounts(accounts: AccountRow[]): Promise<void> {
      const accountIds = accounts.map((account) => account.id);
      const sellerIds = accounts.map((account) => account.user_id);
      // seller_id keeps the query on the (seller_id, purchase_state, created_at) index.
      const failed = await selectRows<{ count_all: bigint | number; purchases_merchant_account_id: bigint }>(
        Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`count_all`")}, ${column(PURCHASES, "merchant_account_id")} AS ${Prisma.raw("`purchases_merchant_account_id`")} FROM ${table(PURCHASES)} WHERE ${inWindow} AND ${columnIn(PURCHASES, "seller_id", sellerIds)} AND ${column(PURCHASES, "purchase_state")} = 'failed' AND ${columnIn(PURCHASES, "merchant_account_id", accountIds)} AND (${column(PURCHASES, "error_code")} = ${PAYEE_ERROR_CODE} OR ${column(PURCHASES, "stripe_error_code")} = ${PAYEE_STRIPE_ERROR_CODE}) GROUP BY ${column(PURCHASES, "merchant_account_id")} HAVING (COUNT(*) >= ${String(MIN_FAILED_ATTEMPTS)})`,
      );
      if (failed.length === 0) return;
      const failedCounts = new Map(
        failed.map((row) => [BigInt(row.purchases_merchant_account_id), Number(row.count_all)]),
      );

      const failingAccounts = accounts.filter((account) => failedCounts.has(BigInt(account.id)));
      // merchant_account_id is unindexed, so narrow to the failing accounts' sellers before filtering on it.
      const completed = await selectRows<{ merchant_account_id: bigint }>(
        Prisma.sql`SELECT DISTINCT ${column(PURCHASES, "merchant_account_id")} FROM ${table(PURCHASES)} WHERE ${inWindow} AND ${columnIn(
          PURCHASES,
          "seller_id",
          failingAccounts.map((account) => account.user_id),
        )} AND ${column(PURCHASES, "purchase_state")} = 'successful' AND ${columnIn(PURCHASES, "merchant_account_id", [...failedCounts.keys()])}`,
      );
      const completedIds = new Set(completed.map((row) => BigInt(row.merchant_account_id)));
      const noteIds = [...failedCounts.keys()].filter((id) => !completedIds.has(id));
      // `where(id: [])` is a null relation: Rails sends no statement.
      if (noteIds.length === 0) return;

      // Re-query so an account disconnected while the batch ran is not noted from a stale object.
      const current = await selectRows<AccountRow>(
        Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table(MERCHANT_ACCOUNTS)} WHERE ${CONNECTED} AND ${columnIn(MERCHANT_ACCOUNTS, "id", noteIds)}`,
      );
      for (const account of current) {
        try {
          await noteFailingRail(account, failedCounts.get(BigInt(account.id))!);
        } catch (error) {
          // One account's failure must not stop the remaining accounts from being noted.
          detect.notify(error, {
            context: { merchant_account_id: Number(account.id), user_id: Number(account.user_id) },
          });
        }
      }
    }

    await findInBatches<AccountRow>(MERCHANT_ACCOUNTS, CONNECTED, BATCH_SIZE, noteFailingAccounts);
  })(overrides);
};

export const detectFailingPaypalRailsJob = detectFailingPaypalRailsJobWith();
