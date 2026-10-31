// Ports of the jobs that suspend sellers in bulk:
//   app/sidekiq/suspend_accounts_with_payment_address_worker.rb
//   app/sidekiq/suspend_users_worker.rb
import { Prisma, type Comment, type ScheduledPayout } from "@prisma/client";

import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { COMMENT_TYPES, Comments } from "../../server/models/comment.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { ScheduledPayouts } from "../../server/models/scheduled-payout.ts";
import { castRow, column, columnIn, columnNotIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { fireRiskEvent, formattedDateFullMonth } from "../../server/models/user-risk.ts";
import { findUserBang, nameOrUsername, NotPortedError, RISK_STATES, Users, type UserRecord } from "../../server/models/user.ts";
import { modelJob, type JobDeps } from "./support/job-deps.ts";

const SUSPENDED_STATES = RISK_STATES.SUSPENDED as readonly string[];
// `without_user_risk_state(:suspended_for_fraud, :suspended_for_tos_violation)`, in that order.
const NOT_SUSPENDED_ORDER = ["suspended_for_fraud", "suspended_for_tos_violation"];
const notSuspended = () => columnNotIn("users", "user_risk_state", NOT_SUSPENDED_ORDER);
const loadUser = (row: Record<string, unknown>) => Users.load(castRow("User", row)) as UserRecord;

// ---------------------------------------------------------------------------------------------
// SuspendAccountsWithPaymentAddressWorker

async function suspendUser(user: UserRecord, suspendedUser: UserRecord, identifierType: string, identifierValue: unknown, deps: JobDeps): Promise<void> {
  const date = formattedDateFullMonth(deps.now());
  await fireRiskEvent(
    user,
    "suspend_for_fraud",
    {
      author_name: "suspend_sellers_other_accounts",
      content: `Suspended for fraud automatically on ${date} because of usage of ${identifierType} ${String(identifierValue ?? "")} (from User#${String(suspendedUser.get("id"))})`,
      skip_transition_callback: "suspend_sellers_other_accounts",
    },
    { now: deps.now },
  );
}

async function suspendUsersWithSamePaymentAddress(suspendedUser: UserRecord, deps: JobDeps): Promise<void> {
  const paymentAddress = suspendedUser.get("payment_address");
  if (isBlank(paymentAddress)) return;
  const where = Prisma.sql`(${notSuspended()}) AND ${column("users", "payment_address")} = ${paymentAddress} AND ${column("users", "id")} != ${suspendedUser.get("id")}`;
  await findInBatches("users", where, 1000, async (rows) => {
    for (const row of rows) await suspendUser(loadUser(row), suspendedUser, "payment address", paymentAddress, deps);
  });
}

async function suspendUsersWithSameStripeFingerprint(suspendedUser: UserRecord, deps: JobDeps): Promise<void> {
  const b = "bank_accounts";
  const fingerprints = (
    await selectRows<{ stripe_fingerprint: string }>(
      Prisma.sql`SELECT DISTINCT ${column(b, "stripe_fingerprint")} FROM ${table(b)} WHERE ${column(b, "user_id")} = ${suspendedUser.get("id")} AND NOT ((${column(b, "stripe_fingerprint")} = '' OR ${column(b, "stripe_fingerprint")} IS NULL))`,
    )
  ).map((r) => r.stripe_fingerprint);
  if (fingerprints.length === 0) return;

  const userIds = (
    await selectRows<{ user_id: bigint }>(
      Prisma.sql`SELECT DISTINCT ${column(b, "user_id")} FROM ${table(b)} WHERE ${column(b, "deleted_at")} IS NULL AND ${columnIn(b, "stripe_fingerprint", fingerprints)} AND ${column(b, "user_id")} != ${suspendedUser.get("id")}`,
    )
  ).map((r) => r.user_id);

  await findInBatches("users", Prisma.sql`(${notSuspended()}) AND ${columnIn("users", "id", userIds)}`, 1000, async (rows) => {
    for (const row of rows) {
      const user = loadUser(row);
      const theirs = (
        await selectRows<{ stripe_fingerprint: string | null }>(
          Prisma.sql`SELECT ${column(b, "stripe_fingerprint")} FROM ${table(b)} WHERE ${column(b, "user_id")} = ${user.get("id")} AND ${column(b, "deleted_at")} IS NULL`,
        )
      ).map((r) => r.stripe_fingerprint);
      const matching = fingerprints.find((fingerprint) => theirs.includes(fingerprint));
      await suspendUser(user, suspendedUser, "bank account fingerprint", matching, deps);
    }
  });
}

export const suspendAccountsWithPaymentAddressWorkerWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const suspendedUser = await findUserBang(userId);
  await suspendUsersWithSamePaymentAddress(suspendedUser, deps);
  await suspendUsersWithSameStripeFingerprint(suspendedUser, deps);
});

