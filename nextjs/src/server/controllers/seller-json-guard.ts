// Sellers::BaseController's filters for a JSON request: RequireAccountEmail answers 403 JSON, authenticate_user! is left to the route gate,
// and a Pundit refusal (PunditAuthorization#default_user_not_authorized) answers 401 JSON.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { ADD_EMAIL_MESSAGE, notAllowedMessage } from "../page-props/settings/guard.ts";
import { authorize, type PolicyQuery } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { HandBackToRails, type ActionResult, type Rendered } from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";

const JSON_TYPE = "application/json; charset=utf-8";

export const jsonResponse = (value: unknown, status = 200): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE });

// `between` is the controller's own before_action that sits ahead of the action's `authorize`; it returns a response to halt.
export async function jsonSellerGuard(input: MutationInput, policy: PolicyQuery, between?: (context: SellerContext) => Promise<ActionResult | null>): Promise<ActionResult | null> {
  const user = railsLoggedInUser(input.context);
  if (user === null) throw new HandBackToRails("authenticate_user! for a signed-out visitor");
  if (!user.email && !user.unconfirmed_email && !input.context.impersonatedUser) return { ...jsonResponse({ success: false, error_message: ADD_EMAIL_MESSAGE }, 403), rescued: true };
  const sellerContext = await loadSellerContext(input.context);
  const halted = await between?.(sellerContext);
  if (halted) return halted;
  try {
    authorize(policy, sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return { ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, 401), rescued: true };
  }
  return null;
}
