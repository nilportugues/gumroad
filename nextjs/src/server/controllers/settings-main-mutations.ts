// Settings::MainController#update and #resend_confirmation_email (app/controllers/settings/main_controller.rb).
//
// An update that sends no mail and needs nothing Node cannot prove is served here: the notification flags, locale, timezone, currency,
// the PPP settings, the support email, the account-level refund policy, the PPP exclusions, product-level support emails and the
// feature-announcements consent. A new or pending email address (Devise mails the seller), a username change and a refund policy whose
// fine print needs the LLM classifier go to Rails whole. The steps run in one transaction that only a hand-back rolls back: Rails commits
// each step before the next, so a step that fails the way Rails rescues keeps the ones before it.
import { Prisma, type Link, type RefundPolicy, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { RubyFloat } from "../models/concerns/ruby-values.ts";
import { LinkFlags, Links } from "../models/link.ts";
import { RefundPolicies } from "../models/refund-policy.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { isBlank } from "../models/runtime/validators.ts";
import {
  castRow,
  column,
  columnIn,
  columnNotIn,
  execute,
  isRecordNotUnique,
  selectRows,
  table,
} from "../models/sql.ts";
import {
  findUserBang,
  isReservedEmailDomain,
  isValidEmailFormat,
  NotPortedError,
  setFlag,
  UserFlags,
  Users,
  type UserFlag,
  type UserRecord,
} from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { notAllowedMessage, settingsGuard } from "../page-props/settings/guard.ts";
import { authorize } from "../policies/authorize.ts";
import { loadSellerContext, NotAuthorizedError } from "../policies/seller-context.ts";
import { settingsMainUserPolicy } from "../policies/settings/main-user.ts";

import { accountLevelRefundPolicyEnabled, sellerRefundPolicy } from "./api-v2/refund-policies.ts";
import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { jsonResponse } from "./seller-json-guard.ts";
import { isPermittedScalar, paramsWithFloats, stringValue, toSentence, trueValue } from "./settings-mutations.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const UNAUTHORIZED = 401;
const MAIN_PATH = "/settings";
const FLASH_UPDATED = "Your account has been updated!";
const FLASH_STALE_ANNOUNCEMENTS =
  "Your account has been updated, but Feature announcements changed elsewhere, so that setting was not saved.";
const FLASH_SOMETHING_BROKE = "Something broke. We're looking into what happened. Sorry about this!";
const FLASH_RESEND_FAILED = "Sorry, something went wrong. Please try again.";
const FEATURE_ANNOUNCEMENTS_SOURCE = "settings";
const UNKNOWN_VERSION = -1;

const FLAG_PARAMS: readonly UserFlag[] = [
  "enable_payment_email",
  "enable_payment_push_notification",
  "enable_recurring_subscription_charge_email",
  "enable_recurring_subscription_charge_push_notification",
  "enable_free_downloads_email",
  "enable_free_downloads_push_notification",
  "announcement_notification_enabled",
  "disable_comments_email",
  "disable_reviews_email",
  "disable_review_reminders",
  "purchasing_power_parity_enabled",
  "purchasing_power_parity_payment_verification_disabled",
  "show_nsfw_products",
  "disable_affiliate_requests",
];
const STRING_PARAMS = ["support_email", "locale", "timezone", "currency_type"] as const;
// NOT NULL columns: a null is a database error Rails rescues, which the port does not reproduce.
const NOT_NULL_PARAMS: readonly string[] = ["locale", "timezone"];
// `email` and `username` are permitted but only served unchanged (`assertUnchangedIdentity`).
const PERMITTED_USER_KEYS = new Set<string>([...FLAG_PARAMS, ...STRING_PARAMS, "purchasing_power_parity_limit"]);

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof RubyFloat);
const redirect = (alert: string): ActionResult => ({ status: FOUND, location: MAIN_PATH, flash: { alert } });

// `params.require(:user)`: a non-blank hash. Anything else raises inside the action's own rescue.
function requireUser(params: Record<string, unknown>): Record<string, unknown> {
  const user = params.user;
  if (!isHash(user) || Object.keys(user).length === 0) throw new HandBackToRails("a request without a user hash");
  return user;
}

function assertUnchangedIdentity(seller: UserRecord, user: Record<string, unknown>): void {
  if (!isBlank(seller.get("unconfirmed_email")))
    throw new HandBackToRails("a seller with an email change awaiting confirmation");
  if ("email" in user && !(typeof user.email === "string" && user.email !== "" && user.email === seller.get("email")))
    throw new HandBackToRails("an email address that differs from the stored one");
  if ("username" in user && user.username !== seller.get("username")) throw new HandBackToRails("a username change");
}

