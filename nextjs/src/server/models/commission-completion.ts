// Commission#create_completion_purchase! up to the charge (app/models/commission.rb): what Rails does before it takes the balance.
import type { Commission, Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";

import { isChargedbackNotReversed, isRefunded } from "./purchase.ts";

// Purchase::ALL_SUCCESS_STATES_INCLUDING_TEST
const SUCCESS_STATES_INCLUDING_TEST = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "test_successful",
];
export const STATUS_IN_PROGRESS = "in_progress";
export const STATUS_COMPLETED = "completed";
export const FILES_LOCKED = "This commission has already been completed, so its files can no longer be changed.";
export const DEPOSIT_NOT_COMPLETABLE =
  "This commission's deposit is no longer in a completable state, so it can no longer be completed.";
export const NO_FILE = "Attach at least one file before completing this commission.";

export async function filesAttached(commission: Commission): Promise<boolean> {
  const attachment = await db.activeStorageAttachment.findFirst({
    where: { record_type: "Commission", record_id: commission.id, name: "files" },
    select: { id: true },
  });
  return attachment !== null;
}

// Purchase#refunded?, #stripe_partially_refunded? and #chargedback_not_reversed?
function depositIsChargeable(commission: Commission, deposit: Purchase): boolean {
  if (commission.status !== STATUS_IN_PROGRESS) return false;
  if (!SUCCESS_STATES_INCLUDING_TEST.includes(deposit.purchase_state ?? "")) return false;
  return !isRefunded(deposit) && !deposit.stripe_partially_refunded && !isChargedbackNotReversed(deposit);
}

// Commission#create_completion_purchase! up to the charge: "done" when it returns without one, a refusal when it raises RecordInvalid,
// null when only the charge is left.
export async function completionOutcome(
  commission: Commission,
  deposit: Purchase,
): Promise<"done" | typeof DEPOSIT_NOT_COMPLETABLE | typeof NO_FILE | null> {
  if (commission.status === STATUS_COMPLETED) return "done";
  if (commission.completion_purchase_id !== null) {
    const completion = await db.purchase.findUnique({
      where: { id: commission.completion_purchase_id },
      select: { purchase_state: true },
    });
    if (completion !== null && completion.purchase_state !== "failed") return "done";
  }
  if (!depositIsChargeable(commission, deposit)) return DEPOSIT_NOT_COMPLETABLE;
  if (!(await filesAttached(commission))) return NO_FILE;
  return null;
}
