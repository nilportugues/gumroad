// Replays reverse-deferred-internal-transfer-job.golden.json (scripts/golden/reverse-deferred-internal-transfer-job.rb): the job and the
// block of its sidekiq_retries_exhausted run by the real app. Node sends the one `payments` read Rails sent, returns where Rails
// returns, raises Rails' RecordNotFound for a missing payment, and hands a payment that would reach Stripe back before that call.
import { loadGolden, replayHookGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import {
  reverseDeferredInternalTransferJobRetriesExhausted,
  reverseDeferredInternalTransferJobWith,
} from "./reverse-deferred-internal-transfer-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/reverse-deferred-internal-transfer-job.golden.json", import.meta.url),
);
const isHook = (c: { name: string }) => c.name.startsWith("exhausted: ");

// Rails casts a float and a word, and reads `id IS NULL` for nil in `find`; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "ReverseDeferredInternalTransferJob",
  { now: golden.now, cases: golden.cases.filter((c) => !isHook(c)) },
  reverseDeferredInternalTransferJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);

replayHookGolden(
  "ReverseDeferredInternalTransferJob, sidekiq_retries_exhausted",
  { now: golden.now, cases: golden.cases.filter(isHook) },
  reverseDeferredInternalTransferJobRetriesExhausted,
  (c) => c.args.length === 1 && c.args[0] !== null && castByRails(c.args[0]),
);
