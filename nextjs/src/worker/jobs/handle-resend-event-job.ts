// Port of app/sidekiq/handle_resend_event_job.rb: `return if ResendEventInfo.new(event_json).invalid?`, then
// HandleEmailEventInfo. Node answers the events the job drops (an event type we do not track, or a mail that did not come from our
// mailers); an event it would act on, and one whose parsing raises in Ruby, is handed back before any statement, as is a payload
// the parser cannot judge with certainty (`resendEventIsTrackable` throws NotPortedError for those).
// Golden: __fixtures__/handle-resend-event-job.golden.json (scripts/golden/handle-resend-event-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { NotPortedError } from "../../server/page-props/not-ported.ts";
import { resendEventIsTrackable } from "../../server/webhooks/email-webhooks.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/require-await -- JobHandler is async; this port only reads its argument
export const handleResendEventJob: JobHandler = async (args) => {
  checkArity(args, 1);
  const [eventJson] = args;
  if (eventJson === null || typeof eventJson !== "object" || Array.isArray(eventJson))
    throw new HandBackToRuby("a Resend event that is not a hash");
  try {
    if (resendEventIsTrackable(eventJson as Record<string, unknown>))
      throw new HandBackToRuby("a Resend event HandleEmailEventInfo acts on");
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRuby(error.message);
    throw error;
  }
};
