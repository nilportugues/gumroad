// Replays custom-domain-verification-worker.golden.json (scripts/golden/custom-domain-verification-worker.rb): the job run by the real
// app as a Sidekiq job. Node sends the statements Rails sent for the read and for `valid?` (uniqueness and owner lookups), returns for
// a deleted or invalid domain, and hands a valid one back before the DNS lookups.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { customDomainVerificationWorkerWith } from "./custom-domain-verification-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/custom-domain-verification-worker.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "CustomDomainVerificationWorker",
  golden,
  customDomainVerificationWorkerWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);
