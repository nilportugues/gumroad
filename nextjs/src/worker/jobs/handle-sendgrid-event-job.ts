// Port of app/sidekiq/handle_sendgrid_event_job.rb: each event of the batch goes through SendgridEventInfo and, unless that is
// `invalid?`, through HandleEmailEventInfo. Node drops the events Ruby drops and runs the receipt events (of a purchase or of a charge) and the events no handler
// claims (support/email-event-info.ts). The whole batch is parsed and planned first: an event another handler would act on, or one
// whose parsing raises in Ruby, hands the job back before any statement, so Rails runs it from the start.
// Golden: __fixtures__/handle-sendgrid-event-job.golden.json (scripts/golden/handle-sendgrid-event-job.rb).
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { rubyToI } from "../../server/mail/mailer-info.ts";
import { isBlank } from "../../server/webhooks/json-guards.ts";

import { handleEmailEvents, type EmailEventInfo } from "./support/email-event-info.ts";
import { modelJob } from "./support/job-deps.ts";

// EmailEventInfo::TRACKED_EVENTS for SendGrid, inverted
const TRACKED_EVENTS: Record<string, EmailEventInfo["type"]> = {
  bounce: "bounced",
  delivered: "delivered",
  open: "opened",
  click: "clicked",
  spamreport: "complained",
};
const PREORDER_RECEIPT = "CustomerMailer.preorder_receipt";
// A timestamp whose Time Ruby and JS both hold exactly.
const MAX_TIMESTAMP = 1e11;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

// `SendgridEventInfo.new(event)`, as far as HandleEmailEventInfo reads it: null when the event is `invalid?`.
function sendgridEventInfo(event: unknown): EmailEventInfo | null {
  if (!isObject(event)) throw new HandBackToRuby("a SendGrid event that is not a hash");
  let createdAt: Date | null = null;
  let createdAtExact = true;
  if ("timestamp" in event) {
    // `Time.zone.at(timestamp)` raises for anything but a number.
    if (
      typeof event.timestamp !== "number" ||
      !Number.isFinite(event.timestamp) ||
      Math.abs(event.timestamp) > MAX_TIMESTAMP
    )
      throw new HandBackToRuby("a SendGrid timestamp that is not a number Node follows");
    createdAt = new Date(Math.floor(event.timestamp * 1000));
    // A fractional timestamp is a Float whose microseconds the Time keeps and a Date does not.
    createdAtExact = Number.isInteger(event.timestamp);
  }
  const type = typeof event.event === "string" ? TRACKED_EVENTS[event.event] : undefined;

  let info: Pick<EmailEventInfo, "mailerClass" | "mailerMethod" | "chargeId" | "purchaseId">;
  let mailerArgs: unknown;
  if (!isBlank(event.type) && !isBlank(event.identifier)) {
    // The old shape: `split` and `gsub` raise for anything but strings, and a preorder receipt reads the preorder.
    if (typeof event.type !== "string" || typeof event.identifier !== "string" || event.type === PREORDER_RECEIPT)
      throw new HandBackToRuby("a SendGrid event of the old shape Node does not follow");
    // `type.split(".", 2)`
    const dot = event.type.indexOf(".");
    mailerArgs = event.identifier;
    const firstArgument = event.identifier.replaceAll(/[[\]]/gu, "").split(",")[0] ?? "";
    info = {
      mailerClass: dot < 0 ? event.type : event.type.slice(0, dot),
      mailerMethod: dot < 0 ? null : event.type.slice(dot + 1),
      chargeId: undefined,
      purchaseId: rubyToI(firstArgument),
    };
  } else {
    mailerArgs = event.mailer_args;
    info = {
      mailerClass: stringOrNull(event.mailer_class),
      mailerMethod: stringOrNull(event.mailer_method),
      chargeId: event.charge_id,
      purchaseId: event.purchase_id,
    };
  }
  if (type === undefined || isBlank(mailerArgs)) return null;
  return {
    provider: "sendgrid",
    type,
    installmentId: event.installment_id,
    createdAt,
    createdAtSubMillisecondMicros: 0,
    createdAtExact,
    email: event.email,
    mailerArgs,
    ...info,
  };
}

export const handleSendgridEventJobWith = modelJob({ min: 1, max: 1 }, async ([params], deps) => {
  if (!isObject(params)) throw new HandBackToRuby("SendGrid params that are not a hash");
  const json = params._json;
  if (json === undefined) throw new HandBackToRuby("SendGrid params without _json");
  const events = Array.isArray(json) ? json : [json];
  const infos = events.map((event) => sendgridEventInfo(event)).filter((info): info is EmailEventInfo => info !== null);
  await handleEmailEvents(infos, deps.now);
});

export const handleSendgridEventJob = handleSendgridEventJobWith();