// A 4-byte integer column: ActiveModel raises a RangeError past it when the row is saved.
const MAX_INTEGER_COLUMN = 2 ** 31 - 1;

// The Integer type's cast of what the form can send; a boolean or text with trailing garbage is Rails' call. A Float is truncated
// (`Float#to_i`).
function integerValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof RubyFloat) {
    const truncated = Math.trunc(value.value) + 0;
    if (Number.isFinite(value.value) && Math.abs(truncated) <= MAX_INTEGER_COLUMN) return truncated;
    throw new HandBackToRails("a float an integer column would reject as out of range");
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/u.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new HandBackToRails("a value an integer column would cast differently");
}

// `current_seller.assign_attributes(user_params)`, in the order the params arrive.
function assignAttributes(seller: UserRecord, user: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(user)) {
    if (!PERMITTED_USER_KEYS.has(key) || !isPermittedScalar(value)) continue;
    if ((FLAG_PARAMS as readonly string[]).includes(key)) setFlag(seller, key as UserFlag, trueValue(value));
    else if (key === "purchasing_power_parity_limit") seller.set(key, integerValue(value));
    else {
      if (value === null && NOT_NULL_PARAMS.includes(key)) throw new HandBackToRails(`a null ${key}`);
      seller.set(key as (typeof STRING_PARAMS)[number], stringValue(value));
    }
  }
}

// ActiveModel::Type::Boolean.new.cast(value) || false. FALSE_VALUES is a Set, so only the Integer 0 matches, never the Float 0.0.
const BOOLEAN_FALSE_VALUES: unknown[] = [false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"];
const castBoolean = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && !BOOLEAN_FALSE_VALUES.includes(value);

// `Integer(value.to_s, exception: false) || -1`. Octal and underscored spellings parse differently in Ruby; Rails' call. A Float's
// text ("3.0", "1.0e+20") is never an Integer.
function renderedVersion(value: unknown): number {
  if (value instanceof RubyFloat) return UNKNOWN_VERSION;
  if (typeof value === "bigint") throw new HandBackToRails("a feature announcements version past 2**53");
  if (value === undefined || value === null || typeof value === "boolean" || value === "") return UNKNOWN_VERSION;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(?:0|-?[1-9]\d*)$/u.test(value)) return Number.parseInt(value, 10);
  throw new HandBackToRails("a feature announcements version that Integer() parses differently");
}

type AnnouncementResult = "unchanged" | "updated" | "stale";
const ANNOUNCEMENTS = "feature_announcement_subscriptions";

// FeatureAnnouncementSubscription.update_from_settings!, without its bounded lock wait, which only changes how long a contended row blocks.
async function updateFromSettings(
  userId: bigint,
  subscribed: boolean,
  version: number,
  now: Date,
): Promise<AnnouncementResult> {
  const [row] = await selectRows<{ subscribed: number | boolean; version: number }>(
    Prisma.sql`SELECT ${column(ANNOUNCEMENTS, "subscribed")}, ${column(ANNOUNCEMENTS, "version")} FROM ${table(ANNOUNCEMENTS)} WHERE ${column(ANNOUNCEMENTS, "user_id")} = ${userId} LIMIT 1`,
  );
  const current = { subscribed: row ? Boolean(row.subscribed) : false, version: row ? Number(row.version) : 0 };
  if (current.subscribed === subscribed) return "unchanged";
  if (current.version !== version) return "stale";

  if (version === 0) {
    try {
      await execute(
        Prisma.sql`INSERT INTO ${table(ANNOUNCEMENTS)} (user_id, subscribed, version, source, created_at, updated_at) VALUES (${userId}, ${subscribed}, 1, ${FEATURE_ANNOUNCEMENTS_SOURCE}, ${now}, ${now})`,
      );
    } catch (error) {
      if (isRecordNotUnique(error)) return "stale";
      throw error;
    }
    return "updated";
  }
  const affected = await execute(
    Prisma.sql`UPDATE ${table(ANNOUNCEMENTS)} SET subscribed = ${subscribed}, version = version + 1, source = ${FEATURE_ANNOUNCEMENTS_SOURCE}, updated_at = ${now} WHERE ${column(ANNOUNCEMENTS, "user_id")} = ${userId} AND ${column(ANNOUNCEMENTS, "version")} = ${version}`,
  );
  return affected === 1 ? "updated" : "stale";
}

// `ObfuscateIds.decrypt` per external id; one that does not decrypt is dropped, as `where(id: [nil, 5])` matches only 5.
function decryptedIds(value: unknown): bigint[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new HandBackToRails("product ids that are not a list of strings");
  return (value as string[])
    .map((id) => decrypt(id))
    .filter((id): id is number => id !== null)
    .map(BigInt);
}