// ---------------------------------------------------------------------------------------------
// SuspendUsersWorker

const DEFAULT_SCHEDULED_PAYOUT_DELAY_DAYS = 21;
const SIGNED_BIGINT_MAX = 2n ** 63n - 1n;
const SIGNED_BIGINT_MIN = -(2n ** 63n);

// ActiveModel::Type::Integer#cast: nil for a blank string or one with no leading digits, else
// String#to_i (which reads single underscores between digits).
function castInteger(value: string | number | bigint): bigint | null {
  if (typeof value !== "string") return BigInt(value);
  if (value.trim() === "") return null;
  const match = /^[ \t\r\n\f\v]*([+-]?\d+(?:_\d+)*)/u.exec(value);
  return match ? BigInt(match[1]!.replaceAll("_", "")) : null;
}

const serializable = (id: bigint) => id >= SIGNED_BIGINT_MIN && id <= SIGNED_BIGINT_MAX;

// The predicate `where(<column> => values)` builds: nils become IS NULL, a single value an
// equality (`= NULL` when it casts to nil, 1=0 when out of range), several a HomogeneousIn that
// drops what does not cast.
function columnPredicates(name: string, values: (string | number | bigint | null)[], kind: "id" | "string"): Prisma.Sql[] {
  const col = column("users", name);
  const present = values.filter((v): v is string | number | bigint => v !== null);
  const parts: Prisma.Sql[] = [];
  if (kind === "string") {
    const strings = present.map(String);
    if (strings.length === 1) parts.push(Prisma.sql`${col} = ${strings[0]}`);
    else if (strings.length > 1) parts.push(Prisma.sql`${col} IN (${Prisma.join(strings, ", ")})`);
  } else if (present.length === 1) {
    const id = castInteger(present[0]!);
    if (id === null) parts.push(Prisma.sql`${col} = NULL`);
    else parts.push(serializable(id) ? Prisma.sql`${col} = ${id}` : Prisma.raw("1=0"));
  } else if (present.length > 1) {
    const ids = present.map(castInteger).filter((id): id is bigint => id !== null && serializable(id));
    parts.push(ids.length === 0 ? Prisma.sql`${col} IN (NULL)` : Prisma.sql`${col} IN (${Prisma.join(ids, ", ")})`);
  }
  if (present.length < values.length) parts.push(Prisma.sql`${col} IS NULL`);
  return parts.length === 0 ? [Prisma.raw("1=0")] : parts;
}

type UserIdArg = string | number | bigint | null;

function userIdList(userIds: JsonValue): UserIdArg[] {
  const list = Array.isArray(userIds) ? userIds : [userIds];
  for (const id of list) {
    const ok = id === null || typeof id === "string" || typeof id === "bigint" || (typeof id === "number" && Number.isInteger(id));
    if (!ok) throw new NotPortedError(`SuspendUsersWorker with user id ${JSON.stringify(id)}`, "app/sidekiq/suspend_users_worker.rb:11");
  }
  return list as UserIdArg[];
}

type ScheduledPayoutArg = { action: string; delayDays: JsonValue } | null;

