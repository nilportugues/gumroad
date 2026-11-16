// Replays dispatch-pending-partner-migration-notifications-job.golden.json
// (scripts/golden/dispatch-pending-partner-migration-notifications-job.rb): the job run by the real app as a Sidekiq job. Node sends
// the join Rails sent, with the same cut-off, and queues the same PartnerMigrationNotificationJob pushes.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { dispatchPendingPartnerMigrationNotificationsJobWith } from "./dispatch-pending-partner-migration-notifications-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/dispatch-pending-partner-migration-notifications-job.golden.json", import.meta.url),
);

replayJobGolden(
  "DispatchPendingPartnerMigrationNotificationsJob",
  golden,
  dispatchPendingPartnerMigrationNotificationsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
);
