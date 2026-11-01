// Sellers::BaseController for a JSON request: RequireAccountEmail, authenticate_user! (the route table only sends signed-in
// requests here) and the action's `authorize`, answered the way PunditAuthorization and RequireAccountEmail answer a request
// whose format is JSON. Any other format goes to Rails.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { HandBackToRails, type ActionContext, type ActionResult, type Rendered } from "./application-controller.ts";
import { requestFormat } from "./rails-params.ts";

const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";
const JSON_TYPE = "application/json; charset=utf-8";

// `render json:` answers Vary: Accept unless the action read params.
export const jsonResponse = (value: unknown, status = 200, paramsRead = false): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE, paramsRead });

export type JsonSellerPolicy = (context: SellerContext) => boolean;

export async function sellerJsonAction(
  { context, request }: Pick<ActionContext, "context" | "request">,
  policy: JsonSellerPolicy,
  run: (sellerContext: SellerContext) => Promise<ActionResult>,
): Promise<ActionResult> {
  if (requestFormat(request) !== "json") throw new HandBackToRails("a seller JSON endpoint requested in another format");
  const user = railsLoggedInUser(context);
  if (!user || !context.currentSeller) throw new HandBackToRails("a signed-out request to a seller JSON endpoint");
  if (!user.email && !user.unconfirmed_email && !context.impersonatedUser) return { ...jsonResponse({ success: false, error_message: ADD_EMAIL_MESSAGE }, 403), rescued: true };

  const sellerContext = await loadSellerContext(context);
  try {
    if (!policy(sellerContext)) throw new NotAuthorizedError();
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return { ...jsonResponse({ success: false, error: notAllowedMessage(sellerContext) }, 401), rescued: true };
  }
  return run(sellerContext);
}
