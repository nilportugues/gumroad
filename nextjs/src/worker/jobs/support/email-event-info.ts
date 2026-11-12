// HandleEmailEventInfo (app/services/handle_email_event_info.rb) for the events Node can run: a receipt event on a purchase's
// CustomerEmailInfo row, and any event no handler claims (which does nothing). The installment, abandoned cart and piracy handlers
// (DynamoDB engagement records, installment caches, report updates), a receipt of a charge, a Sendgrid complaint (it unsubscribes the
// buyer) and a purchase id that is not a plain integer are handed back before the first statement of the batch.
// Golden: __fixtures__/handle-resend-event-job.golden.json and handle-sendgrid-event-job.golden.json.
import { HandBackToRuby } from "../../../server/jobs/hand-back.ts";
import {
  alreadyDelivered,
  alreadyOpened,
  findOrInitializeForPurchase,
  isKnownState,
  markBounced,
  markDelivered,
  markOpened,
} from "../../../server/models/customer-email-info.ts";
import { isBlank } from "../../../server/webhooks/json-guards.ts";

// EmailEventInfo constants
const CUSTOMER_MAILER = "CustomerMailer";
const TRACKED_RECEIPT_MAILER_METHODS = ["receipt", "preorder_receipt"];
const ABANDONED_CART_MAILER_METHOD = "abandoned_cart";
const PIRACY_REPORT_MAILER = "PiracyReportMailer";
const PIRACY_NOTICE_MAILER_METHOD = "notice";
// A Ruby Integer a bigint column holds and Node reads without rounding.
const PLAIN_INTEGER = /^\d{1,15}$/u;

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
};

type Plan = { kind: "nothing" } | { kind: "receipt"; purchaseId: bigint };

// Decides, without a statement, what HandleEmailEventInfo.perform does for the event; hands back what Node does not run.
export function planEmailEvent(info: EmailEventInfo): Plan {
  if (!isBlank(info.installmentId)) throw new HandBackToRuby("an email event for an installment");
  const isCustomerMailer = info.mailerClass === CUSTOMER_MAILER;
  if (isCustomerMailer && info.mailerMethod !== null && TRACKED_RECEIPT_MAILER_METHODS.includes(info.mailerMethod)) {
    if (!isBlank(info.chargeId)) throw new HandBackToRuby("a receipt event for a charge");
    if (info.type === "complained" && info.provider === "sendgrid")
      throw new HandBackToRuby("a SendGrid spam report on a receipt unsubscribes the buyer");
    return { kind: "receipt", purchaseId: purchaseIdFrom(info.purchaseId) };
  }
  if (isCustomerMailer && info.mailerMethod === ABANDONED_CART_MAILER_METHOD)
    throw new HandBackToRuby("an abandoned cart email event");
  if (info.mailerClass === PIRACY_REPORT_MAILER && info.mailerMethod === PIRACY_NOTICE_MAILER_METHOD)
    throw new HandBackToRuby("a piracy notice email event");
  return { kind: "nothing" };
}

// `where(purchase_id:)` casts a String or an Integer; anything else is not a cast Node reproduces.
function purchaseIdFrom(value: unknown): bigint {
  if (typeof value === "string" && PLAIN_INTEGER.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new HandBackToRuby(`a purchase id ${JSON.stringify(value)} that is not a plain integer`);
}

// HandleEmailEventInfo::ForReceiptEmail#perform
async function performReceipt(info: EmailEventInfo, purchaseId: bigint, now: () => Date): Promise<void> {
  const record = await findOrInitializeForPurchase(purchaseId, info.mailerMethod!, info.createdAt);
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
    if (plan.kind === "receipt") await performReceipt(infos[index]!, plan.purchaseId, now);
  }
}
