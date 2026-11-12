// CustomerEmailInfo as HandleEmailEventInfo::ForReceiptEmail uses it: `find_or_initialize_for_purchase` and the EmailInfo state machine
// (created -> sent -> delivered -> opened, bounced from anywhere). `mark_delivered!(time)` and `mark_opened!(time)` stamp the event's own
// time; the columns are datetime(0), so the fraction is dropped.
// Golden: worker/jobs/__fixtures__/handle-resend-event-job.golden.json (the receipt cases).
import { Prisma, type EmailInfo } from "@prisma/client";

import { EMAIL_INFOS, EmailInfos, CUSTOMER_EMAIL_INFO_TYPE } from "./email-info.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export type EmailInfoRecord = ModelRecord<EmailInfo>;

const KNOWN_STATES = ["created", "sent", "delivered", "opened", "bounced"];
const SECOND_MS = 1000;

const truncatedToSecond = (time: Date) => new Date(Math.floor(time.getTime() / SECOND_MS) * SECOND_MS);

// Rows are oldest first. Without a timestamp, or when every send postdates the event, the newest row.
function newestSentBefore(emailInfos: EmailInfoRecord[], sentBefore: Date | null): EmailInfoRecord | undefined {
  if (sentBefore === null) return emailInfos.at(-1);
  const sentAt = (record: EmailInfoRecord) => record.get("sent_at");
  const before = emailInfos.filter((record) => {
    const sent = sentAt(record);
    return sent !== null && sent.getTime() <= sentBefore.getTime();
  });
  return before.at(-1) ?? emailInfos.at(-1);
}

// `CustomerEmailInfo.find_or_initialize_for_purchase(purchase_id:, email_name:, sent_before:)`. A row in a state the machine does not
// name is not one Node follows.
export async function findOrInitializeForPurchase(
  purchaseId: bigint,
  emailName: string,
  sentBefore: Date | null,
): Promise<EmailInfoRecord> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`email_infos`.*")} FROM ${table(EMAIL_INFOS)} WHERE ${column(EMAIL_INFOS, "type")} = ${CUSTOMER_EMAIL_INFO_TYPE} AND ${column(EMAIL_INFOS, "email_name")} = ${emailName} AND ${column(EMAIL_INFOS, "purchase_id")} = ${purchaseId} ORDER BY ${column(EMAIL_INFOS, "id")} ASC`,
  );
  const records = rows.map((row) => EmailInfos.load(castRow<EmailInfo>("EmailInfo", row)));
  const found = newestSentBefore(records, sentBefore);
  if (found !== undefined) return found;
  return EmailInfos.build({ email_name: emailName, purchase_id: purchaseId, type: CUSTOMER_EMAIL_INFO_TYPE });
}

export const isKnownState = (record: EmailInfoRecord) =>
  record.newRecord || KNOWN_STATES.includes(record.get("state") ?? "");

// EmailInfo#already_delivered? / #already_opened?; a new record is in the initial `created` state.
const stateOf = (record: EmailInfoRecord) => (record.newRecord ? "created" : record.get("state"));
export const alreadyDelivered = (record: EmailInfoRecord) => ["delivered", "opened"].includes(stateOf(record) ?? "");
export const alreadyOpened = (record: EmailInfoRecord) => stateOf(record) === "opened";

// `mark_bounced!`
export async function markBounced(record: EmailInfoRecord, now: () => Date): Promise<void> {
  record.set("state", "bounced");
  await EmailInfos.saveBang(record, { now });
}

// `mark_delivered!(time)`: `delivered_at = time || Time.current`
export async function markDelivered(record: EmailInfoRecord, time: Date | null, now: () => Date): Promise<void> {
  record.set("state", "delivered");
  record.set("delivered_at", truncatedToSecond(time ?? now()));
  await EmailInfos.saveBang(record, { now });
}

// `mark_opened!(time)`: `opened_at = time || Time.current`
export async function markOpened(record: EmailInfoRecord, time: Date | null, now: () => Date): Promise<void> {
  record.set("state", "opened");
  record.set("opened_at", truncatedToSecond(time ?? now()));
  await EmailInfos.saveBang(record, { now });
}
