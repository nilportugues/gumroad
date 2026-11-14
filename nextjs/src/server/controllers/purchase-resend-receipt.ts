// `receipt_orderable_missing?` and `Purchase#resend_receipt` (app/controllers/purchases_controller.rb,
// app/models/concerns/purchase/receipt.rb) for the web and mobile actions that share them. A plain purchase writes one
// `SendPurchaseReceiptJob.perform_async(id, true)`; a gift sender adds the giftee's, a preorder authorization sends
// `CustomerMailer.preorder_receipt` through ActiveJob instead.
import type { Purchase } from "@prisma/client";

import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { findByPurchaseOrCharge, orderableEmail } from "../models/charge.ts";
import { currentJobsRuntime, performAsync } from "../models/concerns/job-runtime.ts";
import { findOneBy } from "../models/row-reads.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails } from "./application-controller.ts";

export type ResendReceiptOutcome = "missing" | "sent" | "unavailable";

const CUSTOMER_MAILER = "CustomerMailer";
const PREORDER_RECEIPT = "preorder_receipt";
const PREORDER_RECEIPT_QUEUE = "critical";
const PREORDER_RECEIPT_DELAY_SECONDS = 3;

// `purchase.gift&.giftee_purchase` of a sender: the gift whose `gifter_purchase_id` is this purchase, and its giftee's row, if any.
async function gifteePurchaseId(purchase: Purchase): Promise<bigint | null> {
  const gift = await findOneBy<{ giftee_purchase_id: bigint | null }>("Gift", "gifter_purchase_id", purchase.id);
  if (gift === null) return null;
  const giftee = await findOneBy<{ id: bigint }>("Purchase", "id", gift.giftee_purchase_id);
  return giftee?.id ?? null;
}

// `rescueEnqueueError` is the web action's `rescue *REDIS_TRANSPORT_ERRORS`; the mobile action has none, so its error propagates.
export async function resendReceipt(
  purchase: Purchase,
  { rescueEnqueueError }: { rescueEnqueueError: boolean },
): Promise<ResendReceiptOutcome> {
  const chargeable = await findByPurchaseOrCharge(purchase, null);
  // A charge's email is its order's, which is not always the purchase's own.
  const email = chargeable.kind === "charge" ? await orderableEmail(chargeable.charge) : purchase.email;
  if (isBlank(email)) return "missing";

  const isPreorderAuthorization = PurchaseFlags.isSet(purchase.flags, "is_preorder_authorization");
  // `preorder.id` on a purchase with no preorder is a NoMethodError, which Rails answers with a 500.
  const preorder = isPreorderAuthorization
    ? await findOneBy<{ id: bigint }>("Preorder", "id", purchase.preorder_id)
    : null;
  if (isPreorderAuthorization && preorder === null)
    throw new HandBackToRails("a preorder authorization with no preorder");

  const giftee =
    preorder === null && PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")
      ? await gifteePurchaseId(purchase)
      : null;

  // Rails rescues a Redis transport error here and answers "try again" rather than claim the receipt was sent.
  try {
    if (preorder !== null) {
      await deliverLater(
        currentJobsRuntime(),
        {
          mailer: CUSTOMER_MAILER,
          method: PREORDER_RECEIPT,
          args: [Number(preorder.id)],
          queue: PREORDER_RECEIPT_QUEUE,
          waitSeconds: PREORDER_RECEIPT_DELAY_SECONDS,
        },
        mailRoute(CUSTOMER_MAILER, PREORDER_RECEIPT),
      );
    } else {
      await performAsync("SendPurchaseReceiptJob", [Number(purchase.id), true]);
      if (giftee !== null) await performAsync("SendPurchaseReceiptJob", [Number(giftee), true]);
    }
  } catch (error) {
    if (!rescueEnqueueError) throw error;
    return "unavailable";
  }
  return "sent";
}
