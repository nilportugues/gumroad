// Port of app/sidekiq/send_purchase_receipt_job.rb. The receipt is rendered and sent inline, as `deliver_now` does,
// and the CustomerEmailInfo the observer writes follows the SMTP hand-off.
//
// A purchase whose PDFs must be stamped, and a receipt the Node renderer refuses (see
// mail/mailers/receipt-presenter.ts `assertSupported`), go back to Rails before the job has sent or written
// anything: the stamping job's enqueue is the job's first write, and the mail comes after it.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { composeNodeMail, defaultMailDeliveryDeps, isNotPorted, type MailDeliveryDeps, sendComposed } from "../../server/mail/delivery.ts";
import { EMAIL_INFOS, CUSTOMER_EMAIL_INFO_TYPE } from "../../server/models/email-info.ts";
import { findPurchaseBang, purchaseIdFrom } from "../../server/models/purchase.ts";
import { findOneBy } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { findUrlRedirectForPurchase, UrlRedirectFlags } from "../../server/models/url-redirect.ts";
import { PurchaseFlags } from "../../server/search/flags.ts";
import { defaultJobDeps, type JobDeps, modelJob } from "./support/job-deps.ts";
import type { JobHandler } from "./types.ts";

// SendgridEventInfo::RECEIPT_MAILER_METHOD
const RECEIPT_MAILER_METHOD = "receipt";
const PRODUCT_FILES = "product_files";
// ProductFile's has_flags: 5 => :pdf_stamp_enabled
const PDF_STAMP_ENABLED = 1 << 4;

type Deps = JobDeps & { mail: MailDeliveryDeps };

const rubyTruthy = (value: JsonValue | undefined) => value !== undefined && value !== null && value !== false;

// `url_redirect && purchase.link.has_stampable_pdfs? && !url_redirect.is_done_pdf_stamping?`, the condition under which
// Ruby enqueues StampPdfForPurchaseJob. Reads only.
async function needsStamping(purchaseId: bigint, linkId: bigint | null): Promise<boolean> {
  const redirect = await findUrlRedirectForPurchase(purchaseId);
  if (redirect === null) return false;
  const link = await findOneBy("Link", "id", linkId);
  if (link === null) throw new TypeError("undefined method 'has_stampable_pdfs?' for nil");
  const files = await selectRows<{ filetype: string | null; flags: number | bigint | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`product_files`.*")} FROM ${table(PRODUCT_FILES)} WHERE ${column(PRODUCT_FILES, "link_id")} = ${link.id} AND ${column(PRODUCT_FILES, "deleted_at")} IS NULL ORDER BY ${column(PRODUCT_FILES, "position")} ASC`,
  );
  const stampable = files.some((file) => file.filetype === "pdf" && (Number(file.flags ?? 0) & PDF_STAMP_ENABLED) !== 0);
  return stampable && !UrlRedirectFlags.isSet(redirect.flags, "is_done_pdf_stamping");
}

// `CustomerEmailInfo.where(purchase_id:, email_name: "receipt").exists?`
async function receiptAlreadySent(purchaseId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(EMAIL_INFOS)} WHERE ${column(EMAIL_INFOS, "type")} = ${CUSTOMER_EMAIL_INFO_TYPE} AND ${column(EMAIL_INFOS, "purchase_id")} = ${purchaseId} AND ${column(EMAIL_INFOS, "email_name")} = ${RECEIPT_MAILER_METHOD} LIMIT 1`,
  );
  return rows.length > 0;
}

export function sendPurchaseReceiptJobWith(overrides: Partial<Deps> = {}): JobHandler {
  const deps: Deps = { ...defaultJobDeps, mail: defaultMailDeliveryDeps, ...overrides };
  return modelJob({ min: 1, max: 2 }, async ([purchaseId, resend], _jobDeps) => {
    const purchase = await findPurchaseBang(await beforeSideEffects(() => purchaseIdFrom(purchaseId)));

    // enqueue_stamping rescues StandardError and raises it once the receipt has gone out.
    let stampError: unknown = null;
    try {
      if (await needsStamping(purchase.id, purchase.link_id)) throw new HandBackToRuby("StampPdfForPurchaseJob.perform_async");
    } catch (error) {
      if (error instanceof HandBackToRuby) throw error;
      stampError = error;
    }

    // Bundle product purchases are dummy rows and get no receipt.
    if (!PurchaseFlags.isSet(purchase.flags, "is_bundle_product_purchase")) {
      // An automatic retry must not resend a receipt this job already delivered; an explicit resend must go out.
      if (rubyTruthy(resend) || !(await receiptAlreadySent(purchase.id))) {
        let mail;
        try {
          mail = await composeNodeMail("CustomerMailer", "receipt", [Number(purchase.id)], deps.mail.mailer);
        } catch (error) {
          if (!isNotPorted(error)) throw error;
          throw new HandBackToRuby(`CustomerMailer#receipt: ${(error as Error).message}`);
        }
        if (mail !== undefined) await sendComposed(mail, { ...deps.mail, now: deps.now });
      }
    }
    if (stampError !== null) throw stampError;
  })(overrides);
}

export const sendPurchaseReceiptJob = sendPurchaseReceiptJobWith();
