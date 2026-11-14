// What the JSON endpoints of the seller dashboard share: `render json:`, `head :no_content`, RequireAccountEmail's 403 and
// PunditAuthorization's 401, all answered the way Rails answers a request whose format is JSON.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";
import { notAllowedMessage } from "../page-props/settings/guard.ts";
import { loadSellerContext, NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { type ActionContext, type ActionResult, type Rendered } from "./application-controller.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const ADD_EMAIL_MESSAGE = "Please add an email address to your account before continuing.";
export const NO_CONTENT = 204;
export const UNAUTHORIZED = 401;
export const FORBIDDEN = 403;
export const NOT_FOUND = 404;
export const UNPROCESSABLE_ENTITY = 422;

// `render json:`. The action read params, so Request#should_apply_vary_header? no longer adds Vary: Accept.
export const json = (value: unknown, status = 200): Rendered => ({ status, body: esJson(value as JsonValue), contentType: JSON_TYPE, paramsRead: true });

// `head :no_content` names no content type of its own.
export const noContent = (): Rendered => ({ status: NO_CONTENT, body: "", contentType: "", paramsRead: true });

// ApplicationController#e404_json, called from an action (the after_actions run).
export const notFoundJson = (): Rendered => json({ success: false, error: "Not found" }, NOT_FOUND);

// RequireAccountEmail for a JSON request.
export function accountEmailRequired({ context }: Pick<ActionContext, "context">): ActionResult | null {
  const user = railsLoggedInUser(context);
  if (!user || user.email || user.unconfirmed_email || context.impersonatedUser) return null;
  return { ...json({ success: false, error_message: ADD_EMAIL_MESSAGE }, FORBIDDEN), rescued: true };
}

// PunditAuthorization#default_user_not_authorized for a JSON request.
export async function authorizeJson(action: Pick<ActionContext, "context">, check: (context: SellerContext) => void | Promise<void>): Promise<ActionResult | null> {
  const sellerContext = await loadSellerContext(action.context);
  try {
    await check(sellerContext);
  } catch (error) {
    if (!(error instanceof NotAuthorizedError)) throw error;
    return { ...json({ success: false, error: notAllowedMessage(sellerContext) }, UNAUTHORIZED), rescued: true };
  }
  return null;
}
