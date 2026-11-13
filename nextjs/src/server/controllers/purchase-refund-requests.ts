// Purchases::RefundRequestsController (app/controllers/purchases/refund_requests_controller.rb): the guards both actions share
// and #create. #show is a native Inertia page (page-props/buyer/refund-request-page.ts). The request never refunds anything: it
// writes one row and queues two emails.
//
// Handed to Rails whole before the first write: a signed-in buyer, a reason or message that is not text, a message Ruby and
// JavaScript would read differently (NUL, a lone surrogate), a purchase with no email (Rails answers 422) and a preorder charge.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { createRefundRequest, REFUND_REASONS, refundRequestMessage } from "../models/purchase-refund-request.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { ineligibility } from "../page-props/buyer/refund-request.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import {
  purchaseForRefundRequest,
  refundPeriodInDays,
  REFUND_REQUEST_HEADERS,
} from "./purchase-refund-request-guards.ts";

const SEE_OTHER = 303;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const REASON_ALERT = "Please select a reason for your refund request.";

// `params[name].to_s` for what a form sends: absent or null is "", and anything but text is Rails' to stringify.
export function textParam(input: MutationInput, name: string): string {
  const value = input.params[name];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HandBackToRails(`a ${name} that is not text`);
  if (value.includes("\u0000") || LONE_SURROGATE.test(value))
    throw new HandBackToRails(`a ${name} with a NUL or a lone surrogate`);
  return value;
}

async function create(input: MutationInput): Promise<ActionResult> {
  const token = input.routeParams.purchase_id!;
  const purchase = await purchaseForRefundRequest(token, input.chain.now);
  if (railsLoggedInUser(input.context) !== null) throw new HandBackToRails("a signed-in buyer");

  const reason = textParam(input, "reason");
  const message = textParam(input, "message");
  const back: ActionResult = {
    status: SEE_OTHER,
    location: `/purchases/${railsSegment(token)}/refund_request`,
    headers: REFUND_REQUEST_HEADERS,
  };
  if (!REFUND_REASONS.includes(reason)) return { ...back, flash: { alert: REASON_ALERT } };

  const maxDays = await refundPeriodInDays(purchase);
  if (ineligibility(purchase, maxDays, input.chain.now) === null) {
    if (isBlank(purchase.email)) throw new HandBackToRails("a purchase with no email, which Rails refuses with a 422");
    await createRefundRequest({
      purchaseId: purchase.id,
      email: purchase.email!,
      reason,
      message: refundRequestMessage(message),
      now: new Date(),
    });
  }
  return back;
}

registerMutations({ method: "POST", pattern: "/purchases/:purchase_id/refund_request", run: create });
