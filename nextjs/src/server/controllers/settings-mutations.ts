// Settings::ThirdPartyAnalyticsController#update and Settings::AdvancedController#update
// (app/controllers/settings/third_party_analytics_controller.rb, advanced_controller.rb).
//
// A request Rails would answer differently from what the port can prove is handed back before its first write: a missing or
// malformed `user` param (strong parameters raise inside the action's own rescue), a float or huge integer for a snippet id, and a
// JSON-data field that is neither a string nor an integer. Integers, floats and booleans for string columns are cast, arrays and hashes under scalar keys are dropped (as `permit` does), and a numeric or `true` blocked_customer_emails
// gets the action's own rescue (the generic block failure).
import type { BillingDetail } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";
import { billingDetailOfPurchaser, BillingDetails } from "../models/billing-detail.ts";
import { activeBlockedEmails, blockEmailBang, unblockActive } from "../models/blocked-customer-object.ts";
import { RubyFloat, rubyFloatToS } from "../models/concerns/ruby-values.ts";
import { aliveCustomDomainOf, CustomDomainDeletable, CustomDomains } from "../models/custom-domain.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { isBlank } from "../models/runtime/validators.ts";
import {
  saveThirdPartyAnalytics,
  ThirdPartyAnalyticInvalid,
  type SnippetParams,
} from "../models/third-party-analytic.ts";
import {
  isValidEmailFormat,
  NotPortedError,
  setFlag,
  setJsonDataForAttr,
  Users,
  findUserBang,
  type UserFlag,
  type UserRecord,
} from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import { settingsAdvancedUserPolicy } from "../policies/settings/advanced-user.ts";
import { settingsBillingPolicy } from "../policies/settings/billing.ts";
import { settingsThirdPartyAnalyticsUserPolicy } from "../policies/settings/third-party-analytics-user.ts";
import { customDomainPointsToGumroad } from "../services/custom-domain-verification.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestParams, type Params } from "./rails-body.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const ANALYTICS_PATH = "/settings/third_party_analytics";
const ADVANCED_PATH = "/settings/advanced";
const FLASH_CHANGES_SAVED = "Changes saved!";
const FLASH_ACCOUNT_UPDATED = "Your account has been updated!";
const FLASH_SOMETHING_BROKE = "Something broke. We're looking into what happened. Sorry about this!";
const FLASH_BLOCK_FAILED = "Sorry, something went wrong. Please try again.";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof RubyFloat);

// The request's params with every JSON number written as a float (`5.0`, `1e2`) kept as a RubyFloat: a settings form can send one and
// Rails casts it differently from the integer JavaScript would read.
export const paramsWithFloats = (input: MutationInput): Params =>
  requestParams(input.url, input.request.headers.get("content-type"), input.rawBody, true);
const redirect = (location: string, alert: string, status = FOUND): ActionResult => ({
  status,
  location,
  flash: { alert },
});

// FlagShihTzu::TRUE_VALUES
export const TRUE_VALUES: unknown[] = [true, 1, "1", "t", "T", "true", "TRUE"];

// `TRUE_VALUES.include?(value)` compares with `==`, so only the Float 1.0 equals the Integer 1.
export const trueValue = (value: unknown): boolean =>
  value instanceof RubyFloat ? value.value === 1 : TRUE_VALUES.includes(value);

// ActiveSupport's Array#to_sentence
export function toSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// String#split(/[\r\n]+/): trailing empty fields are dropped, a leading one stays.
function splitLines(value: string): string[] {
  const parts = value.split(/[\r\n]+/u);
  while (parts.at(-1) === "") parts.pop();
  return parts;
}

// `params.require(:user)`: a non-blank hash. Anything else raises inside the action.
function requireUser(params: Record<string, unknown>): Record<string, unknown> {
  const user = params.user;
  if (!isHash(user) || Object.keys(user).length === 0) throw new HandBackToRails("a request without a user hash");
  return user;
}

// Strong parameters' PERMITTED_SCALAR_TYPES; an array or hash under a scalar key is dropped, not an error.
export const isPermittedScalar = (value: unknown) =>
  value === null || value instanceof RubyFloat || ["string", "number", "bigint", "boolean"].includes(typeof value);

