// `receipt_orderable_missing?` and `Purchase#resend_receipt` (app/controllers/purchases_controller.rb,
// app/models/concerns/purchase/receipt.rb) for the web and mobile actions that share them. The only write is one
// `SendPurchaseReceiptJob.perform_async(id, true)`.
import type { Purchase } from "@prisma/client";

import { findByPurchaseOrCharge } from "../models/charge.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { HandBackToRails } from "./application-controller.ts";

export type ResendReceiptOutcome = "missing" | "sent" | "unavailable";

// Whatever is not a plain purchase's receipt goes to Rails before the enqueue: a receipt of an order's charge reads the
// charge's email, a preorder authorization sends `CustomerMailer.preorder_receipt` through ActiveJob and a gift sender
// also sends the giftee's receipt.
// `rescueEnqueueError` is the web action's `rescue *REDIS_TRANSPORT_ERRORS`; the mobile action has none, so its error propagates.
export async function resendReceipt(
  purchase: Purchase,
  { rescueEnqueueError }: { rescueEnqueueError: boolean },
): Promise<ResendReceiptOutcome> {
  const chargeable = await findByPurchaseOrCharge(purchase, null);
  if (chargeable.kind === "charge") throw new HandBackToRails("the receipt of a charge");
  if (isBlank(purchase.email)) return "missing";
  if (PurchaseFlags.isSet(purchase.flags, "is_preorder_authorization"))
    throw new HandBackToRails("a preorder authorization receipt");
  if (PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase"))
    throw new HandBackToRails("a gift sender receipt");

  // Rails rescues a Redis transport error here and answers "try again" rather than claim the receipt was sent.
  try {
    await performAsync("SendPurchaseReceiptJob", [Number(purchase.id), true]);
  } catch (error) {
    if (!rescueEnqueueError) throw error;
    return "unavailable";
  }
  return "sent";
}
