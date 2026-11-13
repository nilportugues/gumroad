// Port of app/sidekiq/send_reminders_for_outstanding_user_compliance_info_requests_worker.rb. A seller whose Stripe account is
// rejected makes Ruby ask Stripe (`Stripe::Account.retrieve`) whether anything is still requestable; Node does not, so the job is handed
// back at that seller. The sellers before it were already handled exactly as Ruby does (each stamps its requests), so Ruby's rerun finds
// them recently reminded and sends nothing twice. A request whose stored times Ruby's parser would read differently hands back the same way.
// Times in json_data are written the way Rails writes a Time (whole seconds, `Z`); the write is `save!` with
// merge_json_data_with_current_row: a locking read, then only the changed key laid over the row's current json_data.
// Golden: __fixtures__/send-reminders-for-outstanding-user-compliance-info-requests-worker.golden.json
// (scripts/golden/send-reminders-for-outstanding-user-compliance-info-requests-worker.rb).
import { Prisma, type UserComplianceInfoRequest } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { deliverLater, timeWithZone } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { jsonGet, toHash } from "../../server/models/concerns/json-data.ts";
import { RubyHash, type YamlValue } from "../../server/models/concerns/psych.ts";
import { rubyJsonGenerate, rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { stripeAccountOf, type MerchantAccountRow } from "../../server/models/merchant-account.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { findUserBang, isAccountActive } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const REQUESTS = "user_compliance_info_requests";
const MAILER = "ContactingCreatorMailer";
const DAY_MS = 86_400_000;
const TIME_UNTIL_REQUEST_NEEDS_REMINDER_MS = 2 * DAY_MS;
const MAX_NUMBER_OF_REMINDERS = 2;
const SG_VERIFICATION_DEADLINE_MS = 120 * DAY_MS;
const SG_REMINDER_INTERVAL_MS = 7 * DAY_MS;
const SINGAPORE = "SG";
// UserComplianceInfoFields::Individual::STRIPE_ENHANCED_IDENTITY_VERIFICATION
const SG_ENHANCED_IDENTITY_VERIFICATION = "stripe_enhanced_identity_verification";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const star = Prisma.raw(`${"`user_compliance_info_requests`"}.*`);
const requestColumn = (name: string) => column(REQUESTS, name);

type RequestRow = UserComplianceInfoRequest & { json_data: string | null };

// A time in a json_data string, as Time.zone.parse reads it; any other shape is for Ruby.
function parseStoredTime(value: YamlValue | undefined): number {
  if (typeof value !== "string" || !ISO_TIME.test(value)) throw new HandBackToRuby("a stored time Node does not parse");
  return Date.parse(value);
}

function requestData(row: RequestRow): RubyHash {
  if (isBlank(row.json_data)) return new RubyHash([]);
  const hash = toHash(rubyJsonParse(row.json_data!));
  if (hash === null) throw new HandBackToRuby("json_data of a compliance request is not a hash");
  return hash;
}

// `emails_sent_at`: the stored list, each element read as a time
function emailsSentAt(row: RequestRow): number[] {
  const value = jsonGet(requestData(row), "emails_sent_at");
  if (value === undefined || isBlank(value)) return [];
  if (!Array.isArray(value)) throw new HandBackToRuby("emails_sent_at is not a list");
  return value.map(parseStoredTime);
}

const wholeSecondIso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

// `hash` with `key` set: in place when it is there, else at the end
function withKey(hash: RubyHash, key: string, value: YamlValue): RubyHash {
  const entries = hash.entries.map(([k, v]): [YamlValue, YamlValue] => [k, k === key ? value : v]);
  if (jsonGet(hash, key) === undefined) entries.push([key, value]);
  return new RubyHash(entries);
}

// `save!` of a request whose json_data key changed: the row's current json_data (read under the lock) takes the new value
// at the key's place, or at the end. `updated_at` is written only when it moves by a whole second.
async function saveJsonKey(row: RequestRow, key: string, value: YamlValue, nowMs: number): Promise<void> {
  await transaction(async (tx) => {
    const [current] = await tx.$queryRaw<{ json_data: string | null }[]>(
      Prisma.sql`SELECT ${requestColumn("json_data")} FROM ${table(REQUESTS)} WHERE ${requestColumn("id")} = ${row.id} LIMIT 1 FOR UPDATE`,
    );
    let written = withKey(requestData(row), key, value);
    if (current?.json_data != null) {
      const merged = toHash(rubyJsonParse(current.json_data));
      if (merged === null) throw new HandBackToRuby("json_data of a compliance request is not a hash");
      written = withKey(merged, key, value);
    }
    const stamp = new Date(Math.floor(nowMs / 1000) * 1000);
    const touch = row.updated_at === null || row.updated_at.getTime() !== stamp.getTime();
    await tx.$executeRaw(
      Prisma.sql`UPDATE ${table(REQUESTS)} SET ${touch ? Prisma.sql`${requestColumn("updated_at")} = ${stamp}, ` : Prisma.empty}${requestColumn("json_data")} = ${rubyJsonGenerate(written)} WHERE ${requestColumn("id")} = ${row.id}`,
    );
  });
}

// MerchantAccount#stripe_rejected?
function stripeRejected(account: MerchantAccountRow): boolean {
  if (typeof account.json_data !== "string" || isBlank(account.json_data)) return false;
  const data = rubyJsonParse(account.json_data);
  const hash = toHash(data);
  if (hash === null) throw new HandBackToRuby("json_data of a merchant account is not a hash");
  const reason = jsonGet(hash, "stripe_disabled_reason");
  return typeof reason === "string" && reason.startsWith("rejected.");
}

async function requestsOf(userId: bigint, extra: Prisma.Sql, order: Prisma.Sql): Promise<RequestRow[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${star} FROM ${table(REQUESTS)} WHERE ${requestColumn("user_id")} = ${userId}${extra}${order}`,
  );
  return rows.map((row) => castRow<RequestRow>("UserComplianceInfoRequest", row));
}

export const sendRemindersForOutstandingUserComplianceInfoRequestsWorkerWith = modelJob(
  { min: 0 },
  async (_args, deps, { runtime }) => {
    const userIds = await selectRows<{ user_id: bigint | number }>(
      Prisma.sql`SELECT DISTINCT ${requestColumn("user_id")} FROM ${table(REQUESTS)} WHERE ${requestColumn("state")} = 'requested'`,
    );

    for (const { user_id: userIdValue } of userIds) {
      const userId = BigInt(userIdValue);
      const user = await findUserBang(userId);
      if (!isAccountActive(user)) continue;
      const account = await stripeAccountOf(userId);
      if (account !== null && stripeRejected(account))
        throw new HandBackToRuby("Stripe::Account.retrieve decides whether a rejected account still gets reminders");

      if (account !== null && account.country === SINGAPORE) {
        const [request] = await requestsOf(
          userId,
          Prisma.sql` AND ${requestColumn("state")} = 'requested' AND ${requestColumn("field_needed")} = ${SG_ENHANCED_IDENTITY_VERIFICATION}`,
          Prisma.sql` ORDER BY ${requestColumn("id")} DESC LIMIT 1`,
        );
        const createdAt = (account as unknown as { created_at: Date }).created_at;
        const deadline = createdAt.getTime() + SG_VERIFICATION_DEADLINE_MS;
        if (request !== undefined && deps.now().getTime() < deadline) {
          const remindedAt = jsonGet(requestData(request), "sg_verification_reminder_sent_at");
          if (
            remindedAt === undefined ||
            remindedAt === null ||
            parseStoredTime(remindedAt) < deps.now().getTime() - SG_REMINDER_INTERVAL_MS
          ) {
            await deliverLater(
              runtime,
              {
                mailer: MAILER,
                method: "singapore_identity_verification_reminder",
                args: [Number(userId), timeWithZone(deadline)],
                queue: "default",
              },
              mailRoute(MAILER, "singapore_identity_verification_reminder"),
            );
            await saveJsonKey(
              request,
              "sg_verification_reminder_sent_at",
              wholeSecondIso(deps.now().getTime()),
              deps.now().getTime(),
            );
          }
        }
      }

      const [oldest] = await requestsOf(userId, Prisma.empty, Prisma.sql` ORDER BY ${requestColumn("id")} ASC LIMIT 1`);
      if (oldest === undefined) throw new HandBackToRuby("a seller with no compliance request");
      const sent = emailsSentAt(oldest);
      const last = sent.at(-1);
      const shouldRemind =
        (last === undefined || last < deps.now().getTime() - TIME_UNTIL_REQUEST_NEEDS_REMINDER_MS) &&
        sent.length < MAX_NUMBER_OF_REMINDERS;
      if (!shouldRemind) continue;

      await deliverLater(
        runtime,
        { mailer: MAILER, method: "payouts_may_be_blocked", args: [Number(userId)], queue: "critical" },
        mailRoute(MAILER, "payouts_may_be_blocked"),
      );
      const emailSentAt = deps.now().getTime();
      for (const request of await requestsOf(userId, Prisma.empty, Prisma.empty)) {
        await saveJsonKey(
          request,
          "emails_sent_at",
          [...emailsSentAt(request), emailSentAt].map(wholeSecondIso),
          emailSentAt,
        );
      }
    }
  },
);

export const sendRemindersForOutstandingUserComplianceInfoRequestsWorker =
  sendRemindersForOutstandingUserComplianceInfoRequestsWorkerWith();