// A permitted scalar for a string column: an integer casts to its digits, true/false to "1"/"0" for a varchar column (the MySQL
// adapter's string type) and to "t"/"f" for a text one, and a Float to its Float#to_s. A float only reaches here as a RubyFloat (see
// `paramsWithFloats`); a bare number is an Integer, and one past 2**53 is handed back.
export function stringValue(value: unknown, column: "varchar" | "text" = "varchar"): string | null {
  if (value === null || typeof value === "string") return value;
  if (value instanceof RubyFloat && Number.isFinite(value.value)) return rubyFloatToS(value.value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return column === "text" ? (value ? "t" : "f") : value ? "1" : "0";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new HandBackToRails("a non-string value for a string attribute");
}

// The JSON-data tiktok_pixel_id keeps what the request sent (no string column cast). An integer reaches the model's
// `tiktok_pixel_id.strip` callback, which raises and lands in the action's rescue-all.
export function tiktokPixelIdValue(value: unknown): string | number | bigint | RubyFloat | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") return value;
  if (value instanceof RubyFloat && Number.isFinite(value.value)) return value;
  return plainStringValue(value);
}

// For a tiktok_pixel_id, which does not go through a string column's cast.
function plainStringValue(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new HandBackToRails("a non-string value for a string attribute");
}

// A snippet field stays as sent: `save_third_party_analytics` compares and keys on the raw param and casts it only when it
// assigns a string column or looks a permalink up. The `id` is the exception: a float or a huge integer is decoded as an external
// id, which is not recorded.
export function snippetValue(value: unknown, key = ""): string | number | bigint | RubyFloat | boolean | null {
  if (key === "id" && (value instanceof RubyFloat || typeof value === "bigint"))
    throw new HandBackToRails("a float or a huge integer for a snippet id");
  stringValue(value);
  return value as string | number | bigint | RubyFloat | boolean | null;
}

const FLAG_PARAMS: Record<string, UserFlag> = {
  disable_third_party_analytics: "disable_third_party_analytics",
  skip_free_sale_analytics: "skip_free_sale_analytics",
  enable_verify_domain_third_party_services: "enable_verify_domain_third_party_services",
};
const COLUMN_PARAMS = ["google_analytics_id", "facebook_pixel_id", "facebook_meta_tag"] as const;
const SNIPPET_KEYS = ["id", "code", "location", "name", "product"] as const;
const PERMITTED_USER_KEYS = [...Object.keys(FLAG_PARAMS), ...COLUMN_PARAMS, "tiktok_pixel_id", "snippets"];

// `permit(..., snippets: [[:id, :code, :location, :name, :product]])`
function permittedSnippets(value: unknown): SnippetParams[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HandBackToRails("snippets that are not a list");
  return value.map((entry) => {
    if (!isHash(entry)) throw new HandBackToRails("a snippet that is not a hash");
    const snippet: Record<string, unknown> = {};
    for (const key of SNIPPET_KEYS)
      if (key in entry && isPermittedScalar(entry[key])) snippet[key] = snippetValue(entry[key], key);
    return snippet;
  });
}

// `current_seller.assign_attributes(third_party_analytics_params.except(:snippets))`, in the order the params arrive.
function assignAnalyticsAttributes(seller: UserRecord, user: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(user)) {
    if (!PERMITTED_USER_KEYS.includes(key) || key === "snippets" || !isPermittedScalar(value)) continue;
    if (key in FLAG_PARAMS) setFlag(seller, FLAG_PARAMS[key]!, trueValue(value));
    else if (key === "tiktok_pixel_id") setJsonDataForAttr(seller, key, tiktokPixelIdValue(value));
    else seller.set(key as (typeof COLUMN_PARAMS)[number], stringValue(value));
  }
}

async function guard(input: MutationInput, authorize: Parameters<typeof settingsGuard>[0]["authorize"]) {
  return settingsGuard({ authorize })({
    context: input.context,
    config: domainConfig(process.env),
    url: input.url,
    params: input.routeParams,
    urlOptions: input.urlOptions,
  });
}

async function updateThirdPartyAnalytics(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, settingsThirdPartyAnalyticsUserPolicy.update);
  if (denied) return denied;

  const user = requireUser(paramsWithFloats(input));
  const snippets = permittedSnippets(user.snippets);
  const seller = await findUserBang(input.context.currentSeller!.id);
  try {
    return await Users.withLock(seller, async () => {
      assignAnalyticsAttributes(seller, user);
      await saveThirdPartyAnalytics(snippets, seller.get("id"));
      if (await Users.save(seller))
        return { status: SEE_OTHER, location: ANALYTICS_PATH, flash: { notice: FLASH_CHANGES_SAVED } };
      return redirect(ANALYTICS_PATH, toSentence(seller.errors.fullMessages()));
    });
  } catch (error) {
    if (error instanceof ThirdPartyAnalyticInvalid) return redirect(ANALYTICS_PATH, error.message);
    if (error instanceof NotPortedError || error instanceof HandBackToRails) throw error;
    notifyError(error);
    return redirect(ANALYTICS_PATH, FLASH_SOMETHING_BROKE);
  }
}

