// Port of app/sidekiq/recover_stranded_buyers_job.rb, up to the first stranded candidate: Risk::StrandedBuyerScanService's candidate
// emails (buyers whose newest checkouts failed on a platform block in the last 30 days, 20,000 at most), then per slice of 500 the
// settled-history counts (three paid purchases older than 60 days) and the dispute filter. A run where no candidate survives them
// has nothing stranded and finishes. The first buyer who survives needs the latest-failure reads, DecliningPlatformBlocks and the
// recovery service, so the run hands back there; nothing has been written (the scan only reads).
// Golden: __fixtures__/recover-stranded-buyers-job.golden.json (scripts/golden/recover-stranded-buyers-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { scanUntilSurvivor } from "./stranded-buyer-scan.ts";
import { modelJob } from "./support/job-deps.ts";

export const recoverStrandedBuyersJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const { survivor } = await scanUntilSurvivor(deps.now());
  if (survivor)
    throw new HandBackToRuby("a stranded-buyer candidate needs the latest failures and DecliningPlatformBlocks");
});

export const recoverStrandedBuyersJob = recoverStrandedBuyersJobWith();
