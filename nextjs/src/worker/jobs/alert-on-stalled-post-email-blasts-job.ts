// Port of app/sidekiq/alert_on_stalled_post_email_blasts_job.rb: the abandoned-blast expiry (PostEmailBlast.expire, a double-checked
// update_all), the candidate read, the dead, retry, queued and busy Sidekiq set scans, each blast's resume decision (the NX
// markers, SendPostBlastEmailsJob pushes, the dead entry removed after the push) and the InternalNotificationWorker alert.
// Removing a dead entry is Sidekiq::SortedEntry#delete: a ZREM, and when it removed the entry sidekiq-unique-jobs' delete.lua over the
// digest Job.add_digest derives from the entry (class, queue and args; the blast senders declare no lock, so a clean run holds no key
// and the script only leaves a changelog entry). The gem unlocks twice when the first run removed keys (JobSet#delete_by_value, then
// SortedEntry#delete). Node runs the gem's own script, so a held lock is deleted and counted the same way.
// Read-only checks that Rails would act on differently than Node can reproduce hand back before the first resume write: a flag
// on a percentage of time or an expression gate, an unreadable quota deferral time, a Sidekiq entry that is not JSON or that carries
// uniqueness options Node does not derive a digest from. A failed
// expiry hands back too, since Rails reports that error and carries on to the scan. The expiry has already been written by
// then, which Rails' own re-run cannot tell apart: it finds the same rows expired.
// Golden: __fixtures__/alert-on-stalled-post-email-blasts-job.golden.json (scripts/golden/alert-on-stalled-post-email-blasts-job.rb).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { lockDigest } from "../../server/jobs/sidekiq/item.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { deleteLockBang } from "../../server/jobs/sidekiq/unique-lock.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { RECIPIENT_FILTER_UNOPENED } from "../../server/models/post-email-blast.ts";
import { columnIn, execute, column, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const POST_EMAIL_BLASTS = "post_email_blasts";
const LOOKBACK = { days: 14 };
const DOUBLE_LOOKBACK = { days: 28 };
const STALL_THRESHOLD = { hours: 4 };
const MAX_CANDIDATES_SCANNED = 500;
// PostEmailBlast::EXPIRY_ABANDONED
const EXPIRY_ABANDONED = "abandoned";

const blasts = (name: string) => column(POST_EMAIL_BLASTS, name);
// where(completed_at: nil, expired_at: nil)
const EXPIRABLE_PENDING = Prisma.sql`${blasts("completed_at")} IS NULL AND ${blasts("expired_at")} IS NULL`;
const EXPIRABLE = Prisma.sql`${blasts("completed_at")} IS NULL AND ${blasts("expired_at")} IS NULL AND ${blasts("first_email_delivered_at")} IS NULL`;
// PostEmailBlast.never_sent: expirable, not a non-opener resend, and no sent_post_emails row since the blast was requested.
const NEVER_SENT = Prisma.sql`${EXPIRABLE} AND ${blasts("recipient_filter")} IS NULL AND (NOT EXISTS ( SELECT 1 FROM sent_post_emails WHERE sent_post_emails.post_id = post_email_blasts.post_id AND sent_post_emails.created_at >= post_email_blasts.requested_at AND sent_post_emails.created_at < COALESCE( (SELECT MIN(later.requested_at) FROM post_email_blasts later WHERE later.post_id = post_email_blasts.post_id AND later.recipient_filter IS NULL AND later.requested_at > post_email_blasts.requested_at), '9999-12-31')))`;

// PostEmailBlast.expire(ids, reason: EXPIRY_ABANDONED, never_sent: true)
async function expire(candidateIds: unknown[], now: Date): Promise<void> {
  // `where(id: [])` is a contradiction Rails answers without a query.
  if (candidateIds.length === 0) return;
  const ids = (
    await selectRows<{ id: unknown }>(
      Prisma.sql`SELECT ${blasts("id")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${NEVER_SENT} AND ${columnIn(POST_EMAIL_BLASTS, "id", candidateIds)}`,
    )
  ).map((row) => row.id);
  if (ids.length === 0) return;
  await execute(
    Prisma.sql`UPDATE ${table(POST_EMAIL_BLASTS)} SET ${blasts("expired_at")} = ${now}, ${blasts("expiry_reason")} = ${EXPIRY_ABANDONED}, ${blasts("updated_at")} = ${now} WHERE ${EXPIRABLE} AND ${columnIn(POST_EMAIL_BLASTS, "id", ids)}`,
  );
}

// The Redis commands the scans and the resume decision use: the main database (flags, blast keys) and Sidekiq's (its sets and queue).
export type StalledBlastRedis = {
  get(key: string): Promise<string | null>;
  exists(key: string): Promise<number>;
  set(key: string, value: string, expiry: "EX", seconds: number, mode: "NX"): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  smembers(key: string): Promise<string[]>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  // The members of a sorted set matching `*text*`, as ZSCAN MATCH returns them.
  zscanMembers(key: string, text: string): Promise<string[]>;
  // `SortedEntry#delete` of a dead set entry: ZREM, then the unique-jobs lock delete when it removed the entry. `now` is the Ruby clock in seconds.
  removeDeadEntry(member: string, now: number): Promise<void>;
};
export type StalledBlastDeps = { redis: (sidekiq: Redis) => StalledBlastRedis };

const ZSCAN_COUNT = 100;

function defaultRedis(sidekiq: Redis): StalledBlastRedis {
  return stalledBlastRedisOver(getRedis("main"), sidekiq);
}

// The commands over a main database (flags, blast keys) and Sidekiq's; one connection serves both where Ruby had one database.
export function stalledBlastRedisOver(main: Redis, sidekiq: Redis): StalledBlastRedis {
  return {
    get: (key) => main.get(key),
    exists: (key) => main.exists(key),
    set: (key, value, expiry, seconds, mode) => main.set(key, value, expiry, seconds, mode),
    hgetall: (key) => main.hgetall(key),
    smembers: (key) => sidekiq.smembers(key),
    lrange: (key, start, stop) => sidekiq.lrange(key, start, stop),
    async zscanMembers(key, text) {
      const members: string[] = [];
      let cursor = "0";
      do {
        const [next, page] = await sidekiq.zscan(key, cursor, "MATCH", `*${text}*`, "COUNT", ZSCAN_COUNT);
        for (let i = 0; i < page.length; i += 2) members.push(page[i]!);
        cursor = next;
      } while (cursor !== "0");
      return members;
    },
    async removeDeadEntry(member, now) {
      if ((await sidekiq.zrem("dead", member)) === 0) return;
      const item = deadItem(member);
      // JobSet#delete_by_value unlocks and answers whether that removed any key; SortedEntry#delete unlocks again only if it did.
      if (await deleteLockBang(sidekiq, item, now)) await deleteLockBang(sidekiq, item, now);
    },
  };
}

// Options that change how Job.add_digest derives the digest; the blast senders set none, and a payload that has one is left to Rails.
const FLOAT_IN_ARGS = /"args":\[[^\]]*[.eE]/u;
const DIGEST_OPTIONS = ["unique_across_queues", "unique_across_workers", "apartment", "lock_args_method"];

// The dead entry as Locksmith sees it after Job.add_digest: the digest of class, queue and args, and the jid the changelog names.
function deadItem(member: string) {
  const item = parseJsonObject(member, "dead set entry");
  if (typeof item.class !== "string" || typeof item.queue !== "string" || typeof item.jid !== "string")
    throw new HandBackToRuby("a dead set entry without a class, queue and jid");
  // A float argument (`1.0`) does not survive JSON.parse as the Float the digest is made of.
  if (!Array.isArray(item.args) || DIGEST_OPTIONS.some((option) => option in item) || FLOAT_IN_ARGS.test(member))
    throw new HandBackToRuby("a dead set entry whose unique-jobs digest Node does not derive");
  return {
    ...item,
    lock_digest: lockDigest({ class: item.class, queue: item.queue, lock_args: item.args as JsonValue[] }, false),
  };
}

type Blast = Record<string, unknown> & { id: bigint | number };
type Disposition = "running" | "queued" | "retrying" | "deferred" | "dead" | "unaccounted";
type Action =
  | "resumed"
  | "resumed_to_complete"
  | "would_resume"
  | "would_complete"
  | "skipped_reappeared"
  | "held_past_window"
  | "held_already_resumed"
  | "held_non_opener"
  | null;
type Entry = { blast: Blast; disposition: Disposition; action?: Action };

const BLAST_SENDER_CLASSES = ["SendPostBlastEmailsJob", "SendPostBlastEmailsSliceJob"];
const EMAIL_ACTIVITY_THRESHOLD = { minutes: 30 };
const AUTO_RESUME_WINDOW = { hours: 24 };
const AUTO_RESUME_FEATURE = "auto_resume_stalled_post_blasts";
const RESUME_MARKER_TTL_SECONDS = 4 * 60 * 60;
const MAX_REPORTED = 25;
const PERCENT = 100;
const AUDITED_ACTIONS: Action[] = [
  "resumed",
  "resumed_to_complete",
  "would_resume",
  "would_complete",
  "skipped_reappeared",
];
const MS_PER_HOUR = 3_600_000;
const HOURS_DECIMALS = 10;
const ALERT_ROOM = "payments";
// RedisKey.blast_quota_deferred_until and the like
const key = {
  pending: (id: unknown) => `blast:${String(id)}:pending_recipients`,
  quotaDeferredUntil: (id: unknown) => `blast:${String(id)}:quota_deferred_until`,
  autoResumed: (id: unknown) => `blast:${String(id)}:auto_resumed`,
  completionResumed: (id: unknown) => `blast:${String(id)}:completion_resumed`,
};
// What the app writes to the deferral key: `run_at.utc.iso8601`.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const present = (value: string | null): value is string => value !== null && value.trim() !== "";
// String#to_i
const toI = (value: string) => {
  const match = /^\s*([+-]?\d+)/u.exec(value);
  return match ? Number(match[1]) : 0;
};
const isHeld = (action: Action | undefined) => action?.startsWith("held_") ?? false;

// Float#round(1) (round half up on the scaled value) and Float#to_s for the small numbers an hour count is.
function rubyRound1(x: number): number {
  const scale = HOURS_DECIMALS;
  let rounded = Math.round(x * scale);
  if (x > 0 && (rounded + 0.5) / scale <= x) rounded += 1;
  return rounded / scale;
}
const floatToS = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HandBackToRuby(`a ${what} that is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HandBackToRuby(`a ${what} that is not an object`);
  }
  return parsed as Record<string, unknown>;
}

// The first argument of a Sidekiq payload as the blast id the scans compare.
function firstArg(job: Record<string, unknown>): string | null {
  const args = job.args;
  if (!Array.isArray(args)) throw new HandBackToRuby("a Sidekiq payload without an argument list");
  const first: unknown = args[0];
  return typeof first === "number" ? String(first) : null;
}

// Feature.active?(:auto_resume_stalled_post_blasts), asked with no actor: an actor or percentage-of-actors gate stays closed.
// Flipper rolls `rand` for a percentage of time on every call, so a partial one is not reproducible.
async function autoResumeActive(redis: StalledBlastRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(AUTO_RESUME_FEATURE, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null) {
    throw new HandBackToRuby(`${AUTO_RESUME_FEATURE} uses an expression gate`);
  }
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT) {
    throw new HandBackToRuby(`${AUTO_RESUME_FEATURE} is enabled for a percentage of time`);
  }
  return values.percentageOfTime >= PERCENT;
}

class Scans {
  #live: Set<string> | undefined;

  readonly redis: StalledBlastRedis;

  constructor(redis: StalledBlastRedis) {
    this.redis = redis;
  }

  // Sidekiq::DeadSet#scan per sender class: the last entry for a blast id wins, as the hash assignment does.
  async deadEntries(): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    for (const klass of BLAST_SENDER_CLASSES) {
      for (const member of await this.redis.zscanMembers("dead", klass)) {
        const job = parseJsonObject(member, "dead set entry");
        const id = job.class === klass ? firstArg(job) : null;
        if (id !== null) entries.set(id, member);
      }
    }
    return entries;
  }

  async retrying(): Promise<string[]> {
    const ids: string[] = [];
    for (const klass of BLAST_SENDER_CLASSES) {
      for (const member of await this.redis.zscanMembers("retry", klass)) {
        const job = parseJsonObject(member, "retry set entry");
        const id = job.class === klass ? firstArg(job) : null;
        if (id !== null) ids.push(id);
      }
    }
    return ids;
  }

  async queued(): Promise<string[]> {
    const ids: string[] = [];
    for (const member of await this.redis.lrange("queue:default", 0, -1)) {
      const job = parseJsonObject(member, "queued job");
      const id = BLAST_SENDER_CLASSES.includes(job.class as string) ? firstArg(job) : null;
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  // Sidekiq::Workers: the payload is a JSON string, and one that does not parse is skipped.
  async busy(): Promise<string[]> {
    const ids: string[] = [];
    for (const process of (await this.redis.smembers("processes")).sort()) {
      for (const json of Object.values(await this.redis.hgetall(`${process}:work`))) {
        if (json === "") continue;
        const work = parseJsonObject(json, "work entry");
        let payload: unknown = work.payload;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            continue;
          }
        }
        if (payload === null || payload === undefined || payload === false) continue;
        if (typeof payload !== "object" || Array.isArray(payload))
          throw new HandBackToRuby("a work payload that is not an object");
        const job = payload as Record<string, unknown>;
        if (!BLAST_SENDER_CLASSES.includes(job.class as string)) continue;
        const id = firstArg(job);
        if (id !== null) ids.push(id);
      }
    }
    return ids;
  }

  // Two passes in opposite orders, memoized: a sender that moved once between the sets is seen by one of them.
  async senderVisible(blastId: unknown): Promise<boolean> {
    if (this.#live === undefined) {
      const forward = [...(await this.retrying()), ...(await this.queued()), ...(await this.busy())];
      const backward = [...(await this.busy()), ...(await this.queued()), ...(await this.retrying())];
      this.#live = new Set([...forward, ...backward]);
    }
    return this.#live.has(String(blastId));
  }
}

export const alertOnStalledPostEmailBlastsJobWith = (
  overrides: Partial<JobDeps> = {},
  stalled: Partial<StalledBlastDeps> = {},
) =>
  modelJob({ min: 0 }, async (_args, deps, context) => {
    const now = deps.now();
    try {
      const abandoned = await selectRows<{ id: unknown }>(
        Prisma.sql`SELECT ${blasts("id")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${NEVER_SENT} AND ${blasts("requested_at")} >= ${ago(DOUBLE_LOOKBACK, now)} AND ${blasts("requested_at")} < ${ago(LOOKBACK, now)} ORDER BY ${blasts("requested_at")} DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED))}`,
      );
      await expire(
        abandoned.map((row) => row.id),
        now,
      );
    } catch (error) {
      throw new HandBackToRuby(`the abandoned-blast expiry failed: ${(error as Error).message}`);
    }

    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`post_email_blasts`.*")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${EXPIRABLE_PENDING} AND ${blasts("requested_at")} BETWEEN ${ago(LOOKBACK, now)} AND ${ago(STALL_THRESHOLD, now)} ORDER BY ${blasts("requested_at")} DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
    );
    if (rows.length === 0) return;
    const truncated = rows.length > MAX_CANDIDATES_SCANNED;
    const candidates = rows.slice(0, MAX_CANDIDATES_SCANNED);

    const redis = (stalled.redis ?? defaultRedis)(context.runtime.sidekiqRedis);
    const scans = new Scans(redis);

    // Read up front so an unreadable deferral hands back before the first resume write; the decision reads the same values.
    const quota = new Map<string, Date | null>();
    for (const blast of candidates) {
      const text = await redis.get(key.quotaDeferredUntil(blast.id));
      if (present(text) && !ISO_UTC.test(text))
        throw new HandBackToRuby("a quota deferral time that is not an ISO 8601 UTC time");
      quota.set(String(blast.id), present(text) ? new Date(text) : null);
    }

    const dead = await scans.deadEntries();
    const busy = new Set(await scans.busy());
    const retrying = new Set(await scans.retrying());
    const queued = new Set(await scans.queued());

    const entries: Entry[] = candidates.map((blast): Entry => {
      const id = String(blast.id);
      const emailedAt = blast.last_email_delivered_at as Date | null;
      const recent = emailedAt !== null && emailedAt.getTime() > ago(EMAIL_ACTIVITY_THRESHOLD, now).getTime();
      const deferredUntil = quota.get(id) ?? null;
      let disposition: Disposition;
      if (recent || busy.has(id)) disposition = "running";
      else if (queued.has(id)) disposition = "queued";
      else if (retrying.has(id)) disposition = "retrying";
      else if (deferredUntil !== null && deferredUntil.getTime() > now.getTime()) disposition = "deferred";
      else if (dead.has(id)) disposition = "dead";
      else disposition = "unaccounted";
      return { blast: blast as Blast, disposition };
    });

    // The runtime clock in seconds, as Ruby's Time.now.to_f: the date `now` is rounded to milliseconds.
    const nowSeconds = context.runtime.now();
    const live = await autoResumeActive(redis);
    // Judged before any resume write, since a blast resumed earlier in the loop cannot be undone.
    if (live)
      for (const entry of entries) if (entry.disposition === "dead") deadItem(dead.get(String(entry.blast.id))!);

    const recipientsOwed = async (blast: Blast) => {
      const pending = await redis.get(key.pending(blast.id));
      return present(pending) && toI(pending) > 0;
    };

    // Atomic NX claim before the resume, so overlapping runs cannot both resume one blast.
    const resume = async (entry: Entry, marker: string) => {
      const claimed = await redis.set(
        marker,
        now.toISOString().replace(/\.\d+Z$/u, "Z"),
        "EX",
        RESUME_MARKER_TTL_SECONDS,
        "NX",
      );
      if (!claimed) return false;
      await performAsync("SendPostBlastEmailsJob", [entry.blast.id]);
      // `@dead_entries.fetch(blast.id).delete if entry[:disposition] == :dead`, after the enqueue.
      if (entry.disposition === "dead") await redis.removeDeadEntry(dead.get(String(entry.blast.id))!, nowSeconds);
      return true;
    };

    for (const entry of entries) {
      const { blast } = entry;
      if (entry.disposition !== "dead" && entry.disposition !== "unaccounted") {
        entry.action = null;
        continue;
      }
      const pending = await redis.get(key.pending(blast.id));
      // SendPostBlastEmailsJob.fully_delivered?: every recipient was handed to the provider before the sender died.
      if (present(pending) && toI(pending) <= 0) {
        if (!live) entry.action = "would_complete";
        else if (await scans.senderVisible(blast.id)) entry.action = "skipped_reappeared";
        else
          entry.action = (await resume(entry, key.completionResumed(blast.id)))
            ? "resumed_to_complete"
            : "held_already_resumed";
        continue;
      }
      if (entry.disposition === "unaccounted" && blast.recipient_filter === RECIPIENT_FILTER_UNOPENED) {
        entry.action = "held_non_opener";
        continue;
      }
      const deferredUntil = quota.get(String(blast.id)) ?? null;
      const pastWindow = (blast.requested_at as Date).getTime() < ago(AUTO_RESUME_WINDOW, now).getTime();
      const deferralPassed = deferredUntil !== null && deferredUntil.getTime() < now.getTime();
      if (pastWindow && !(await recipientsOwed(blast)) && !deferralPassed) {
        entry.action = "held_past_window";
        continue;
      }
      if ((await redis.exists(key.autoResumed(blast.id))) > 0) {
        entry.action = "held_already_resumed";
        continue;
      }
      if (!live) {
        entry.action = "would_resume";
        continue;
      }
      if (await scans.senderVisible(blast.id)) {
        entry.action = "skipped_reappeared";
        continue;
      }
      entry.action = (await resume(entry, key.autoResumed(blast.id))) ? "resumed" : "held_already_resumed";
    }

    // Live auto-resume handles the dead and unaccounted rows; mail only when a human still has to look.
    if (!truncated && live && !entries.some((entry) => isHeld(entry.action))) return;

    await performAsync("InternalNotificationWorker", [
      ALERT_ROOM,
      "Stalled post email blasts",
      messageFor(entries, truncated, live, now),
    ]);
  })(overrides);

const lineFor = (entry: Entry, now: Date) => {
  const { blast } = entry;
  const hours = rubyRound1((now.getTime() - (blast.requested_at as Date).getTime()) / MS_PER_HOUR);
  const started = blast.started_at ? "" : " [never started]";
  const action = ACTION_TEXT[entry.action ?? "none"] ?? "";
  return `• blast ${String(blast.id)} (post ${String(blast.post_id)}, seller ${String(blast.seller_id)}) — requested ${floatToS(hours)}h ago${started}, ${blast.delivery_count === null ? "" : String(blast.delivery_count)} delivered, ${entry.disposition.toUpperCase()}${action}`;
};

const ACTION_TEXT: Record<string, string> = {
  resumed: " → RESUMED",
  resumed_to_complete: " → RESUMED (already fully delivered; the send job stamps it)",
  would_resume: " → WOULD RESUME (dry run)",
  would_complete: " → WOULD RESUME TO COMPLETE (dry run: already fully delivered)",
  held_past_window: " → HELD (past 24 hours resume window)",
  held_already_resumed: " → HELD (already auto-resumed once)",
  held_non_opener: " → HELD (non-opener resend: a duplicate sender double-delivers)",
  skipped_reappeared: " → SKIPPED (sender reappeared at resume time)",
};

function headline(count: number, truncated: boolean): string {
  if (count === 0) {
    return "No incomplete blast qualified on the scanned page, but the scan was truncated, so this is not evidence that none did.";
  }
  return `${truncated ? "At least " : ""}${count} email blast${count === 1 ? "" : "s"} requested more than 4 hours ago ${count === 1 ? "has" : "have"} not completed.`;
}

function messageFor(stalled: Entry[], truncated: boolean, live: boolean, now: Date): string {
  const held = stalled.filter((entry) => isHeld(entry.action));
  const rest = stalled.filter((entry) => !isHeld(entry.action));
  const acted = rest.filter((entry) => AUDITED_ACTIONS.includes(entry.action ?? null));
  const informational = rest.filter((entry) => !AUDITED_ACTIONS.includes(entry.action ?? null));
  const reported = [...held, ...[...acted, ...informational].slice(0, Math.max(MAX_REPORTED - held.length, 0))];
  const lines = reported.map((entry) => lineFor(entry, now));
  const omitted = stalled.length - lines.length;
  return [
    headline(stalled.length, truncated),
    truncated
      ? `The scan stopped at ${MAX_CANDIDATES_SCANNED} incomplete blasts, so others are not counted here.`
      : null,
    live
      ? null
      : "Auto-resume is DRY RUN (:auto_resume_stalled_post_blasts is off) — WOULD RESUME rows were not touched.",
    "",
    ...lines,
    omitted > 0 ? `…and ${omitted} more.` : null,
    "",
    GUIDANCE,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const GUIDANCE =
  "RUNNING/QUEUED may just be a very large blast mid-pass. DEFERRED is waiting for the seller's " +
  "next daily large-blast slot. DEAD/UNACCOUNTED blasts requested " +
  "within 24 hours are resumed automatically, once per blast " +
  "(gumroad-private#2106) — except UNACCOUNTED non-opener resends, which a concurrent " +
  "duplicate sender would double-deliver. UNACCOUNTED usually means a lost enqueue, a " +
  "post no longer sendable, or a job stranded in a retired process's private queue that " +
  "no resurrection pass has reached — super_fetch does not reliably resurrect hard-killed " +
  "jobs (gumroad-private#2352). HELD " +
  "rows need a human: confirm with the seller (time-boxed blasts may be worse late than " +
  "never), then `SendPostBlastEmailsJob.perform_async(blast_id)` — for a DEAD row too. " +
  "Never `job.retry` a dead blast: it reuses the jid super_fetch has already spent its " +
  "orphan budget on, so it is killed again before it delivers (gumroad-private#2338). " +
  "A blast whose sender finished delivering but died before the " +
  "completion stamp is resumed regardless of those limits — the resumed job has nothing " +
  "left to send and just stamps it (gumroad-private#2250). See gumroad-private#1750 for " +
  "a worked run.";

export const alertOnStalledPostEmailBlastsJob = alertOnStalledPostEmailBlastsJobWith();