// `(params[:blocked_customer_emails].presence || "").split(/[\r\n]+/)`. A number or `true` is present and has no `split`: the
// NoMethodError is rescued by the action, which answers with the generic block failure. `false` is blank.
export function blockedEmailLines(value: unknown): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (typeof value === "string") return splitLines(value.trim() === "" ? "" : value);
  throw new Error("undefined method 'split' for a non-string blocked_customer_emails");
}

// block_customer_emails: returns the first invalid email, which stops the transaction before it writes.
async function blockCustomerEmails(sellerId: unknown, emails: string[]): Promise<string | null> {
  const invalid = emails.find((email) => !isValidEmailFormat(email));
  if (invalid !== undefined) return invalid;
  if (emails.length > 0) {
    const previous = await activeBlockedEmails(sellerId);
    await unblockActive(sellerId, { emailsOnly: true, values: previous.filter((email) => !emails.includes(email)) });
    for (const email of emails) await blockEmailBang(email, sellerId);
  } else {
    await unblockActive(sellerId, { emailsOnly: false });
  }
  return null;
}

// The custom domain branch of Settings::AdvancedController#update: `verify` marks an unverified domain verified (resetting its failed
// attempts) when DNS points at Gumroad, and a verified one unverified when it does not (an unverified one stays so, and the
// failed-attempts counter is not incremented from here), then one save. Rails saves inside the state event and again after it; the
// second save has nothing left to write, and a refused first save rolls the state back, so one save carries the same outcome.
async function saveCustomDomain(seller: UserRecord, domain: string, pointsToGumroad: boolean): Promise<string | null> {
  const record =
    (await aliveCustomDomainOf(seller.get("id"), seller.attributes)) ??
    CustomDomains.build({ user_id: Number(seller.get("id")) });
  record.set("domain", domain);
  if (pointsToGumroad && record.get("state") !== "verified") {
    record.set("state", "verified");
    record.set("failed_verification_attempts_count", 0);
  } else if (!pointsToGumroad && record.get("state") === "verified") {
    record.set("state", "unverified");
  }
  if (await CustomDomains.save(record)) return null;
  return toSentence(record.errors.fullMessages());
}

async function updateAdvanced(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, settingsAdvancedUserPolicy.update);
  if (denied) return denied;

  const user = requireUser(paramsWithFloats(input));
  const { domain, blocked_customer_emails: emails } = input.params;
  if (!(domain === undefined || domain === null || typeof domain === "string"))
    throw new HandBackToRails("a domain that is not a string");
  // `params[:domain].present?`. The DNS lookup is a read that changes nothing, so it runs before the first write.
  const customDomain = typeof domain === "string" && !isBlank(domain) ? domain : null;
  const pointsToGumroad = customDomain !== null && (await customDomainPointsToGumroad(customDomain));
  if (isHash(emails) || Array.isArray(emails)) throw new HandBackToRails("blocked emails that are a hash or a list");
  const endpoint =
    "notification_endpoint" in user && isPermittedScalar(user.notification_endpoint)
      ? stringValue(user.notification_endpoint, "text")
      : undefined;

  const seller = await findUserBang(input.context.currentSeller!.id);
  try {
    const list = blockedEmailLines(emails);
    const invalid = await transaction(() => blockCustomerEmails(seller.get("id"), list));
    if (invalid !== null) return redirect(ADVANCED_PATH, `The email ${invalid} cannot be blocked as it is invalid.`);
  } catch (error) {
    if (error instanceof NotPortedError || error instanceof HandBackToRails) throw error;
    notifyError(error);
    return redirect(ADVANCED_PATH, FLASH_BLOCK_FAILED);
  }

  try {
    await Users.withLock(seller, async () => {
      await Users.update(seller, endpoint === undefined ? {} : { notification_endpoint: endpoint });
    });
  } catch (error) {
    if (error instanceof NotPortedError || error instanceof HandBackToRails) throw error;
    notifyError(error);
    return redirect(ADVANCED_PATH, FLASH_SOMETHING_BROKE);
  }

  if (customDomain !== null) {
    const failure = await saveCustomDomain(seller, customDomain, pointsToGumroad);
    if (failure !== null) return redirect(ADVANCED_PATH, failure);
  } else if (domain === "") {
    // `params[:domain] == "" && current_seller.custom_domain.present?`
    const stored = await aliveCustomDomainOf(seller.get("id"), seller.attributes);
    if (stored !== null) await CustomDomainDeletable.markDeletedBang(stored);
  }

  if (await Users.save(seller))
    return { status: SEE_OTHER, location: ADVANCED_PATH, flash: { notice: FLASH_ACCOUNT_UPDATED } };
  return redirect(ADVANCED_PATH, toSentence(seller.errors.fullMessages()));
}

