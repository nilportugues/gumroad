// Port of app/sidekiq/send_workflow_emails_to_opened_non_clickers_job.rb up to `Workflow#workflow_trigger_post`. The installment and its
// workflow are read in Node, and every guard that ends the run before the trigger post runs here: no installment, no workflow, a workflow
// that does not watch an opened-no-click trigger, a workflow or email that is deleted, an email that is not published. A run that passes
// them resolves the post through the seller's emailed posts and goes on to the rule, the seller fanout lock, DynamoDB and the sends, so
// it hands back to Rails whole before any of that. A `minimum_rule_version` Node does not read as present or blank (a String, Array or
// Hash) and an id Rails casts (a Float, a word) hand back before any statement.
// Golden: __fixtures__/send-workflow-emails-to-opened-non-clickers-job.golden.json
// (scripts/golden/send-workflow-emails-to-opened-non-clickers-job.rb).
import { type Installment } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import { InstallmentPost } from "../../server/models/installment-post.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";

import { modelJob } from "./support/job-deps.ts";

const OPENED_NO_CLICK_WORKFLOW_TRIGGER = "opened_no_click";

// `minimum_rule_version.present?`: nil and false are blank, a number or true is present.
function pinnedToPrimary(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true || typeof value === "number" || typeof value === "bigint" || value instanceof RubyFloat)
    return true;
  throw new HandBackToRuby("a minimum rule version that is a String, Array or Hash");
}

export const sendWorkflowEmailsToOpenedNonClickersJobWith = modelJob(
  { min: 1, max: 4 },
  async ([installmentIdArg, , , minimumRuleVersion]) => {
    // find_by(id: nil) still asks `id IS NULL`.
    const installmentId = await beforeSideEffects(() =>
      installmentIdArg === null ? null : recordIdFrom(installmentIdArg, "Installment.find_by"),
    );
    const pinned = await beforeSideEffects(() => pinnedToPrimary(minimumRuleVersion));

    // with_primary_database(minimum_rule_version.present?); nothing below writes.
    const guards = async () => {
      const row = await findOneBy<Installment>("Installment", "id", installmentId, true);
      if (row === null) return;
      const installment = new InstallmentPost(row);

      const workflow = await installment.workflow();
      if (workflow === null || workflow.workflowTrigger !== OPENED_NO_CLICK_WORKFLOW_TRIGGER) return;
      if (workflow.row.deleted_at !== null || row.deleted_at !== null || row.published_at === null) return;

      throw new HandBackToRuby(
        "the trigger post is resolved through the seller's emailed posts, then the sends are queued",
      );
    };
    await (pinned ? connectedTo("writing", guards) : guards());
  },
);
export const sendWorkflowEmailsToOpenedNonClickersJob = sendWorkflowEmailsToOpenedNonClickersJobWith();
