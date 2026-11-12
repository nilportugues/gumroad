// Port of app/sidekiq/stamp_pdf_for_purchase_job.rb up to the stamping. `Purchase.find` runs in Node (a missing purchase raises
// RecordNotFound; the `rescue` only wraps PdfStampingService::Error); the stamp itself (object storage and PDF work) and the
// notification that follows hand back before any of it. Golden: __fixtures__/stamp-pdf-for-purchase-job.golden.json
// (scripts/golden/stamp-pdf-for-purchase-job.rb).
import type { Purchase } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const stampPdfForPurchaseJobWith = modelJob({ min: 1, max: 2 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  await findByIdBang<Purchase>("Purchase", id);

  throw new HandBackToRuby("the purchase's PDFs are stamped");
});
export const stampPdfForPurchaseJob = stampPdfForPurchaseJobWith();
