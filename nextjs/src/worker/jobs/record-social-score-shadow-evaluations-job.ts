// Port of app/sidekiq/record_social_score_shadow_evaluations_job.rb up to the scoring: the cron tick (no date) re-enqueues itself with
// today's date pinned, and a dated run reads the verified user ids 500 at a time with a replica lag check before each slice. The first slice
// holding a user goes to SocialScoreShadowEvaluationService (the scoring and the evaluation rows), which stays with Rails: the job is handed
// back right after that user read, before anything is evaluated or written, so the sweep is safe to rerun (rows are idempotent per user and
// day). A date that is not `YYYY-MM-DD` hands back before any statement, because Date.parse reads many other shapes.
// Golden: __fixtures__/record-social-score-shadow-evaluations-job.golden.json (scripts/golden/record-social-score-shadow-evaluations-job.rb);
// the scoring service answered nil there.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { columnIn, findInBatches, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SOCIAL_CONNECT_VERIFICATIONS = "social_connect_verifications";
const USERS = "users";
const BATCH_SIZE = 500;
const USER_BATCH_SIZE = 1_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

// Date.parse for the one shape this job writes itself; a day the calendar lacks raises in Ruby, so Node hands it back too.
function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const recordSocialScoreShadowEvaluationsJobWith = modelJob({ min: 0, max: 1 }, async ([evaluatedOn], deps) => {
  if (evaluatedOn === undefined || evaluatedOn === null) {
    // Time.current.to_date.to_s (the app time zone is UTC)
    await performAsync("RecordSocialScoreShadowEvaluationsJob", [deps.now().toISOString().slice(0, 10)]);
    return;
  }
  if (typeof evaluatedOn !== "string" || !isIsoDate(evaluatedOn))
    throw new HandBackToRuby("the date is not a YYYY-MM-DD string");

  const rows = await selectRows<{ user_id: bigint | number }>(
    Prisma.sql`SELECT DISTINCT ${Prisma.raw(`${quoteName(SOCIAL_CONNECT_VERIFICATIONS)}.\`user_id\``)} FROM ${table(SOCIAL_CONNECT_VERIFICATIONS)}`,
  );
  const userIds = rows.map((row) => row.user_id);
  for (let start = 0; start < userIds.length; start += BATCH_SIZE) {
    await deps.watchReplicaLag();
    await findInBatches(USERS, columnIn(USERS, "id", userIds.slice(start, start + BATCH_SIZE)), USER_BATCH_SIZE, () =>
      Promise.reject(new HandBackToRuby("SocialScoreShadowEvaluationService is not ported")),
    );
  }
});

export const recordSocialScoreShadowEvaluationsJob = recordSocialScoreShadowEvaluationsJobWith();
