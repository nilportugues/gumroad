// Port of app/sidekiq/dispute_evidence_due_soon_reminder_job.rb. ContactingCreatorMailer stays in
// Ruby, so the mail is pushed for Rails exactly as `deliver_later(queue: "default")` pushes it.
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

const MAILER = "ContactingCreatorMailer";
const METHOD = "chargeback_evidence_due_soon";

export const disputeEvidenceDueSoonReminderJob: JobHandler = async (args, { runtime }) => {
  checkArity(args, 1);
  const [disputeId] = args;
  if (typeof disputeId !== "number" && typeof disputeId !== "string" && disputeId !== null) throw new TypeError(`dispute_id not ported: ${JSON.stringify(disputeId)}`);
  await deliverLater(runtime, { mailer: MAILER, method: METHOD, args: [disputeId], queue: "default" }, mailRoute(MAILER, METHOD));
};
