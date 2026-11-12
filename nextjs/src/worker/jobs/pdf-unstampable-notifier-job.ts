// Port of app/sidekiq/pdf_unstampable_notifier_job.rb up to the first PDF to check. `Link.find` and the find_each over the product's
// alive PDFs with stamping enabled and an unknown `stampable_pdf` run in Node and finish a product with nothing left to check
// (the job returns before the mail and the backfill). A PDF to check means PdfStampingService reading the file from S3 and a
// `stampable_pdf` write, which hand back to Rails before any write, as does an id Rails casts.
// Golden: __fixtures__/pdf-unstampable-notifier-job.golden.json (scripts/golden/pdf-unstampable-notifier-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
// ProductFile `has_flags 5 => :pdf_stamp_enabled`
const PDF_STAMP_ENABLED = 1 << 4;

// product.product_files.alive.pdf.pdf_stamp_enabled.where(stampable_pdf: nil)
const pdfsToCheck = (productId: bigint) =>
  Prisma.sql`${column("product_files", "link_id")} = ${productId} AND ${column("product_files", "deleted_at")} IS NULL AND ${column("product_files", "filetype")} = 'pdf' AND ((${column("product_files", "flags")} & ${Prisma.raw(String(PDF_STAMP_ENABLED))} = ${Prisma.raw(String(PDF_STAMP_ENABLED))})) AND ${column("product_files", "stampable_pdf")} IS NULL`;

export const pdfUnstampableNotifierJobWith = modelJob({ min: 1, max: 2 }, async ([productId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  await findByIdBang("Link", id);

  await findInBatches("product_files", pdfsToCheck(id), FIND_EACH_BATCH_SIZE, () => {
    throw new HandBackToRuby("a PDF whose stampability is not known yet");
  });
});
export const pdfUnstampableNotifierJob = pdfUnstampableNotifierJobWith();
