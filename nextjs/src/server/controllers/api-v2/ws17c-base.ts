// Api::V2::BaseController for the actions served by Node: Doorkeeper authorization, `render_response` and the error helpers, over the
// ActionResult processAction understands. The route table that dispatches to the actions is in ./routes.ts.
import type { OauthAccessToken, User } from "@prisma/client";

import { esJson } from "../../search/es-json.ts";
import type { ActionResult, Rendered } from "../application-controller.ts";
import type { Params } from "../rails-body.ts";
import { type ApiV2Input, PUBLIC_READ_SCOPES } from "./base.ts";

// The dispatcher in ./base.ts authorizes the token before the action runs (the route's `scopes`, `requireScope`, `unauthorized`).
export type ApiCall = ApiV2Input;
export type Authorized = { token: OauthAccessToken; owner: User };
export { PUBLIC_READ_SCOPES };
export type { Params };

const JSON_TYPE = "application/json; charset=utf-8";

// `render json:` with escape_json_responses and time_precision 0.
export const renderJson = (body: unknown, status = 200, extra: Partial<Rendered> = {}): Rendered => ({ status, body: esJson(body as never), contentType: JSON_TYPE, paramsRead: true, ...extra });

// `head :status`: a bodyless response of the default text/html type. A before_action that halts skips the after_actions.
export const head = (status: number, headers: Record<string, string> = {}, rescued = true): Rendered => ({ status, body: "", contentType: "text/html", headers, rescued, paramsRead: true });

export type AuthorizeOptions = Record<string, unknown>;

// Kept so the actions read as the controllers do: the token and owner the dispatcher already authorized.
export async function authorize(call: ApiCall, _scopes: string[], _options: AuthorizeOptions = {}): Promise<Authorized> {
  return { token: call.token, owner: call.owner };
}

export const halted = (value: Authorized | { halt: ActionResult }): value is { halt: ActionResult } => "halt" in value;

// render_response(success, result): `{ success: }.merge(result.as_json)`.
export const renderResponse = (success: boolean, result: Record<string, unknown> = {}): Rendered => renderJson({ success, ...result });

export const errorWithObject = (name: string, errors?: string[] | null, present = true): Rendered =>
  renderResponse(false, { message: errors && errors.length > 0 ? toSentence(errors) : present ? `The ${name} was unable to be modified.` : `The ${name} was not found.` });

export const errorWithCreatingObject = (name: string, errors?: string[] | null): Rendered =>
  renderResponse(false, { message: errors && errors.length > 0 ? toSentence(errors) : `The ${name} was unable to be created.` });

export const successWithObject = (name: string, object: unknown | null, additional: Record<string, unknown> = {}): Rendered =>
  object === null ? renderResponse(true, { message: `The ${name} was deleted successfully.` }) : renderResponse(true, { [name]: object, ...additional });

// Time#as_json under time_precision 0 for a UTC time.
export const timeJson = (time: Date | null | undefined): string | null => (time ? `${time.toISOString().slice(0, 19)}Z` : null);

// Api::V2::BaseController#error_400
export const error400 = (message = "Invalid request."): Rendered => renderJson({ status: 400, error: message }, 400);

// Array#to_sentence
export function toSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export const isHash = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// `params.permit(:key)`: scalars only; a hash or array is dropped.
export function permittedScalar(params: Params, key: string): { present: boolean; value: string | number | boolean | null } {
  const value = params[key];
  if (value === undefined || (value !== null && typeof value === "object")) return { present: false, value: null };
  return { present: true, value: value as string | number | boolean | null };
}
