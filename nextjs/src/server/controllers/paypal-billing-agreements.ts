// PaypalController#billing_agreement_token and #billing_agreement (app/controllers/paypal_controller.rb): the two stateless calls the
// checkout makes to PayPal before a PayPal Billing Agreement purchase. They write nothing: each is one PayPal request and a JSON answer.
//
// Rails rescues every failure of the PayPal call (an HTTP error, an unparseable answer, a missing token) into `nil` and renders it, so the
// buyer sees `{"billing_agreement_token_id":null}` and `null`. Node serves those answers when PayPal itself answered. Anything that fails
// before PayPal answered (the OAuth token, the socket) hands back whole instead, since Rails would have rescued it with state Node cannot see.
import { PaypalRestApi, type PaypalResponse } from "../paypal/rest-api.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { json } from "./seller-json.ts";

const SUCCESS_STATUSES = { min: 200, max: 300 };

const isSuccess = ({ statusCode }: PaypalResponse): boolean =>
  statusCode >= SUCCESS_STATUSES.min && statusCode < SUCCESS_STATUSES.max;

// Object#present? for a value read off a parsed PayPal body.
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// PayPal's JSON decodes to OpenStructs, so `result.token_id` on a string, array or null body raises NoMethodError, which Rails rescues.
const asObject = (result: unknown): Record<string, unknown> | null =>
  typeof result === "object" && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : null;

// Ruby prints 1.0 where JS prints 1, so a fractional number in an answer cannot be reproduced from the parsed value.
function assertNoFloats(value: unknown): void {
  if (typeof value === "number" && !Number.isInteger(value)) throw new HandBackToRails("a PayPal answer with a float");
  if (Array.isArray(value)) value.forEach(assertNoFloats);
  else if (typeof value === "object" && value !== null) Object.values(value).forEach(assertNoFloats);
}

let api = (): PaypalRestApi => new PaypalRestApi();
export function setPaypalRestApiForTesting(factory: (() => PaypalRestApi) | null): void {
  api = factory ?? (() => new PaypalRestApi());
}

async function call(request: () => Promise<PaypalResponse>): Promise<PaypalResponse> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof HandBackToRails) throw error;
    throw new HandBackToRails(`PayPal could not be reached: ${(error as Error).message}`);
  }
}

// `params[:shipping] == "true"`: a JSON `true` is a boolean in Rails' params and is not equal to the string.
export async function billingAgreementToken(input: Pick<MutationInput, "params">): Promise<ActionResult> {
  const response = await call(() =>
    api().generateBillingAgreementToken({ shipping: input.params.shipping === "true" }),
  );
  const result = asObject(response.result);
  const tokenId = isSuccess(response) && result !== null && isPresent(result.token_id) ? result.token_id : null;
  if (tokenId !== null) assertNoFloats(tokenId);
  return json({ billing_agreement_token_id: tokenId });
}

export async function billingAgreement(input: Pick<MutationInput, "params">): Promise<ActionResult> {
  const tokenId = input.params.billing_agreement_token_id;
  // A missing or non-text id is sent to PayPal as JSON null, an array or a hash, and interpolated into the request id by Ruby's to_s.
  if (typeof tokenId !== "string") throw new HandBackToRails("a billing_agreement_token_id that is not text");
  const response = await call(() => api().createBillingAgreement({ billingAgreementTokenId: tokenId }));
  const result = asObject(response.result);
  if (!isSuccess(response) || result === null || !isPresent(result.id)) return json(null);
  assertNoFloats(result);
  return json(result);
}

registerMutations(
  { method: "POST", pattern: "/paypal/billing_agreement_token", formats: ["any"], run: billingAgreementToken },
  { method: "POST", pattern: "/paypal/billing_agreement", formats: ["any"], run: billingAgreement },
);
