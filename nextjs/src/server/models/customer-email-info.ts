// CustomerEmailInfo as HandleEmailEventInfo::ForReceiptEmail uses it: `find_or_initialize_for_purchase` and the EmailInfo state machine
// (created -> sent -> delivered -> opened, bounced from anywhere). `mark_delivered!(time)` and `mark_opened!(time)` stamp the event's own
// time; the columns are datetime(0), so the fraction is dropped.
// Golden: worker/jobs/__fixtures__/handle-resend-event-job.golden.json (the receipt cases).
import { Prisma, type EmailInfo } from "@prisma/client";

import { EMAIL_INFOS, EmailInfos, CUSTOMER_EMAIL_INFO_TYPE, EmailInfoCharges } from "./email-info.ts";
import { findById } from "./row-reads.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
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

// `CustomerEmailInfo.find_or_initialize_for_charge(charge_id:, email_name:, sent_before:)`: the lookup always asks for the
// `receipt` rows of the charge (a preorder receipt for a charge finds the receipt row), sorted by id. A row that is built carries
// its charge in `ivars` until it is saved, as the nested `email_info_charge` attributes do in Rails.
const PENDING_CHARGE = "pendingChargeId";

export async function findOrInitializeForCharge(
  chargeId: bigint,
  emailName: string,
  sentBefore: Date | null,
): Promise<EmailInfoRecord> {
  const joined = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${Prisma.raw(
      [
        ["email_info_charges", ["id", "email_info_id", "charge_id"]],
        [
          "email_infos",
          [
            "id",
            "purchase_id",
            "installment_id",
            "type",
            "email_name",
            "state",
            "sent_at",
            "delivered_at",
            "opened_at",
          ],
        ],
      ]
        .flatMap(([name, columns], index) =>
          (columns as string[]).map((c, i) => `\`${name as string}\`.\`${c}\` AS t${index}_r${i}`),
        )
        .join(", "),
    )} FROM ${table("email_info_charges")} LEFT OUTER JOIN ${table(EMAIL_INFOS)} ON ${column(EMAIL_INFOS, "id")} = ${column("email_info_charges", "email_info_id")} WHERE ${column("email_info_charges", "charge_id")} = ${chargeId} AND ${column(EMAIL_INFOS, "email_name")} = 'receipt' AND ${column(EMAIL_INFOS, "type")} = ${CUSTOMER_EMAIL_INFO_TYPE}`,
  );
  const infoColumns = [
    "id",
    "purchase_id",
    "installment_id",
    "type",
    "email_name",
    "state",
    "sent_at",
    "delivered_at",
    "opened_at",
  ];
  const records = joined
    .map((row) =>
      EmailInfos.load(
        castRow<EmailInfo>("EmailInfo", Object.fromEntries(infoColumns.map((c, i) => [c, row[`t1_r${i}`]]))),
      ),
    )
    .sort((a, b) => (BigInt(a.get("id")) < BigInt(b.get("id")) ? -1 : 1));
  const found = newestSentBefore(records, sentBefore);
  if (found !== undefined) return found;
  const built = EmailInfos.build({ email_name: emailName, type: CUSTOMER_EMAIL_INFO_TYPE });
  built.ivars[PENDING_CHARGE] = chargeId;
  return built;
}

export const isKnownState = (record: EmailInfoRecord) =>
  record.newRecord || KNOWN_STATES.includes(record.get("state") ?? "");

// EmailInfo#already_delivered? / #already_opened?; a new record is in the initial `created` state.
const stateOf = (record: EmailInfoRecord) => (record.newRecord ? "created" : record.get("state"));
export const alreadyDelivered = (record: EmailInfoRecord) => ["delivered", "opened"].includes(stateOf(record) ?? "");
export const alreadyOpened = (record: EmailInfoRecord) => stateOf(record) === "opened";

class InvalidTransition extends Error {
  readonly rubyClass = "StateMachines::InvalidTransition";
  constructor(event: string, reasons: string) {
    super(`Cannot transition state via :${event} from :created (Reason(s): ${reasons})`);
    this.name = "InvalidTransition";
  }
}

// The save of a state machine event. A row built for a charge saves its `email_info_charge` too, in the same transaction: the charge
// must exist (`belongs_to` and the presence validation both say so) and the `email_info` uniqueness validation runs on the unsaved
// parent. A failure there is the event's InvalidTransition, with the transaction rolled back.
async function saveEvent(record: EmailInfoRecord, event: string, now: () => Date): Promise<void> {
  const chargeId = record.ivars[PENDING_CHARGE] as bigint | undefined;
  if (chargeId === undefined) {
    await EmailInfos.saveBang(record, { now });
    return;
  }
  await transaction(async () => {
    const charge = await findById("Charge", chargeId);
    await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("email_info_charges")} WHERE ${column("email_info_charges", "email_info_id")} IS NULL LIMIT 1`,
    );
    if (charge === null)
      throw new InvalidTransition(
        event,
        "Email info charge charge must exist, Email info charge charge can't be blank",
      );
    await EmailInfos.saveBang(record, { now });
    await EmailInfoCharges.createBang({ email_info_id: record.get("id"), charge_id: chargeId }, { now });
  });
  record.ivars[PENDING_CHARGE] = undefined;
}

// `mark_bounced!`
export async function markBounced(record: EmailInfoRecord, now: () => Date): Promise<void> {
  record.set("state", "bounced");
  await saveEvent(record, "mark_bounced", now);
}

// `mark_delivered!(time)`: `delivered_at = time || Time.current`
export async function markDelivered(record: EmailInfoRecord, time: Date | null, now: () => Date): Promise<void> {
  record.set("state", "delivered");
  record.set("delivered_at", truncatedToSecond(time ?? now()));
  await saveEvent(record, "mark_delivered", now);
}

// `mark_opened!(time)`: `opened_at = time || Time.current`
export async function markOpened(record: EmailInfoRecord, time: Date | null, now: () => Date): Promise<void> {
  record.set("state", "opened");
  record.set("opened_at", truncatedToSecond(time ?? now()));
  await saveEvent(record, "mark_opened", now);
}
