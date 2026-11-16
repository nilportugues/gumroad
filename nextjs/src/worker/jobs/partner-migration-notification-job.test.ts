// Replays partner-migration-notification-job.golden.json (scripts/golden/partner-migration-notification-job.rb): the job run by the real
// app as a Sidekiq job. Node sends the statements Rails sent up to its result email, which it hands back (the transaction rolls back
// with nothing written), and repeats the quiet `notified_at` updates and the errors Ruby raised.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { partnerMigrationNotificationJobWith } from "./partner-migration-notification-job.ts";

const golden = loadGolden(new URL("./__fixtures__/partner-migration-notification-job.golden.json", import.meta.url));

replayJobGolden(
  "PartnerMigrationNotificationJob",
  golden,
  partnerMigrationNotificationJobWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
);
