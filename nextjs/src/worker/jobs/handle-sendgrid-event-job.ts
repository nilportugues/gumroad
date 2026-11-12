// Port of app/sidekiq/handle_sendgrid_event_job.rb: each event of the batch goes through SendgridEventInfo and, unless that is
// `invalid?`, through HandleEmailEventInfo. Node answers the events the job drops (an event type we do not track, or one without
// mailer arguments); the first event it would act on, and any event whose parsing raises in Ruby, hands the whole job back. Nothing
// has been written by then (the dropped events write nothing), so Rails runs it from the start.
// Golden: __fixtures__/handle-sendgrid-event-job.golden.json (scripts/golden/handle-sendgrid-event-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { isBlank } from "../../server/webhooks/json-guards.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

// EmailEventInfo::TRACKED_EVENTS for SendGrid, inverted
const TRACKED_EVENTS = new Set(["bounce", "delivered", "open", "click", "spamreport"]);
const PREORDER_RECEIPT = "CustomerMailer.preorder_receipt";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `SendgridEventInfo.new(event).invalid?`, for an event whose constructor Node can follow without a query.
function isInvalid(event: unknown): boolean {
  if (!isObject(event)) throw new HandBackToRuby("a SendGrid event that is not a hash");
  // `Time.zone.at(timestamp)` raises for anything but a number.
  if ("timestamp" in event && !(typeof event.timestamp === "number" && Number.isFinite(event.timestamp)))
    throw new HandBackToRuby("a SendGrid timestamp that is not a number");
  const tracked = typeof event.event === "string" && TRACKED_EVENTS.has(event.event);
  if (!isBlank(event.type) && !isBlank(event.identifier)) {
    // The old shape: `split` and `gsub` raise for anything but strings, and a preorder receipt reads the preorder.
    if (typeof event.type !== "string" || typeof event.identifier !== "string" || event.type === PREORDER_RECEIPT)
      throw new HandBackToRuby("a SendGrid event of the old shape Node does not follow");
    return !tracked;
  }
  return !tracked || isBlank(event.mailer_args);
}

// eslint-disable-next-line @typescript-eslint/require-await -- JobHandler is async; this port only reads its argument
export const handleSendgridEventJob: JobHandler = async (args) => {
  checkArity(args, 1);
  const [params] = args;
  if (!isObject(params)) throw new HandBackToRuby("SendGrid params that are not a hash");
  const json = params._json;
  if (json === undefined) throw new HandBackToRuby("SendGrid params without _json");
  const events = Array.isArray(json) ? json : [json];
  for (const event of events)
    if (!isInvalid(event)) throw new HandBackToRuby("a SendGrid event HandleEmailEventInfo acts on");
};
