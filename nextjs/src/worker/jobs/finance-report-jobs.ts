// Ports of the finance report jobs that only build and mail a report in production (EmailOutstandingBalancesCsvWorker,
// SendStripeCurrencyBalancesReportJob, SendDeferredRefundsReportWorker, SendFinancesReportWorker, SendStripeBalanceSummariesReportJob,
// SendDailyFinanceLedgerReportJob): `return unless Rails.env.production?` leaves nothing but the bookkeeping of the two modules they
// include, which runs in Node. LongRunningJobTracking holds a deploy-blocking token in a sorted set for the length of the run;
// FinanceReportCompletionTracking records the completion once perform returns. In production the report build and the mail hand back
// to Rails, before the token is taken. Their sidekiq_retries_exhausted (FinanceReportFailureAlert) mails the failure.
// Golden: __fixtures__/finance-report-jobs.golden.json (scripts/golden/finance-report-jobs.rb).
import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { railsEnv } from "../../server/infra/rails-env.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { type ActiveJobArgument, deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import type { RetriesExhausted } from "../retry.ts";

import { checkArity } from "./arity.ts";
import type { JobContext, JobHandler } from "./types.ts";

const LONG_RUNNING_JOBS_IN_FLIGHT_KEY = "deploy:long_running_jobs_in_flight";
// LongRunningJobTracking::IN_FLIGHT_ENTRY_TTL
const IN_FLIGHT_ENTRY_TTL_SECONDS = 6 * 60 * 60;
// FinanceReportCompletionTracking::REDIS_KEY_TTL
const COMPLETION_TTL_SECONDS = 120 * 24 * 60 * 60;
const RAISE_IN_FLIGHT_FLAG_SCRIPT = `redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return redis.call('ZCARD', KEYS[1])
`;
const MAILER = "AccountingMailer";
const FAILURE_METHOD = "finance_report_job_failed";

export type FinanceReportJob = {
  // The Ruby class name, which keys the completion and prefixes the in-flight token.
  name: string;
  // LongRunningJobTracking
  longRunning: boolean;
  // perform(month = nil, year = nil): the most positional arguments perform takes.
  maxArgs: number;
  // `.default_alert_args(reference_time)`; the class has none when this is absent.
  defaultAlertArgs?: (referenceTime: Date) => JsonValue[];
  // What perform does in production when that is neither a report build nor a mail (a fan-out of other jobs). Without it the job
  // hands back in production. It must hand back before its first push.
  production?: (args: JsonValue[], deps: FinanceReportDeps, context: JobContext) => Promise<void>;
};

export type FinanceReportDeps = {
  redis: () => Redis;
  now: () => Date;
  uuid: () => string;
  pid: () => number;
};

const defaultDeps: FinanceReportDeps = {
  redis: () => getRedis("main"),
  now: () => new Date(),
  uuid: () => randomUUID(),
  pid: () => process.pid,
};

class NotPortedArgument extends Error {
  constructor(reason: string) {
    super(`Handed back to Rails: ${reason}`);
    this.name = "NotPortedError";
  }
}

// `Array#join(",")` for the arguments JSON can carry whose to_s is plain. A Float or a Hash prints in Ruby's own format.
function rubyJoin(values: readonly JsonValue[]): string {
  return values
    .map((value) => {
      if (value === null) return "";
      if (Array.isArray(value)) return rubyJoin(value);
      if (typeof value === "string") return value;
      if (typeof value === "boolean") return value ? "true" : "false";
      if (typeof value === "number" && Number.isInteger(value)) return String(value);
      if (typeof value === "bigint") return String(value);
      throw new NotPortedArgument("a period argument that is a Float or a Hash");
    })
    .join(",");
}

// FinanceReportCompletionTracking.redis_key
const completionKey = (name: string, periodArgs: readonly JsonValue[]) =>
  `finance_report_last_completed_at:${name}:${rubyJoin(periodArgs)}`;

// `base.default_alert_args(reference_time)`, or [] for a class that has none.
const periodArgsFor = (job: FinanceReportJob, referenceTime: Date): JsonValue[] =>
  job.defaultAlertArgs ? job.defaultAlertArgs(referenceTime) : [];

