// CommissionsController#update and #complete (PATCH /commissions/:id, POST /commissions/:id/complete,
// app/controllers/commissions_controller.rb): the seller's commission files and the "mark as completed" charge of the balance.
//
// Node answers every request that ends without a write or a charge: an unknown commission (404), the Pundit refusal (401 JSON),
// the completed commission whose files can no longer change, and a completion that is a no-op (already completed, or its charge
// already made) or refused (the deposit can no longer be completed, no file attached). Changing the attached files (ActiveStorage
// attach and purge) and charging the balance (Purchase#process!) hand back whole, before any write.
import type { Commission, Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { isChargedbackNotReversed, isRefunded } from "../models/purchase.ts";
import { authorize } from "../policies/authorize.ts";
import { commissionPolicy } from "../policies/commission.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { idFromExternalId } from "./buyer-pages.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, json, noContent, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

// Purchase::ALL_SUCCESS_STATES_INCLUDING_TEST
const SUCCESS_STATES_INCLUDING_TEST = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "test_successful",
];
const STATUS_IN_PROGRESS = "in_progress";
const STATUS_COMPLETED = "completed";
const FILES_LOCKED = "This commission has already been completed, so its files can no longer be changed.";
const DEPOSIT_NOT_COMPLETABLE =
  "This commission's deposit is no longer in a completable state, so it can no longer be completed.";
const NO_FILE = "Attach at least one file before completing this commission.";

const errors = (...messages: string[]) => ({ ...json({ errors: messages }, UNPROCESSABLE_ENTITY) });

// `Commission.find_by_external_id!(params[:id])`
async function findCommission(externalId: string | undefined): Promise<{ commission: Commission; deposit: Purchase }> {
  const id = externalId === undefined ? null : idFromExternalId(externalId);
  const commission = id === null ? null : await db.commission.findUnique({ where: { id } });
  if (commission === null) throw new RoutingError("Not Found");
  const deposit =
    commission.deposit_purchase_id === null
      ? null
      : await db.purchase.findUnique({ where: { id: commission.deposit_purchase_id } });
  // CommissionPolicy#update? reads `record.deposit_purchase.seller` once the role passes: a commission with no deposit raises.
  if (deposit === null) throw new HandBackToRails("a commission with no deposit purchase");
  return { commission, deposit };
}

async function refusal(input: MutationInput, deposit: Purchase): Promise<ActionResult | null> {
  if (railsLoggedInUser(input.context) === null) throw new HandBackToRails("a signed-out request");
  return authorizeJson(input, (context) => authorize(commissionPolicy.update, context, deposit.seller_id));
}

async function filesAttached(commission: Commission): Promise<boolean> {
  const attachment = await db.activeStorageAttachment.findFirst({
    where: { record_type: "Commission", record_id: commission.id, name: "files" },
    select: { id: true },
  });
  return attachment !== null;
}

async function update(input: MutationInput): Promise<ActionResult> {
  const { commission, deposit } = await findCommission(input.routeParams.id);
  const denied = await refusal(input, deposit);
  if (denied) return denied;

  // Commission#files_are_editable?
  if (commission.status === STATUS_COMPLETED || commission.completion_purchase_id !== null) return errors(FILES_LOCKED);
  throw new HandBackToRails("attaching and purging the commission's files");
}

// Purchase#refunded?, #stripe_partially_refunded? and #chargedback_not_reversed?
function depositIsChargeable(commission: Commission, deposit: Purchase): boolean {
  if (commission.status !== STATUS_IN_PROGRESS) return false;
  if (!SUCCESS_STATES_INCLUDING_TEST.includes(deposit.purchase_state ?? "")) return false;
  return !isRefunded(deposit) && !deposit.stripe_partially_refunded && !isChargedbackNotReversed(deposit);
}

async function complete(input: MutationInput): Promise<ActionResult> {
  const { commission, deposit } = await findCommission(input.routeParams.id);
  const denied = await refusal(input, deposit);
  if (denied) return denied;

  // Commission#create_completion_purchase!
  if (commission.status === STATUS_COMPLETED) return noContent();
  if (commission.completion_purchase_id !== null) {
    const completion = await db.purchase.findUnique({
      where: { id: commission.completion_purchase_id },
      select: { purchase_state: true },
    });
    if (completion !== null && completion.purchase_state !== "failed") return noContent();
  }
  if (!depositIsChargeable(commission, deposit)) return errors(DEPOSIT_NOT_COMPLETABLE);
  if (!(await filesAttached(commission))) return errors(NO_FILE);
  throw new HandBackToRails("charging the balance of the commission");
}

registerMutations(
  { method: "PATCH", pattern: "/commissions/:id", json: true, run: update },
  { method: "PUT", pattern: "/commissions/:id", json: true, run: update },
  { method: "POST", pattern: "/commissions/:id/complete", json: true, run: complete },
);
