// Port of app/sidekiq/deliver_files_ready_notification_job.rb up to `PdfStampingService.stamp_pending?`. The buyer's request (a flag bit
// on the purchase's url_redirect) and `Purchase.find` run in Node; a request whose purchase exists goes on to the stamp check, the
// follower's `perform_in` or the mail, which hand back before it. Golden: __fixtures__/deliver-files-ready-notification-job.golden.json
// (scripts/golden/deliver-files-ready-notification-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { UrlRedirectFlags, URL_REDIRECTS } from "../../server/models/url-redirect.ts";

import { modelJob } from "./support/job-deps.ts";

// `purchase_id.blank?`: nil and a string of whitespace only (Rails reads no statement for either).
const isBlank = (value: unknown) => value === null || (typeof value === "string" && /^\s*$/u.test(value));

export const deliverFilesReadyNotificationJobWith = modelJob({ min: 1, max: 2 }, async ([purchaseId]) => {
  if (isBlank(purchaseId)) return;
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "UrlRedirect.where(purchase_id:)"));

  const bit = UrlRedirectFlags.bit("files_ready_notification_requested");
  const requested = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(URL_REDIRECTS)} WHERE ${column(URL_REDIRECTS, "purchase_id")} = ${id} AND (COALESCE(flags, 0) & ${bit} != 0) LIMIT 1`,
  );
  if (requested.length === 0) return;

  await findByIdBang("Purchase", id);
  throw new HandBackToRuby("the stamp check and the files-ready mail are not ported");
});
export const deliverFilesReadyNotificationJob = deliverFilesReadyNotificationJobWith();
