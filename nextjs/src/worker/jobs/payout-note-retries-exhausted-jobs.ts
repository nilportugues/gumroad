// Ports of HandleNewBankAccountWorker (app/sidekiq/handle_new_bank_account_worker.rb) and DeleteGuardianStripePersonJob
// (app/sidekiq/delete_guardian_stripe_person_job.rb) with the `sidekiq_retries_exhausted` blocks they define: a seller-invisible payout
// note (`User#add_payout_note`) is the durable record that the Stripe call gave up, then Sentry is told.
//
// Both perform bodies are one Stripe call (StripeMerchantAccountManager.handle_new_bank_account, StripeGuardianManager.delete_person_by_id),
// so they hand back: HandleNewBankAccountWorker after `BankAccount.find`, DeleteGuardianStripePersonJob before anything is read.
// Golden: __fixtures__/payout-note-retries-exhausted-jobs.golden.json (scripts/golden/payout-note-retries-exhausted-jobs.rb).
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import { addPayoutNoteTo } from "../../server/models/payment.ts";
import { findById, findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

export type PayoutNoteDeps = {
  now: () => Date;
  // ErrorNotifier.notify
  notify: (errorOrMessage: unknown) => void;
};

const defaultDeps: PayoutNoteDeps = { now: () => new Date(), notify: (errorOrMessage) => notifyError(errorOrMessage) };

// `find_by(id: value)`: nil asks for `id IS NULL`; an Integer, its digits or an integral Float find that row; a word casts to nil and
// matches nothing. Other strings cast by their leading digits in Ruby, which Node does not reproduce.
export function lookupKey(value: unknown): bigint | null | "nothing" {
  if (value === null || value === undefined) return null;
  if (value instanceof RubyFloat) {
    if (Number.isSafeInteger(value.value)) return BigInt(value.value);
    throw new NotPortedError(`find_by(id: ${value.value})`, "a Float id with a fraction");
  }
  if (typeof value === "string" && /^[A-Za-z_]+$/u.test(value)) return "nothing";
  return recordIdFrom(value, "find_by");
}

// String interpolation of a job argument: nil is empty. A Hash, an Array or an exotic Float prints in Ruby's own format.
function rubyToS(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (value instanceof RubyFloat && Number.isSafeInteger(value.value)) return `${value.value}.0`;
  throw new TypeError("a job argument whose Ruby to_s Node does not reproduce");
}

const isTruthy = (value: unknown) => value !== null && value !== undefined && value !== false;

// `find_by(id: "word")` casts the word to nil and asks `id = NULL`, which matches nothing.
export const findNothing = async (tableName: string): Promise<null> => {
  selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "id")} = NULL LIMIT 1`,
  );
  return null;
};

// The breadcrumb is written before the notification: the notifier is the transport most likely to be down, and a raise from it
// would skip the one record that outlives Sentry's retention.
async function recordBreadcrumb(userId: bigint, content: string, deps: PayoutNoteDeps): Promise<void> {
  await addPayoutNoteTo(userId, content, false, { now: deps.now });
}

export const handleNewBankAccountWorkerWith = modelJob({ min: 1, max: 2 }, async ([bankAccountId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(bankAccountId, "BankAccount.find"));
  await findByIdBang("BankAccount", id);

  throw new HandBackToRuby("the bank account is synced to Stripe");
});
export const handleNewBankAccountWorker = handleNewBankAccountWorkerWith();

export const handleNewBankAccountWorkerRetriesExhaustedWith =
  (overrides: Partial<PayoutNoteDeps> = {}): RetriesExhausted =>
  (msg, _error, { runtime }) => {
    const deps = { ...defaultDeps, ...overrides };
    return withJobsRuntime(runtime, async () => {
      const args = (msg.args ?? []) as unknown[];
      const key = lookupKey(args[0]);
      const bankAccount =
        key === "nothing"
          ? await findNothing("bank_accounts")
          : await findOneBy<{ id: bigint; user_id: bigint | null }>("BankAccount", "id", key, true);
      if (!bankAccount) return;

      const content = isTruthy(args[1])
        ? `Stripe holder-name sync exhausted retries for bank_account_id=${rubyToS(args[0])}. See Sentry for the underlying Stripe error.`
        : `Stripe bank sync failed and exhausted Sidekiq retries for bank_account_id=${rubyToS(args[0])}. See Sentry for the underlying Stripe error.`;
      try {
        const user = await findById<{ id: bigint }>("User", bankAccount.user_id);
        if (!user) throw new TypeError("undefined method 'add_payout_note' for nil");
        await recordBreadcrumb(user.id, content, deps);
      } catch (error) {
        console.error(
          `Failed to record payout-note breadcrumb for user ${String(bankAccount.user_id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.notify(error);
      }
    });
  };
export const handleNewBankAccountWorkerRetriesExhausted = handleNewBankAccountWorkerRetriesExhaustedWith();

export const deleteGuardianStripePersonJobWith = modelJob({ min: 3 }, () =>
  Promise.reject(new HandBackToRuby("the guardian's Stripe person is deleted")),
);
export const deleteGuardianStripePersonJob = deleteGuardianStripePersonJobWith();

export const deleteGuardianStripePersonJobRetriesExhaustedWith =
  (overrides: Partial<PayoutNoteDeps> = {}): RetriesExhausted =>
  (msg, _error, { runtime }) => {
    const deps = { ...defaultDeps, ...overrides };
    return withJobsRuntime(runtime, async () => {
      const [stripePersonId, stripeAccountId, userId] = ((msg.args ?? []) as unknown[]).concat([
        undefined,
        undefined,
        undefined,
      ]);
      const content =
        `GDPR erasure incomplete: guardian Stripe person ${rubyToS(stripePersonId)} on account ` +
        `${rubyToS(stripeAccountId)} could not be deleted and exhausted Sidekiq retries. The ` +
        "guardian's details are still held at Stripe. See Sentry for the underlying error.";

      try {
        const key = lookupKey(userId);
        const user =
          key === "nothing" ? await findNothing("users") : await findOneBy<{ id: bigint }>("User", "id", key, true);
        if (user) await recordBreadcrumb(user.id, content, deps);
      } catch (error) {
        console.error(
          `Failed to record erasure breadcrumb for user ${String(userId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.notify(error);
      }

      deps.notify(content);
    });
  };
export const deleteGuardianStripePersonJobRetriesExhausted = deleteGuardianStripePersonJobRetriesExhaustedWith();