export function financeReportJobWith(job: FinanceReportJob, overrides: Partial<FinanceReportDeps> = {}): JobHandler {
  const deps = { ...defaultDeps, ...overrides };
  return async (args: JsonValue[], context: JobContext) => {
    const production = railsEnv() === "production";
    if (production && !job.production) throw new HandBackToRuby("the report is built and mailed in production");
    // The completion key is built after the token is taken; settle it first so a hand-back never follows the token.
    const periodArgs = args.length > 0 ? args : periodArgsFor(job, deps.now());
    if (args.length <= job.maxArgs) await beforeSideEffects(() => rubyJoin(periodArgs));

    const redis = deps.redis();
    const token = `${job.name}-${deps.pid()}-${deps.uuid()}`;
    try {
      if (job.longRunning) {
        await redis.eval(
          RAISE_IN_FLIGHT_FLAG_SCRIPT,
          1,
          LONG_RUNNING_JOBS_IN_FLIGHT_KEY,
          String(Math.floor(deps.now().getTime() / 1000)),
          token,
          String(IN_FLIGHT_ENTRY_TTL_SECONDS),
        );
      }
      checkArity(args, 0, job.maxArgs);
      if (production) await job.production!(args, deps, context);
      await redis.set(
        completionKey(job.name, periodArgs),
        String(Math.floor(deps.now().getTime() / 1000)),
        "EX",
        COMPLETION_TTL_SECONDS,
      );
    } finally {
      if (job.longRunning) {
        try {
          await redis.zrem(LONG_RUNNING_JOBS_IN_FLIGHT_KEY, token);
        } catch (error) {
          // A failed cleanup self-heals through the entry's TTL; it must not mask the job's own outcome.
          notifyError(error, { redis_key: LONG_RUNNING_JOBS_IN_FLIGHT_KEY });
        }
      }
    }
  };
}

function activeJobArgument(value: JsonValue): ActiveJobArgument {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (Array.isArray(value)) return value.map(activeJobArgument);
  throw new NotPortedArgument("a job argument that is a Float or a Hash");
}

const epochSeconds = (value: unknown): number | null => {
  if (value === undefined || value === null || value === false) return null;
  if (value instanceof RubyFloat) return value.value;
  if (typeof value === "number") return value;
  throw new TypeError("can't convert the job's timestamp into an time");
};

// FinanceReportFailureAlert's sidekiq_retries_exhausted: the period is pinned to the job's own creation time, so a re-run reports
// the period the failed run was for.
export function financeReportRetriesExhaustedWith(
  job: FinanceReportJob,
  overrides: Partial<FinanceReportDeps> = {},
): RetriesExhausted {
  const deps = { ...defaultDeps, ...overrides };
  return async (msg, error, { runtime }) => {
    let args: JsonValue = (msg.args ?? null) as JsonValue;
    const blank = args === null || (Array.isArray(args) && args.length === 0);
    if (blank && job.defaultAlertArgs) {
      const created = epochSeconds(msg.created_at) ?? epochSeconds(msg.enqueued_at);
      const referenceTime = created === null ? deps.now() : new Date(created * 1000);
      args = job.defaultAlertArgs(referenceTime);
    }
    const errorClass = typeof msg.error_class === "string" ? msg.error_class : "StandardError";
    const errorMessage = typeof msg.error_message === "string" ? msg.error_message : String(error);
    // `job["class"] || base.name`: only nil and false fall through, an empty string does not.
    const jobName =
      msg.class === undefined || msg.class === null || (msg.class as unknown) === false
        ? job.name
        : activeJobArgument(msg.class as JsonValue);
    await deliverLater(
      runtime,
      { mailer: MAILER, method: FAILURE_METHOD, args: [jobName, activeJobArgument(args), errorClass, errorMessage] },
      mailRoute(MAILER, FAILURE_METHOD),
    );
  };
}

// `Time.current.last_month` as [month, year]: the day does not matter, only the month it lands in.
function lastMonth(referenceTime: Date): JsonValue[] {
  const month = referenceTime.getUTCMonth();
  return month === 0 ? [12, referenceTime.getUTCFullYear() - 1] : [month, referenceTime.getUTCFullYear()];
}

