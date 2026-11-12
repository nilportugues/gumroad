// Port of app/sidekiq/handle_resend_event_job.rb: `return if ResendEventInfo.new(event_json).invalid?`, then HandleEmailEventInfo.
// Node drops the events Ruby drops and runs the receipt events and the events no handler claims (support/email-event-info.ts). An
// event another handler would act on, one whose parsing raises in Ruby, and a payload the parser cannot judge with certainty
// (`parseResendEvent` throws NotPortedError for those) are handed back before any statement.
// Golden: __fixtures__/handle-resend-event-job.golden.json (scripts/golden/handle-resend-event-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { NotPortedError } from "../../server/page-props/not-ported.ts";
import { parseResendEvent, type ResendEventFields } from "../../server/webhooks/email-webhooks.ts";

import { handleEmailEvents, type EmailEventInfo } from "./support/email-event-info.ts";
import { modelJob } from "./support/job-deps.ts";

function parse(eventJson: Record<string, unknown>): ResendEventFields {
  try {
    const fields = parseResendEvent(eventJson);
    if (fields === null) throw new HandBackToRuby("a Resend event whose parsing raises in Ruby");
    return fields;
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRuby(error.message);
    throw error;
  }
}

export const handleResendEventJobWith = modelJob({ min: 1, max: 1 }, async ([eventJson], deps) => {
  if (eventJson === null || typeof eventJson !== "object" || Array.isArray(eventJson))
    throw new HandBackToRuby("a Resend event that is not a hash");
  const fields = parse(eventJson as Record<string, unknown>);
  if (fields.invalid) return;
  const info: EmailEventInfo = {
    provider: "resend",
    type: fields.type as EmailEventInfo["type"],
    mailerClass: fields.mailerClass,
    mailerMethod: fields.mailerMethod,
    installmentId: fields.installmentId,
    chargeId: fields.chargeId,
    purchaseId: fields.purchaseId,
    createdAt: fields.createdAt,
  };
  await handleEmailEvents([info], deps.now);
});

export const handleResendEventJob = handleResendEventJobWith();
