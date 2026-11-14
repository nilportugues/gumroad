// SecureRedirectController#create (app/controllers/secure_redirect_controller.rb): the confirmation form of /secure_url_redirect.
import { secureDecrypt } from "../auth/secure-encrypt.ts";
import { NotPortedError } from "../models/user.ts";
import { timingSafeEqual } from "node:crypto";

import type { ActionResult } from "./application-controller.ts";
import { registerMutations } from "./mutation.ts";
import { cgiEscape } from "./rails-params.ts";
import { isPresent } from "./rails-request.ts";

const FOUND = 302;
const SEE_OTHER = 303;
// 24.hours
const PAYLOAD_TTL_SECONDS = 86_400;
const DEFAULT_MESSAGE = "Please enter the confirmation text to continue to your destination.";
const DEFAULT_FIELD_NAME = "Confirmation text";
const DEFAULT_ERROR_MESSAGE = "Confirmation text does not match";
// What URI.parse accepts of the destinations Gumroad builds; anything else is left to Rails when the query must be edited.
const URI_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]*$/u;

// A string parameter, or its default for a missing or blank one (`params[name].presence || default`).
function textParam(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new NotPortedError("params[:message]", "a parameter that is not a string");
  return isPresent(value) ? value : fallback;
}

// ActiveSupport::SecurityUtils.secure_compare
const secureCompare = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// `Rack::Utils.parse_query(query)` plus `confirmation_text`, written back with Hash#to_query (pairs sorted).
function withConfirmationText(destination: string, confirmationText: string): string {
  if (!URI_LIKE.test(destination)) throw new NotPortedError("URI.parse", "a destination Ruby's URI parser may reject");
  const [, base = "", query, fragment] = /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/u.exec(destination)!;
  const pairs = new Map<string, string>();
  for (const part of (query ?? "").split("&")) {
    if (part === "") continue;
    const [rawKey = "", ...rest] = part.split("=");
    const rawValue = rest.join("=");
    if (/%(?![0-9A-Fa-f]{2})/u.test(part) || /[[\]]/u.test(rawKey) || pairs.has(decodeForm(rawKey))) throw new NotPortedError("Rack::Utils.parse_query", "a query Node does not parse");
    pairs.set(decodeForm(rawKey), decodeForm(rawValue));
  }
  pairs.set("confirmation_text", confirmationText);
  const merged = [...pairs].map(([key, value]) => `${cgiEscape(key)}=${cgiEscape(value)}`).sort();
  return `${base}?${merged.join("&")}${fragment === undefined ? "" : `#${fragment}`}`;
}

const decodeForm = (value: string) => decodeURIComponent(value.replaceAll("+", " "));

registerMutations({
  method: "POST",
  pattern: "/secure_url_redirect",
  run: async ({ params }): Promise<ActionResult> => {
    const encryptedPayload = params.encrypted_payload;
    if (encryptedPayload === undefined || encryptedPayload === null || encryptedPayload === "") return { status: FOUND, location: "/", rescued: true };
    if (typeof encryptedPayload !== "string") throw new NotPortedError("params[:encrypted_payload]", "a parameter that is not a string");
    if (!isPresent(encryptedPayload)) return { status: FOUND, location: "/", rescued: true };

    const message = textParam(params.message, DEFAULT_MESSAGE);
    const fieldName = textParam(params.field_name, DEFAULT_FIELD_NAME);
    const errorMessage = textParam(params.error_message, DEFAULT_ERROR_MESSAGE);
    // secure_url_redirect_path(...) with its query sorted by key, and the alert in the flash
    const back = (alert: string): ActionResult => ({
      status: FOUND,
      location: `/secure_url_redirect?${Object.entries({ encrypted_payload: encryptedPayload, error_message: errorMessage, field_name: fieldName, message })
        .map(([key, value]) => `${key}=${cgiEscape(value)}`)
        .join("&")}`,
      flash: { alert },
    });

    const confirmationText = params.confirmation_text;
    if (confirmationText !== undefined && confirmationText !== null && typeof confirmationText !== "string") throw new NotPortedError("params[:confirmation_text]", "a parameter that is not a string");
    if (!isPresent(confirmationText)) return back("Please enter the confirmation text");

    const decrypted = secureDecrypt(encryptedPayload);
    if (decrypted === null) return back("Invalid request");
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return back("Invalid request");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new NotPortedError("JSON.parse(payload_json)", "a payload that is not a hash");
    const { destination, confirmation_texts: texts, send_confirmation_text: sendText, created_at: createdAt } = payload as Record<string, unknown>;

    // `payload["created_at"] && Time.current.to_i - payload["created_at"] > 24.hours`
    if (createdAt !== undefined && createdAt !== null && createdAt !== false) {
      if (typeof createdAt !== "number") throw new NotPortedError("Time.current.to_i - payload[\"created_at\"]", "a created_at that is not a number");
      if (Math.floor(Date.now() / 1000) - createdAt > PAYLOAD_TTL_SECONDS) return back("This link has expired");
    }

    const allowed = texts === undefined || texts === null || texts === false ? [] : texts;
    if (!Array.isArray(allowed) || allowed.some((text) => typeof text !== "string")) throw new NotPortedError("confirmation_texts.any?", "texts that are not strings");
    if (destination !== undefined && destination !== null && typeof destination !== "string") throw new NotPortedError("redirect_to destination", "a destination that is not a string");
    if (!(allowed as string[]).some((text) => secureCompare(text, confirmationText))) return back(errorMessage);

    let target = destination ?? null;
    if (sendText !== undefined && sendText !== null && sendText !== false && target !== null) target = withConfirmationText(target, confirmationText);
    if (target !== null && isPresent(target)) return { status: SEE_OTHER, location: target };
    return back("Invalid destination");
  },
});