// User#update_purchasing_power_parity_excluded_products!: `products.purchasing_power_parity_disabled.or(products.by_external_ids(ids))`.
async function updateExcludedProducts(seller: UserRecord, externalIds: string[]): Promise<void> {
  const ids = decryptedIds(externalIds);
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.get("id")} AND (${LinkFlags.condition("purchasing_power_parity_disabled")} OR ${columnIn("links", "id", ids)})`,
  );
  for (const row of rows) {
    const product = Links.load(castRow<Link>("Link", row));
    const shouldDisable = externalIds.includes(encrypt(product.get("id")));
    if (shouldDisable && LinkFlags.isSet(product.get("flags"), "purchasing_power_parity_disabled")) continue;
    // Validations are skipped, as in `save!(validate: false)`: a product can carry errors unrelated to this flag.
    await Links.updateBang(
      product,
      { flags: LinkFlags.set(product.get("flags"), "purchasing_power_parity_disabled", shouldDisable) },
      { validate: false },
    );
  }
}

type SupportEmailEntry = { email: string; ids: bigint[] };

// Product::BulkUpdateSupportEmailService#reject_blank_entries. An entry with no email or no list is not rejected by Rails and means
// "clear these products"; the port leaves it to Rails.
function supportEmailEntries(value: unknown): SupportEmailEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HandBackToRails("product-level support emails that are not a list");
  const entries: SupportEmailEntry[] = [];
  for (const entry of value) {
    if (!isHash(entry)) throw new HandBackToRails("a support email entry that is not a hash");
    const { email, product_ids: productIds } = entry;
    if (typeof email !== "string" || !Array.isArray(productIds))
      throw new HandBackToRails("a support email entry without an email or a list");
    if (isBlank(email) || productIds.length === 0) continue;
    entries.push({ email, ids: decryptedIds(productIds) });
  }
  return entries;
}

// The ActiveModel::ValidationError of ReplicateSupportEmailValidationsOnLink#validate!, which the action rescues.
class SupportEmailInvalid extends Error {}

// User#update_product_level_support_emails!
async function updateProductLevelSupportEmails(seller: UserRecord, entries: SupportEmailEntry[]): Promise<void> {
  for (const { email } of entries)
    if (!isValidEmailFormat(email) || isReservedEmailDomain(email))
      throw new SupportEmailInvalid(`Validation failed: Support email ${email}`);

  const sellerId = seller.get("id");
  const affected = entries.flatMap((entry) => entry.ids);
  await transaction(async () => {
    await execute(
      Prisma.sql`UPDATE ${table("links")} SET ${column("links", "support_email")} = NULL WHERE ${column("links", "user_id")} = ${sellerId} AND ${affected.length > 0 ? Prisma.sql`${columnNotIn("links", "id", affected)} AND ` : Prisma.empty}${column("links", "support_email")} IS NOT NULL`,
    );
    for (const { email, ids } of entries)
      await execute(
        Prisma.sql`UPDATE ${table("links")} SET ${column("links", "support_email")} = ${email} WHERE ${column("links", "user_id")} = ${sellerId} AND ${columnIn("links", "id", ids)}`,
      );
  });
}

type RefundPolicyParams = { max_refund_period_in_days: number | null; fine_print: string | null };

// `seller_refund_policy_params`, read only when the section is editable (`nil[:max_refund_period_in_days]` raises otherwise). A key left
// out is assigned nil, so it clears the stored value.
function refundPolicyParams(user: Record<string, unknown>): RefundPolicyParams {
  const policy = user.seller_refund_policy;
  if (!isHash(policy)) throw new HandBackToRails("a refund policy section that is not a hash");
  const days = policy.max_refund_period_in_days;
  const finePrint = policy.fine_print;
  return {
    max_refund_period_in_days: isPermittedScalar(days) ? integerValue(days) : null,
    fine_print: isPermittedScalar(finePrint) ? stringValue(finePrint, "text") : null,
  };
}

// The fine print classifier calls an LLM; a save that reaches it goes to Rails before the first write of the request.
function assertNoClassifierNeeded(row: RefundPolicy, params: RefundPolicyParams): void {
  const guaranteed = params.max_refund_period_in_days !== null && params.max_refund_period_in_days > 0;
  const changed =
    params.fine_print !== row.fine_print || params.max_refund_period_in_days !== row.max_refund_period_in_days;
  if (params.fine_print !== null && params.fine_print.trim() !== "" && guaranteed && changed)
    throw new HandBackToRails("a refund policy whose fine print the classifier checks");
}

// User#refund_policy_settings_editable?
async function refundPolicyEditable(seller: UserRecord): Promise<boolean> {
  const row = seller.attributes as User;
  if (UserFlags.isSet(row.flags, "refund_policy_enforced")) return false;
  return accountLevelRefundPolicyEnabled(row);
}

async function updateRefundPolicy(seller: UserRecord, user: Record<string, unknown>): Promise<string | null> {
  const row = await sellerRefundPolicy(seller.attributes as User);
  if (!row) throw new HandBackToRails("a seller without an account-level refund policy");
  const policy = RefundPolicies.load(row);
  if (await RefundPolicies.update(policy, refundPolicyParams(user))) return null;
  return toSentence(policy.errors.fullMessages());
}

// Settings::MainController is the one settings controller that does not need an account email.
const guard = (input: MutationInput, query: Parameters<typeof settingsGuard>[0]["authorize"]) =>
  settingsGuard({ authorize: query, skipRequireAccountEmail: true })({
    context: input.context,
    config: domainConfig(process.env),
    url: input.url,
    params: input.routeParams,
    urlOptions: input.urlOptions,
  });

async function update(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, settingsMainUserPolicy.update);
  if (denied) return denied;

  const user = requireUser(paramsWithFloats(input));
  const seller = await findUserBang(input.context.currentSeller!.id);
  assertUnchangedIdentity(seller, user);

  const announcing = "feature_announcements_subscribed" in user;
  if (announcing && !isPermittedScalar(user.feature_announcements_subscribed))
    throw new HandBackToRails("a non-scalar feature announcements flag");
  const subscribed = castBoolean(user.feature_announcements_subscribed);
  const version = announcing ? renderedVersion(user.feature_announcements_version) : UNKNOWN_VERSION;

  const editable = await refundPolicyEditable(seller);
  if (editable) {
    const row = await sellerRefundPolicy(seller.attributes as User);
    if (!row) throw new HandBackToRails("a seller without an account-level refund policy");
    assertNoClassifierNeeded(row, refundPolicyParams(user));
  }
  const excluded = user.purchasing_power_parity_excluded_product_ids;
  if (!Array.isArray(excluded) || excluded.some((id) => typeof id !== "string"))
    throw new HandBackToRails("excluded products that are not a list of strings");
  const supportEmails = supportEmailEntries(user.product_level_support_emails);

  return transaction(async () => {
    const announcement: { result: AnnouncementResult | null } = { result: null };
    try {
      const saved = await Users.withLock(seller, async () => {
        assignAttributes(seller, user);
        if (!(await Users.save(seller))) return false;
        if (announcing)
          announcement.result = await updateFromSettings(seller.get("id"), subscribed, version, new Date());
        return true;
      });
      if (!saved) return redirect(toSentence(seller.errors.fullMessages()));

      if (editable) {
        const failure = await updateRefundPolicy(seller, user);
        if (failure !== null) return redirect(failure);
      }
      await updateExcludedProducts(seller, excluded as string[]);
      await updateProductLevelSupportEmails(seller, supportEmails);
    } catch (error) {
      if (error instanceof NotPortedError || error instanceof HandBackToRails) throw error;
      notifyError(error);
      return redirect(toSentence(seller.errors.fullMessages()) || FLASH_SOMETHING_BROKE);
    }
    return {
      status: SEE_OTHER,
      location: MAIN_PATH,
      flash: { notice: announcement.result === "stale" ? FLASH_STALE_ANNOUNCEMENTS : FLASH_UPDATED },
    };
  });
}

async function resendConfirmationEmail(input: MutationInput): Promise<ActionResult> {
  const json = requestFormat(input.request) === "json";
  if (json) {
    // PunditAuthorization#default_user_not_authorized answers a JSON request with 401.
    const context = await loadSellerContext(input.context);
    try {
      authorize(settingsMainUserPolicy.resendConfirmationEmail, context);
    } catch (error) {
      if (!(error instanceof NotAuthorizedError)) throw error;
      return { ...jsonResponse({ success: false, error: notAllowedMessage(context) }, UNAUTHORIZED), rescued: true };
    }
  } else {
    const denied = await guard(input, settingsMainUserPolicy.resendConfirmationEmail);
    if (denied) return denied;
  }

  const seller = input.context.currentSeller!;
  // Devise sends the instructions after clearing the address from SendGrid's suppression list.
  if (!isBlank(seller.unconfirmed_email) || seller.confirmed_at == null)
    throw new HandBackToRails("a confirmation email, which Rails sends");
  return json ? jsonResponse({ success: false }) : redirect(FLASH_RESEND_FAILED);
}

registerMutations(
  { method: "PUT", pattern: MAIN_PATH, run: update },
  { method: "PATCH", pattern: MAIN_PATH, run: update },
  {
    method: "POST",
    pattern: "/settings/resend_confirmation_email",
    formats: ["html", "json"],
    run: resendConfirmationEmail,
  },
);
