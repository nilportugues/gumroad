// Port of app/sidekiq/send_workflow_email_to_opened_non_clicker_job.rb up to the send. Every check that can end the job runs in Node;
// a send that passes them all goes back to Rails whole, because `send_installment_from_workflow_for_opened_no_click` reads DynamoDB
// for a click, then the sale and its subscription, and mails.
// Golden: __fixtures__/send-workflow-email-to-opened-non-clicker-job.golden.json
// (scripts/golden/send-workflow-email-to-opened-non-clicker-job.rb).
import { type Installment } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { retiredFor } from "../../server/models/installment-send.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { RISK_STATES } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const OPENED_NO_CLICK_WORKFLOW_TRIGGER = "opened_no_click";

export const sendWorkflowEmailToOpenedNonClickerJobWith = modelJob(
  { min: 4, max: 4 },
  async ([installmentIdArg, ruleVersion]) => {
    // find_by(id: nil) still asks `id IS NULL`.
    const installmentId = await beforeSideEffects(() =>
      installmentIdArg === null ? null : recordIdFrom(installmentIdArg, "Installment.find_by"),
    );

    // with_primary_database; nothing below writes, so a shape Node does not read goes back whole.
    await beforeSideEffects(() =>
      connectedTo("writing", async () => {
        const row = await findOneBy<Installment>("Installment", "id", installmentId, true);
        if (row === null) return;
        const installment = new InstallmentPost(row);

        const workflow = await installment.workflow();
        if (workflow === null || workflow.workflowTrigger !== OPENED_NO_CLICK_WORKFLOW_TRIGGER) return;
        const seller = await installment.seller();
        if (seller !== null && (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state))
          return;
        if (installment.followerType || installment.audienceType) {
          // retired_for?(nil) asks `seller_id IS NULL`, which retiredFor does not.
          if (row.seller_id === null) throw new HandBackToRuby("a follower or audience email with no seller");
          if (await retiredFor(row.seller_id)) return;
        }
        if (workflow.row.deleted_at !== null || row.deleted_at !== null || row.published_at === null) return;

        const rule = await installment.installmentRule();
        if (rule === null) return;
        // rule.version != rule_version: an Integer equals only a number; a Float (a RubyFloat) goes to Rails.
        if (ruleVersion instanceof RubyFloat || typeof ruleVersion === "bigint")
          throw new HandBackToRuby("a rule version that is a Float or past 2**53");
        if (typeof ruleVersion !== "number" || rule.version !== ruleVersion) return;

        throw new HandBackToRuby("a send that passed every check");
      }),
    );
  },
);
export const sendWorkflowEmailToOpenedNonClickerJob = sendWorkflowEmailToOpenedNonClickerJobWith();