// Settings::BillingController#update (app/controllers/settings/billing_controller.rb). Only a plain string, null or boolean
// is ported: Rails drops other types of a permitted key, and a blank boolean is nil in a NOT NULL column.
const BILLING_PATH = "/settings/billing";
const FLASH_BILLING_SAVED = "Your billing details have been saved.";
const BILLING_TEXT_ATTRIBUTES = [
  "full_name",
  "business_name",
  "business_id",
  "street_address",
  "city",
  "state",
  "zip_code",
  "country_code",
  "additional_notes",
] as const;
// ActiveModel::Type::Boolean's FALSE_VALUES, for the strings that reach the port.
const BOOLEAN_FALSE_STRINGS = ["0", "f", "F", "false", "FALSE", "off", "OFF"];

// `params.require(:billing_detail).permit(...)`: a non-blank hash. Anything else raises inside the action.
function billingDetailAttributes(params: Record<string, unknown>): Partial<BillingDetail> {
  const detail = params.billing_detail;
  if (!isHash(detail) || Object.keys(detail).length === 0)
    throw new HandBackToRails("a request without a billing_detail hash");
  const attributes: Record<string, unknown> = {};
  for (const key of BILLING_TEXT_ATTRIBUTES)
    if (key in detail) attributes[key] = stringValue(detail[key], key === "additional_notes" ? "text" : "varchar");
  if ("auto_email_invoice_enabled" in detail) {
    const value = detail.auto_email_invoice_enabled;
    // ActiveModel's Boolean type lists only the Integer 0 among its false values, so every Float, 0.0 included, is true.
    if (typeof value === "boolean") attributes.auto_email_invoice_enabled = value;
    else if (value instanceof RubyFloat) attributes.auto_email_invoice_enabled = true;
    else if (typeof value === "string" && value !== "")
      attributes.auto_email_invoice_enabled = !BOOLEAN_FALSE_STRINGS.includes(value);
    else throw new HandBackToRails("an auto_email_invoice_enabled value that does not cast cleanly");
  }
  return attributes as Partial<BillingDetail>;
}

// inertia_errors(billing_detail): `billing_detail.<attribute>` keys, each attribute's messages joined as a sentence.
function billingErrors(detail: ModelRecord<BillingDetail>): Record<string, unknown> {
  const attributes = [...new Set(detail.errors.details.map((error) => error.attribute))];
  return Object.fromEntries(
    attributes.map((attribute) => [`billing_detail.${attribute}`, toSentence(detail.errors.on(attribute))]),
  );
}

async function updateBillingDetail(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, settingsBillingPolicy.update);
  if (denied) return denied;

  const attributes = billingDetailAttributes(paramsWithFloats(input));
  const purchaserId = input.context.currentSeller!.id;
  const detail = (await billingDetailOfPurchaser(purchaserId)) ?? BillingDetails.build({ purchaser_id: purchaserId });
  detail.assign(attributes);
  if (await BillingDetails.save(detail))
    return { status: SEE_OTHER, location: BILLING_PATH, flash: { notice: FLASH_BILLING_SAVED } };
  return { status: FOUND, location: BILLING_PATH, inertiaErrors: billingErrors(detail) };
}

registerMutations(
  ...["PUT", "PATCH"].flatMap((method) => [
    { method, pattern: ANALYTICS_PATH, run: updateThirdPartyAnalytics },
    { method, pattern: ADVANCED_PATH, run: updateAdvanced },
    { method, pattern: BILLING_PATH, run: updateBillingDetail },
  ]),
);
