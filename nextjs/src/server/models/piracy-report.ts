// PiracyReport as HandleEmailEventInfo::ForPiracyNotice uses it: the id lookup and the `update!` that stamps the delivery time.
// The structural validations (presence, lengths, source, the http url rules) are pure functions of the row; `isStructurallyValid`
// answers them before the transaction so a report the model would refuse is handed back, and the model keeps the two belongs_to
// checks whose statements Rails sends.
// Golden: worker/jobs/__fixtures__/handle-resend-event-job.golden.json (the piracy notice cases).
import { createHash } from "node:crypto";

import { Prisma, type PiracyReport } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { normalizeUrl, parseHttpUrl } from "./piracy-report-url.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const TABLE = "piracy_reports";
const MAX_REPORTED_URL_LENGTH = 500;
const MAX_TICKET_URL_LENGTH = 1024;
const MAX_RECIPIENT_EMAIL_LENGTH = 254;
const SOURCES = ["dashboard", "support"];
// The states of the report's state machine; `validates_inclusion_of :state` is part of it.
const STATES = [
  "requested",
  "screening",
  "awaiting_signature",
  "declined",
  "signed",
  "sent",
  "counter_noticed",
  "resolved",
  "cancelled",
];

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const PRODUCT: BelongsTo = { name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" };

const stripped = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");
const length = (value: string | null) => (value === null ? 0 : [...value].length);

// `before_validation :set_normalized_url_digest`: only a url that normalizes changes the digest.
const setNormalizedUrlDigest: Callback<PiracyReport> = {
  name: "set_normalized_url_digest",
  run(record) {
    const uri = parseHttpUrl(stripped(record.get("url")));
    if (uri !== null) record.set("normalized_url_digest", createHash("sha256").update(normalizeUrl(uri)).digest("hex"));
  },
};

export const PiracyReports = defineModel<PiracyReport>({
  rubyClass: "PiracyReport",
  prismaModel: "PiracyReport",
  delegate: (tx) => tx.piracyReport as never,
  beforeValidation: [setNormalizedUrlDigest],
  validations: [belongsToRequired<PiracyReport>(SELLER), belongsToRequired<PiracyReport>(PRODUCT)],
});

export type PiracyReportRecord = ModelRecord<PiracyReport>;

// `PiracyReport.find_by(id:)`; a nil id asks for `id IS NULL`.
export async function findPiracyReport(id: bigint | null): Promise<PiracyReportRecord | null> {
  const [row] = await selectRows<Record<string, unknown>>(
    id === null
      ? Prisma.sql`SELECT ${Prisma.raw("`piracy_reports`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "id")} IS NULL LIMIT 1`
      : Prisma.sql`SELECT ${Prisma.raw("`piracy_reports`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "id")} = ${id} LIMIT 1`,
  );
  return row === undefined ? null : PiracyReports.load(castRow<PiracyReport>("PiracyReport", row));
}

// The validations of app/models/piracy_report.rb that read nothing but the row. A false answer means Rails would raise
// RecordInvalid with a message Node does not build.
export function isStructurallyValid(record: PiracyReportRecord): boolean {
  const url = record.get("url");
  const present = [record.get("external_id"), record.get("state"), url, record.get("normalized_url_digest")].every(
    (value) => typeof value === "string" && !isBlank(value),
  );
  if (!present || !STATES.includes(record.get("state"))) return false;
  if (length(url) > MAX_REPORTED_URL_LENGTH) return false;
  if (length(record.get("ticket_url")) > MAX_TICKET_URL_LENGTH) return false;
  if (length(record.get("recipient_email")) > MAX_RECIPIENT_EMAIL_LENGTH) return false;
  if (!SOURCES.includes(record.get("source"))) return false;
  if (parseHttpUrl(stripped(url)) === null) return false;
  // `embeds_another_url?`
  return !/https?(:|%3a)/iu.test(stripped(url).replace(/^https?:\/\/[^/?#]*/iu, ""));
}
