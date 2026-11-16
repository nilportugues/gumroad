// Replays resume-stalled-partner-migrations-job.golden.json (scripts/golden/resume-stalled-partner-migrations-job.rb): the job run by the
// real app as a Sidekiq job. Node sends the `stalled` scan Rails sent with the same cut-off, finishes when nothing stalled and hands the
// first stalled migration back before `resume_stalled_import!`.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { resumeStalledPartnerMigrationsJobWith } from "./resume-stalled-partner-migrations-job.ts";

const golden = loadGolden(new URL("./__fixtures__/resume-stalled-partner-migrations-job.golden.json", import.meta.url));

replayJobGolden(
  "ResumeStalledPartnerMigrationsJob",
  golden,
  resumeStalledPartnerMigrationsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
);