// `(reference_time.utc.to_date - 1).iso8601`
function previousUtcDay(referenceTime: Date): JsonValue[] {
  const day = new Date(
    Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth(), referenceTime.getUTCDate() - 1),
  );
  return [day.toISOString().slice(0, 10)];
}

export const EMAIL_OUTSTANDING_BALANCES_CSV_WORKER: FinanceReportJob = {
  name: "EmailOutstandingBalancesCsvWorker",
  longRunning: true,
  maxArgs: 0,
};
export const SEND_STRIPE_CURRENCY_BALANCES_REPORT_JOB: FinanceReportJob = {
  name: "SendStripeCurrencyBalancesReportJob",
  longRunning: false,
  maxArgs: 0,
};
export const SEND_DEFERRED_REFUNDS_REPORT_WORKER: FinanceReportJob = {
  name: "SendDeferredRefundsReportWorker",
  longRunning: true,
  maxArgs: 2,
  defaultAlertArgs: lastMonth,
};
export const SEND_FINANCES_REPORT_WORKER: FinanceReportJob = {
  name: "SendFinancesReportWorker",
  longRunning: true,
  maxArgs: 2,
  defaultAlertArgs: lastMonth,
};
export const SEND_STRIPE_BALANCE_SUMMARIES_REPORT_JOB: FinanceReportJob = {
  name: "SendStripeBalanceSummariesReportJob",
  longRunning: true,
  maxArgs: 2,
  defaultAlertArgs: lastMonth,
};
export const SEND_DAILY_FINANCE_LEDGER_REPORT_JOB: FinanceReportJob = {
  name: "SendDailyFinanceLedgerReportJob",
  longRunning: false,
  maxArgs: 1,
  defaultAlertArgs: previousUtcDay,
};

export const FINANCE_REPORT_JOBS: readonly FinanceReportJob[] = [
  EMAIL_OUTSTANDING_BALANCES_CSV_WORKER,
  SEND_STRIPE_CURRENCY_BALANCES_REPORT_JOB,
  SEND_DEFERRED_REFUNDS_REPORT_WORKER,
  SEND_FINANCES_REPORT_WORKER,
  SEND_STRIPE_BALANCE_SUMMARIES_REPORT_JOB,
  SEND_DAILY_FINANCE_LEDGER_REPORT_JOB,
];

export const emailOutstandingBalancesCsvWorker = financeReportJobWith(EMAIL_OUTSTANDING_BALANCES_CSV_WORKER);
export const sendStripeCurrencyBalancesReportJob = financeReportJobWith(SEND_STRIPE_CURRENCY_BALANCES_REPORT_JOB);
export const sendDeferredRefundsReportWorker = financeReportJobWith(SEND_DEFERRED_REFUNDS_REPORT_WORKER);
export const sendFinancesReportWorker = financeReportJobWith(SEND_FINANCES_REPORT_WORKER);
export const sendStripeBalanceSummariesReportJob = financeReportJobWith(SEND_STRIPE_BALANCE_SUMMARIES_REPORT_JOB);
export const sendDailyFinanceLedgerReportJob = financeReportJobWith(SEND_DAILY_FINANCE_LEDGER_REPORT_JOB);

export const emailOutstandingBalancesCsvWorkerRetriesExhausted = financeReportRetriesExhaustedWith(
  EMAIL_OUTSTANDING_BALANCES_CSV_WORKER,
);
export const sendStripeCurrencyBalancesReportJobRetriesExhausted = financeReportRetriesExhaustedWith(
  SEND_STRIPE_CURRENCY_BALANCES_REPORT_JOB,
);
export const sendDeferredRefundsReportWorkerRetriesExhausted = financeReportRetriesExhaustedWith(
  SEND_DEFERRED_REFUNDS_REPORT_WORKER,
);
export const sendFinancesReportWorkerRetriesExhausted = financeReportRetriesExhaustedWith(SEND_FINANCES_REPORT_WORKER);
export const sendStripeBalanceSummariesReportJobRetriesExhausted = financeReportRetriesExhaustedWith(
  SEND_STRIPE_BALANCE_SUMMARIES_REPORT_JOB,
);
export const sendDailyFinanceLedgerReportJobRetriesExhausted = financeReportRetriesExhaustedWith(
  SEND_DAILY_FINANCE_LEDGER_REPORT_JOB,
);
