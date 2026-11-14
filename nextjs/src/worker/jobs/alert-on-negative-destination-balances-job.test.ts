// Replays alert-on-negative-destination-balances-job.golden.json (scripts/golden/alert-on-negative-destination-balances-job.rb): the job
// run by the real app as a Sidekiq job. Node sends the candidate scan Rails sent, with the payout cutoff of the day, and finishes a run
// that keeps no pair; a run that keeps one hands back after the scan, before any write. Each case records its own clock (`case_now`).
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { alertOnNegativeDestinationBalancesJobWith } from "./alert-on-negative-destination-balances-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/alert-on-negative-destination-balances-job.golden.json", import.meta.url),
);

const byClock = new Map<number, JobCase[]>();
for (const c of golden.cases) {
  const clock = (c as JobCase & { case_now: number | RubyFloat }).case_now;
  const at = clock instanceof RubyFloat ? clock.value : clock;
  byClock.set(at, [...(byClock.get(at) ?? []), c]);
}

for (const [at, cases] of byClock) {
  replayJobGolden(
    `AlertOnNegativeDestinationBalancesJob at ${new Date(at * 1000).toISOString()}`,
    { now: at, cases },
    alertOnNegativeDestinationBalancesJobWith({ now: () => new Date(Math.round(at * 1000)) }),
  );
}
