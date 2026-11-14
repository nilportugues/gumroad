// HandleEmailEventInfo (app/services/handle_email_event_info.rb) for the events Node can run: a receipt event on a purchase's or
// a charge's CustomerEmailInfo row, a piracy notice event on its PiracyReport, and any event no handler claims (which does nothing).
// The installment and abandoned cart handlers (DynamoDB engagement records, installment caches), a Sendgrid complaint (it
// unsubscribes the buyer) and a purchase or charge id that is not a plain integer are handed back before the first statement of
// the batch. A piracy report that is read and then turns out to be one Node cannot judge (a non-ASCII recipient, a row the model
// would refuse to save) is handed back after that one read.
// Golden: __fixtures__/handle-resend-event-job.golden.json and handle-sendgrid-event-job.golden.json.
import { HandBackToRuby } from "../../../server/jobs/hand-back.ts";
import { MicroDate } from "../../../server/models/concerns/ruby-time.ts";
import {
  alreadyDelivered,
  alreadyOpened,
  findOrInitializeForCharge,
  findOrInitializeForPurchase,
  isKnownState,
  markBounced,
  markDelivered,
  markOpened,
} from "../../../server/models/customer-email-info.ts";
import { findPiracyReport, isStructurallyValid, PiracyReports } from "../../../server/models/piracy-report.ts";
import { NotPortedError } from "../../../server/models/user.ts";
import { isBlank } from "../../../server/webhooks/json-guards.ts";

// EmailEventInfo constants
const CUSTOMER_MAILER = "CustomerMailer";
const TRACKED_RECEIPT_MAILER_METHODS = ["receipt", "preorder_receipt"];
const ABANDONED_CART_MAILER_METHOD = "abandoned_cart";
const PIRACY_REPORT_MAILER = "PiracyReportMailer";
const PIRACY_NOTICE_MAILER_METHOD = "notice";
// A Ruby Integer a bigint column holds and Node reads without rounding.
const PLAIN_INTEGER = /^\d{1,15}$/u;
const ASCII_LIMIT = 128;
const PLAIN_RUN = /\d+/u;

export type EmailEventInfo = {
  provider: "resend" | "sendgrid";
  // EVENT_BOUNCED ... EVENT_COMPLAINED, without the provider's prefix
  type: "bounced" | "delivered" | "opened" | "clicked" | "complained";
  mailerClass: string | null;
  mailerMethod: string | null;
  installmentId: unknown;
  chargeId: unknown;
  purchaseId: unknown;
  createdAt: Date | null;
  // The microseconds below the millisecond `createdAt` holds, and whether that is the whole of the provider's time.
  createdAtSubMillisecondMicros: number;
  createdAtExact: boolean;
  // The recipient and the `mailer_args` the piracy notice reads.
  email: unknown;
  mailerArgs: unknown;
};

type Plan =
  | { kind: "nothing" }
  | { kind: "piracy_notice"; reportId: bigint | null }
  | { kind: "receipt"; purchaseId: bigint }
  | { kind: "charge_receipt"; chargeId: bigint };

// Decides, without a statement, what HandleEmailEventInfo.perform does for the event; hands back what Node does not run.
export function planEmailEvent(info: EmailEventInfo): Plan {
  if (!isBlank(info.installmentId)) throw new HandBackToRuby("an email event for an installment");
  const isCustomerMailer = info.mailerClass === CUSTOMER_MAILER;
  if (isCustomerMailer && info.mailerMethod !== null && TRACKED_RECEIPT_MAILER_METHODS.includes(info.mailerMethod)) {
    if (info.type === "complained" && info.provider === "sendgrid")
      throw new HandBackToRuby("a SendGrid spam report on a receipt unsubscribes the buyer");
    if (!isBlank(info.chargeId)) return { kind: "charge_receipt", chargeId: idFrom(info.chargeId, "a charge id") };
    return { kind: "receipt", purchaseId: idFrom(info.purchaseId, "a purchase id") };
  }
  if (isCustomerMailer && info.mailerMethod === ABANDONED_CART_MAILER_METHOD)
    throw new HandBackToRuby("an abandoned cart email event");
  if (info.mailerClass === PIRACY_REPORT_MAILER && info.mailerMethod === PIRACY_NOTICE_MAILER_METHOD)
    return planPiracyNotice(info);
  return { kind: "nothing" };
}

