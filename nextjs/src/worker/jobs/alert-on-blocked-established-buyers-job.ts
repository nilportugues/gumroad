// Port of app/sidekiq/alert_on_blocked_established_buyers_job.rb up to a stranded buyer: Risk::StrandedBuyerScanService's candidate
// emails, settled-history counts and dispute filter (stranded-buyer-scan.ts). A scan where nobody survives them has nothing stranded
// and the job returns without notifying. A surviving buyer needs the latest-failure reads and DecliningPlatformBlocks, and a scan
// that hit its candidate budget reports even when nobody qualifies, so both are handed back; the job has written nothing by then.
// Golden: __fixtures__/alert-on-blocked-established-buyers-job.golden.json (scripts/golden/alert-on-blocked-established-buyers-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";

import { scanUntilSurvivor } from "./stranded-buyer-scan.ts";
import { modelJob } from "./support/job-deps.ts";

export const alertOnBlockedEstablishedBuyersJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const { survivor, truncated } = await scanUntilSurvivor(deps.now());
  if (survivor)
    throw new HandBackToRuby("a stranded-buyer candidate needs the latest failures and DecliningPlatformBlocks");
  if (truncated) throw new HandBackToRuby("a truncated scan reports even when no buyer qualifies");
});

export const alertOnBlockedEstablishedBuyersJob = alertOnBlockedEstablishedBuyersJobWith();
