// Ports of the two weekly payout batch jobs, as far as they need neither the in-flight token nor the query cap:
// PerformPayoutsUpToDelayDaysAgoWorker given several bank account types only pushes one job per type, and
// PerformPayoutsForUserSliceWorker given no seller ids returns. Everything else wraps its reads in
// `with_payout_batch_in_flight` and `WithMaxExecutionTime.timeout_queries` (a session `set max_execution_time` that a
// pooled Node connection cannot hold), so it hands the whole job back before the first statement or Redis write.
// Golden: __fixtures__/payout-batch-fan-out.golden.json (scripts/golden/payout-batch-fan-out.rb).
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import type { RetriesExhausted } from "../retry.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const ORCHESTRATOR = "PerformPayoutsUpToDelayDaysAgoWorker";
const ASCII_BLANK = /^[ \t\n\v\f\r]*$/u;

// `blank?` for a JSON value; a string with any other kind of whitespace is left to Ruby (Unicode spaces count as blank there).
function isBlank(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return ASCII_BLANK.test(value);
  if (typeof value === "object" && !(value instanceof RubyFloat)) return Object.keys(value).length === 0;
  return false;
}

export const performPayoutsUpToDelayDaysAgoWorker: JobHandler = async (args, { runtime }) => {
  checkArity(args, 1, 2);
  const [payoutProcessorType, bankAccountTypes] = args as [JsonValue, JsonValue | undefined];
  if (!Array.isArray(bankAccountTypes) || bankAccountTypes.length < 2) {
    throw new HandBackToRuby("the batch reads the holding balances inside the in-flight token and the query cap");
  }
  // One job per type: a slow `holding_balance` read then aborts only its own type's payouts.
  for (const bankAccountType of bankAccountTypes) {
    await enqueueWith(runtime, ORCHESTRATOR, [payoutProcessorType, [bankAccountType]]);
  }
};

export const performPayoutsForUserSliceWorker: JobHandler = (args) => {
  checkArity(args, 3, 4);
  if (isBlank(args[2])) return Promise.resolve();
  return Promise.reject(
    new HandBackToRuby("the slice's eligibility walk runs inside the in-flight token and the query cap"),
  );
};

// Both hooks mail the failure (`AccountingMailer.payout_batch_failed` / `payout_batch_slice_failed`) and report it; Ruby keeps
// them, with one last attempt.
const handBackExhausted: RetriesExhausted = () =>
  Promise.reject(new HandBackToRuby("the failure mail names the batch and is sent from Rails"));
export const performPayoutsUpToDelayDaysAgoWorkerRetriesExhausted = handBackExhausted;
export const performPayoutsForUserSliceWorkerRetriesExhausted = handBackExhausted;
