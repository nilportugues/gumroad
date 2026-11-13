// Port of app/sidekiq/send_bundles_marketing_email_job.rb up to the first seller: the scan of sellers paid out in the last year runs in
// Node, and a year with none ends here. The first batch that has a seller checks replica lag and goes back to Rails whole, because
// each seller's bundles come from `Link.search` (Elasticsearch) and end in an enqueued mail; nothing has been written by then.
// Golden: __fixtures__/send-bundles-marketing-email-job.golden.json (scripts/golden/send-bundles-marketing-email-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago, truncateToSeconds } from "../../server/models/concerns/ruby-time.ts";
import { column, findInBatches, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const USERS = "users";
const PAYMENTS = "payments";
const BATCH_SIZE = 1000;

export const sendBundlesMarketingEmailJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  // `Payment.completed.where(created_at: 1.year.ago..)`: a typed condition on a `datetime` column floors the time to the second.
  const since = truncateToSeconds(ago({ years: 1 }, deps.now()));
  await findInBatches(
    USERS,
    Prisma.sql`(${column(USERS, "user_risk_state")} NOT IN ('suspended_for_fraud', 'suspended_for_tos_violation')) AND ${column(USERS, "deleted_at")} IS NULL AND ${column(PAYMENTS, "state")} = 'completed' AND ${column(PAYMENTS, "created_at")} >= ${since}`,
    BATCH_SIZE,
    async () => {
      await deps.watchReplicaLag();
      throw new HandBackToRuby("a seller's bundles are searched in Elasticsearch and mailed");
    },
    Prisma.raw("DISTINCT users.id, users.currency_type"),
    Prisma.sql`INNER JOIN ${table(PAYMENTS)} ON ${column(PAYMENTS, "user_id")} = ${column(USERS, "id")}`,
  );
});
export const sendBundlesMarketingEmailJob = sendBundlesMarketingEmailJobWith();
