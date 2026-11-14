// Port of app/sidekiq/send_year_in_review_email_job.rb up to the blob behind `User#financial_annual_report_url_for`. `User.find` and the
// two reads behind the seller's annual report (is one attached, and is there one for the year) run in Node: a seller with no report for
// the year ends the run there, as Rails does ("Don't send email to user without any payouts"). A report for the year needs the blob, the
// storage service's URL and the CDN map, then the analytics, the OpenAI buy list and the mail, so it hands back to Rails whole before
// any of that. A year that is not an Integer (Rails raises or reads a Float) and a seller id
// Rails casts hand back before any statement.
// Golden: __fixtures__/send-year-in-review-email-job.golden.json (scripts/golden/send-year-in-review-email-job.rb).
import { Prisma, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

// The years `Date.new(year)` takes that the golden covers.
const FIRST_YEAR = 0;
const LAST_YEAR = 10_000;

const attachment = (name: string) => column("active_storage_attachments", name);

export const sendYearInReviewEmailJobWith = modelJob({ min: 2, max: 3 }, async ([sellerId, year]) => {
  const id = await beforeSideEffects(() => recordIdFrom(sellerId, "User.find"));
  const reportYear = await beforeSideEffects(() => {
    if (typeof year !== "number" || !Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR)
      throw new HandBackToRuby("a year that is not an Integer Date.new takes");
    return year;
  });
  const seller = await findByIdBang<User>("User", id);

  const owner = Prisma.sql`${attachment("record_id")} = ${seller.id} AND ${attachment("record_type")} = 'User' AND ${attachment("name")} = 'annual_reports'`;
  const attached = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("active_storage_attachments")} WHERE ${owner} LIMIT 1`,
  );
  if (attached.length === 0) return;

  const [report] = await selectRows(
    Prisma.sql`SELECT ${table("active_storage_attachments")}.* FROM ${table("active_storage_attachments")} LEFT JOIN active_storage_blobs ON active_storage_blobs.id = active_storage_attachments.blob_id WHERE ${owner} AND (JSON_CONTAINS(active_storage_blobs.metadata, ${String(reportYear)}, '$.year')) LIMIT 1`,
  );
  if (report === undefined) return;

  throw new HandBackToRuby("the report's URL, the analytics, the buy list and the mail are built in Rails");
});
export const sendYearInReviewEmailJob = sendYearInReviewEmailJobWith();
