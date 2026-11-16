// Port of app/sidekiq/reconcile_pending_paypal_refunds_job.rb up to the first refund it would reconcile: the hourly sweep for PayPal
// refunds that are still pending three days after they were accepted. A sweep that finds none is the whole job; one that finds a
// refund asks PayPal for its status (`PaypalChargeProcessor.fetch_refund_status`) and may complete or fail the refund, which Node
// does not port, so the job goes back to Rails before it writes anything.
// Golden: __fixtures__/reconcile-pending-paypal-refunds-job.golden.json (scripts/golden/reconcile-pending-paypal-refunds-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { uncached } from "../../server/models/runtime/query-cache.ts";
import { quote } from "../../server/models/runtime/quoting.ts";
import { selectRows } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SECOND_MS = 1000;
const MINIMUM_AGE_MS = 3 * 24 * 60 * 60 * SECOND_MS;
const FIND_EACH_BATCH_SIZE = 1000;

export const reconcilePendingPaypalRefundsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  // `refunds.created_at` has whole-second precision, so Rails binds the cutoff truncated to the second.
  const cutoff = new Date(Math.floor((deps.now().getTime() - MINIMUM_AGE_MS) / SECOND_MS) * SECOND_MS);
  const refunds = await uncached(() =>
    selectRows(
      Prisma.raw(
        `SELECT \`refunds\`.* FROM \`refunds\` INNER JOIN \`purchases\` ON \`purchases\`.\`id\` = \`refunds\`.\`purchase_id\` WHERE \`refunds\`.\`status\` IN ('PENDING', 'pending') AND NOT ((\`refunds\`.\`processor_refund_id\` = '' OR \`refunds\`.\`processor_refund_id\` IS NULL)) AND \`purchases\`.\`charge_processor_id\` = 'paypal' AND \`refunds\`.\`created_at\` < ${quote(cutoff)} AND (COALESCE(refunds.json_data->>'$.paypal_refund_unreadable_at', '') IN ('', 'null') OR COALESCE(refunds.json_data->>'$.paypal_refund_unreadable_issue', '') != 'closed_user') ORDER BY \`refunds\`.\`id\` ASC LIMIT ${FIND_EACH_BATCH_SIZE}`,
      ),
    ),
  );
  if (refunds.length > 0)
    throw new HandBackToRuby(
      "a pending PayPal refund to reconcile (PaypalChargeProcessor.fetch_refund_status is not ported)",
    );
});

export const reconcilePendingPaypalRefundsJob = reconcilePendingPaypalRefundsJobWith();
