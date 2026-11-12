// The write EmailDeliveryObserver::HandleCustomerEmailInfo makes once a receipt has gone out: a
// CustomerEmailInfo row for the purchase (`build_for_purchase` then `mark_sent!`). Every send gets a row of its
// own, so a resend adds one. The charge variant (`build_for_charge`) is built by
// customer-email-info.ts when a receipt event arrives for a charge.
import type { EmailInfo, EmailInfoCharge } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";

export const EMAIL_INFOS = "email_infos";
export const CUSTOMER_EMAIL_INFO_TYPE = "CustomerEmailInfo";

// An STI table: the base class is EmailInfo and the row's `type` names the subclass. The state machine, not
// Rails' timestamps, stamps `sent_at`; the table has no created_at or updated_at.
export const EmailInfos = defineModel<EmailInfo>({
  rubyClass: CUSTOMER_EMAIL_INFO_TYPE,
  prismaModel: "EmailInfo",
  delegate: (tx) => tx.emailInfo as never,
  recordTimestamps: false,
});

// The row linking a charge receipt's EmailInfo to its charge (no timestamps either).
export const EmailInfoCharges = defineModel<EmailInfoCharge>({
  rubyClass: "EmailInfoCharge",
  prismaModel: "EmailInfoCharge",
  delegate: (tx) => tx.emailInfoCharge as never,
  recordTimestamps: false,
});

// `CustomerEmailInfo.build_for_purchase(purchase_id:, email_name:).mark_sent!`: created → sent stamps `sent_at`
// and clears the delivery and open times.
export async function markCustomerEmailSent(purchaseId: number | bigint, emailName: string, now: Date): Promise<void> {
  await EmailInfos.createBang(
    {
      purchase_id: BigInt(purchaseId),
      installment_id: null,
      type: CUSTOMER_EMAIL_INFO_TYPE,
      email_name: emailName,
      state: "sent",
      sent_at: now,
      delivered_at: null,
      opened_at: null,
    },
    { now: () => now },
  );
}