// Checked before any statement, so a refusal leaves nobody half-processed.
function scheduledPayoutArg(scheduledPayout: JsonValue | undefined): ScheduledPayoutArg {
  if (isBlank(scheduledPayout)) return null;
  if (typeof scheduledPayout !== "object" || Array.isArray(scheduledPayout) || scheduledPayout === null) {
    throw new NotPortedError("SuspendUsersWorker with a non-Hash scheduled_payout", "app/sidekiq/suspend_users_worker.rb:20");
  }
  const params = scheduledPayout as Record<string, JsonValue>;
  if (isBlank(params.action)) return null;
  if (params.action === "payout") {
    // processor: user.current_payout_processor, which can call the PayPal API.
    throw new NotPortedError("User#current_payout_processor", "app/modules/user/payout_schedule.rb:94");
  }
  const delayDays = params.delay_days;
  const plainInteger = (typeof delayDays === "number" && Number.isInteger(delayDays) && delayDays >= 0) || (typeof delayDays === "string" && /^\d+$/u.test(delayDays));
  if (!isBlank(delayDays) && !plainInteger) {
    throw new NotPortedError(`ScheduledPayout delay_days ${JSON.stringify(delayDays)}`, "app/models/scheduled_payout.rb:18");
  }
  return { action: String(params.action), delayDays: isBlank(delayDays) ? DEFAULT_SCHEDULED_PAYOUT_DELAY_DAYS : Number(delayDays) };
}

async function unpaidBalanceCents(user: UserRecord): Promise<bigint> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const sum = row ? Object.values(row)[0] : null;
  return sum == null ? 0n : BigInt(String(sum));
}

async function createScheduledPayout(user: UserRecord, author: UserRecord, scheduledPayout: NonNullable<ScheduledPayoutArg>, deps: JobDeps): Promise<void> {
  const record = await ScheduledPayouts.createBang(
    {
      user_id: BigInt(user.get("id") as bigint),
      action: scheduledPayout.action,
      delay_days: scheduledPayout.delayDays as number,
      processor: null,
      payout_amount_cents: await unpaidBalanceCents(user),
      created_by_id: BigInt(author.get("id") as bigint),
    } as Partial<ScheduledPayout>,
    { now: deps.now },
  );
  await Comments.createBang(
    {
      commentable_id: BigInt(user.get("id") as bigint),
      commentable_type: "User",
      author_id: BigInt(author.get("id") as bigint),
      author_name: author.get("name") ?? null,
      comment_type: COMMENT_TYPES.PAYOUT_NOTE,
      content: `Scheduled ${String(record.get("action"))} for ${formattedDateFullMonth(record.get("scheduled_at") as Date)} (${String(record.get("delay_days"))} day delay)`,
    } as Partial<Comment>,
    { now: deps.now },
  );
}

export const suspendUsersWorkerWith = modelJob({ min: 4, max: 5 }, async ([authorId, userIds, reason, additionalNotes, rawScheduledPayout], deps) => {
  const ids = userIdList(userIds!);
  const scheduledPayout = scheduledPayoutArg(rawScheduledPayout);
  const author = await findUserBang(authorId);
  const authorName = nameOrUsername(author);
  const where = Prisma.sql`(${Prisma.join([...columnPredicates("id", ids, "id"), ...columnPredicates("external_id", ids, "string")], " OR ")})`;
  await findInBatches("users", where, 100, async (rows) => {
    for (const row of rows) {
      const user = loadUser(row);
      const wasSuspended = SUSPENDED_STATES.includes(String(user.get("user_risk_state")));
      let content = `Suspended for a policy violation by ${String(authorName ?? "")} on ${formattedDateFullMonth(deps.now())} as part of mass suspension. Reason: ${String(reason ?? "")}.`;
      if (!isBlank(additionalNotes)) content += `\nAdditional notes: ${String(additionalNotes)}`;
      await fireRiskEvent(user, "suspend_for_tos_violation", { author_id: authorId as never, content }, { now: deps.now });

      if (wasSuspended || !SUSPENDED_STATES.includes(String(user.get("user_risk_state")))) continue;
      if (scheduledPayout === null) continue;
      if ((await unpaidBalanceCents(user)) <= 0n) continue;
      await createScheduledPayout(user, author, scheduledPayout, deps);
    }
  });
});

export const suspendAccountsWithPaymentAddressWorker = suspendAccountsWithPaymentAddressWorkerWith();
export const suspendUsersWorker = suspendUsersWorkerWith();
