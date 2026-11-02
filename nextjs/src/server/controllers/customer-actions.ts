// CallsController#update and LicensesController#update (app/controllers/{calls,licenses}_controller.rb): the fetch calls the
// customers page makes. Both answer JSON; a request in another format goes to Rails.
import { Prisma, type Call } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { Calls } from "../models/call.ts";
import { adjustUsesBang, disableBang, enableBang, findLicense, MANAGE_SECURE_ID_SCOPE, MAX_SELLER_SETTABLE_USES, resetUsesBang, setUsesBang } from "../models/license.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { audiencePurchasePolicy } from "../policies/audience-purchase.ts";
import { callPolicy } from "../policies/call.ts";
import { authorize } from "../policies/authorize.ts";
import { type ActionResult, HandBackToRails, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { accountEmailRequired, authorizeJson, json, noContent, notFoundJson, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

const CALL_URL_MAX_LENGTH = 1024;
const UNSIGNED_INTEGER = /^-?\d+$/u;
// ActiveModel::Type::Boolean::FALSE_VALUES, as the strings a request carries
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

const requireSignedIn = (input: MutationInput) => {
  if (railsLoggedInUser(input.context) === null || input.context.currentSeller === null) throw new HandBackToRails("a signed-out request");
};

async function update(input: MutationInput): Promise<ActionResult> {
  requireSignedIn(input);
  const decrypted = decrypt(input.routeParams.id!);
  const [row] = decrypted === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`calls`.*")} FROM ${table("calls")} WHERE ${column("calls", "id")} = ${decrypted} LIMIT 1`);
  if (!row) throw new RoutingError("Not Found");
  const call = Calls.load(castRow<Call>("Call", row));

  const [purchase] = call.get("purchase_id") === null ? [] : await selectRows<{ seller_id: bigint | null }>(Prisma.sql`SELECT ${column("purchases", "seller_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${call.get("purchase_id")} LIMIT 1`);
  if (!purchase) throw new NotPortedError("CallPolicy#update?", "a call whose purchase is missing");
  const denied = await authorizeJson(input, (context) => authorize(callPolicy.update, context, purchase.seller_id));
  if (denied) return denied;

  // params.permit(policy(@call).permitted_attributes): a scalar call_url, or nil.
  const attributes: Partial<Call> = {};
  if ("call_url" in input.params) {
    const value = input.params.call_url;
    if (value !== null && typeof value !== "string") throw new HandBackToRails("a call_url that is not a string");
    if (value !== null && [...value].length > CALL_URL_MAX_LENGTH) throw new HandBackToRails("a call_url longer than its column");
    attributes.call_url = value;
  }
  try {
    await Calls.updateBang(call, attributes);
  } catch (error) {
    // Validations run before the first statement, so Rails can take the request whole.
    if (error instanceof RecordInvalid) throw new NotPortedError("Call#update!", "a call that no longer validates");
    throw error;
  }
  return noContent();
}

// `cast_integer(value, min:)`: nil means "reject".
function castInteger(value: unknown, min: number): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    if (value === null) return null;
    throw new HandBackToRails("a uses parameter that is not a scalar");
  }
  const text = String(value);
  if (!UNSIGNED_INTEGER.test(text)) return null;
  const number = BigInt(text);
  return number >= BigInt(min) && number <= BigInt(MAX_SELLER_SETTABLE_USES) ? Number(number) : null;
}

const usesError = () => json({ error: `Uses must be a whole number between 0 and ${MAX_SELLER_SETTABLE_USES}.` }, UNPROCESSABLE_ENTITY);

async function updateLicense(input: MutationInput): Promise<ActionResult> {
  requireSignedIn(input);
  const emailRequired = accountEmailRequired(input);
  if (emailRequired) return emailRequired;

  const id = decryptSecureExternalId("License", input.routeParams.id, MANAGE_SECURE_ID_SCOPE);
  const license = id === null ? null : await findLicense(BigInt(id));
  if (license === null) return notFoundJson();
  const denied = await authorizeJson(input, (context) => authorize(audiencePurchasePolicy.manageLicense, context));
  if (denied) return denied;

  const { params } = input;
  if ("adjust_uses" in params) {
    const delta = castInteger(params.adjust_uses, -MAX_SELLER_SETTABLE_USES);
    if (delta === null) return usesError();
    await adjustUsesBang(license, delta);
    return json({ uses: license.get("uses") });
  }
  if ("uses" in params) {
    const uses = castInteger(params.uses, 0);
    if (uses === null) return usesError();
    await setUsesBang(license, uses);
    return json({ uses: license.get("uses") });
  }
  if ("reset_uses" in params) await resetUsesBang(license);
  else {
    const enabled = params.enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== "string" && typeof enabled !== "boolean") throw new HandBackToRails("an enabled parameter that is not a scalar");
    // ActiveModel::Type::Boolean: blank is nil (falsy), the FALSE_VALUES are false, anything else true.
    const truthy = enabled === true || (typeof enabled === "string" && enabled !== "" && !FALSE_VALUES.has(enabled));
    if (truthy) await enableBang(license);
    else await disableBang(license);
  }
  return noContent();
}

registerMutations(
  ...["PUT", "PATCH"].flatMap((method) => [
    { method, pattern: "/calls/:id", json: true, run: update },
    { method, pattern: "/licenses/:id", json: true, run: updateLicense },
  ]),
);
