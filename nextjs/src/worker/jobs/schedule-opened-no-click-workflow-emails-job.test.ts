// Replays schedule-opened-no-click-workflow-emails-job.golden.json (scripts/golden/schedule-opened-no-click-workflow-emails-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the join and the batch reads Rails sent and queues the same pushes.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { scheduleOpenedNoClickWorkflowEmailsJobWith } from "./schedule-opened-no-click-workflow-emails-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/schedule-opened-no-click-workflow-emails-job.golden.json", import.meta.url),
);

replayJobGolden("ScheduleOpenedNoClickWorkflowEmailsJob", golden, scheduleOpenedNoClickWorkflowEmailsJobWith());