// ForPiracyNotice: the report id is the first run of digits of the mailer args, and the delivery time is stored with its microseconds.
function planPiracyNotice(info: EmailEventInfo): Plan {
  if (info.mailerArgs !== null && info.mailerArgs !== undefined && typeof info.mailerArgs !== "string")
    throw new HandBackToRuby("piracy notice mailer args that are not text");
  if (info.email !== null && info.email !== undefined && (typeof info.email !== "string" || !isAscii(info.email)))
    throw new HandBackToRuby("a piracy notice recipient that is not ASCII text");
  if ((info.type === "delivered" || info.type === "bounced") && info.createdAt !== null && !info.createdAtExact)
    throw new HandBackToRuby("a piracy notice time finer than a microsecond");
  const digits = typeof info.mailerArgs === "string" ? PLAIN_RUN.exec(info.mailerArgs)?.[0] : undefined;
  if (digits === undefined) return { kind: "piracy_notice", reportId: null };
  if (!PLAIN_INTEGER.test(digits)) throw new HandBackToRuby("a piracy report id that is not a plain integer");
  return { kind: "piracy_notice", reportId: BigInt(digits) };
}

const isAscii = (value: string) => [...value].every((char) => char.codePointAt(0)! < ASCII_LIMIT);

// A url Ruby's URI parser may read differently than Node's pattern (NotPortedError) counts as one Node cannot judge.
function structurallyValid(report: Parameters<typeof isStructurallyValid>[0]): boolean {
  try {
    return isStructurallyValid(report);
  } catch (error) {
    if (error instanceof NotPortedError) return false;
    throw error;
  }
}

// The provider's time to the microsecond, as the datetime(6) column keeps it.
function withMicroseconds(info: EmailEventInfo): MicroDate {
  const milliseconds = info.createdAt!.getTime();
  const wholeSeconds = Math.floor(milliseconds / 1000);
  return new MicroDate(wholeSeconds, (milliseconds - wholeSeconds * 1000) * 1000 + info.createdAtSubMillisecondMicros);
}

// HandleEmailEventInfo::ForPiracyNotice#perform
async function performPiracyNotice(info: EmailEventInfo, reportId: bigint | null, now: () => Date): Promise<void> {
  const report = await findPiracyReport(reportId);
  if (report === null) return;
  const sentTo = report.get("sent_to_email") ?? "";
  // casecmp? folds Unicode (`ß` against `ss`), which toLowerCase does not.
  if (!isAscii(sentTo)) throw new HandBackToRuby("a piracy report sent to a non-ASCII address");
  if (((info.email as string | null) ?? "").toLowerCase() !== sentTo.toLowerCase()) return;
  const column = info.type === "delivered" ? "delivered_at" : info.type === "bounced" ? "delivery_failed_at" : null;
  if (column === null || report.get(column) !== null) return;
  if (!structurallyValid(report)) throw new HandBackToRuby("a piracy report the model would refuse to save");
  report.set(column, info.createdAt === null ? now() : withMicroseconds(info));
  await PiracyReports.saveBang(report, { now });
}

// `where(purchase_id:)` and `where(charge_id:)` cast a String or an Integer; anything else is not a cast Node reproduces.
function idFrom(value: unknown, what: string): bigint {
  if (typeof value === "string" && PLAIN_INTEGER.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new HandBackToRuby(`${what} ${JSON.stringify(value)} that is not a plain integer`);
}

// HandleEmailEventInfo::ForReceiptEmail#perform
async function performReceipt(
  info: EmailEventInfo,
  plan: Exclude<Plan, { kind: "nothing" | "piracy_notice" }>,
  now: () => Date,
): Promise<void> {
  const record =
    plan.kind === "charge_receipt"
      ? await findOrInitializeForCharge(plan.chargeId, info.mailerMethod!, info.createdAt)
      : await findOrInitializeForPurchase(plan.purchaseId, info.mailerMethod!, info.createdAt);
  if (!isKnownState(record)) throw new HandBackToRuby("an email info in a state the machine does not name");
  switch (info.type) {
    case "bounced":
      await markBounced(record, now);
      break;
    case "delivered":
      if (!alreadyDelivered(record)) await markDelivered(record, info.createdAt, now);
      break;
    case "opened":
      if (!alreadyOpened(record)) await markOpened(record, info.createdAt, now);
      break;
    default:
      // clicked, and a Resend complaint, only read the row
      break;
  }
}

// Plans every event of a batch first, so a hand-back leaves nothing written, then runs them in order.
export async function handleEmailEvents(infos: EmailEventInfo[], now: () => Date): Promise<void> {
  const plans = infos.map((info) => planEmailEvent(info));
  for (const [index, plan] of plans.entries()) {
    if (plan.kind === "piracy_notice") await performPiracyNotice(infos[index]!, plan.reportId, now);
    else if (plan.kind !== "nothing") await performReceipt(infos[index]!, plan, now);
  }
}
