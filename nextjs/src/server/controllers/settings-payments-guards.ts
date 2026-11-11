// The actions of Settings::PaymentsController (app/controllers/settings/payments_controller.rb) other than #show and
// #opt_in_to_au_backtax_collection: only the authentication and authorization guards, the refusals decided from the request and
// the stored compliance information, and the redirects that need no processor.
//
// Ported:
//   - #update: the missing-email, Puerto Rico and French overseas department refusals;
//   - #set_country: the 403s, then a first country (or none, for a code the ISO list does not know or a param that is not text)
//     written as a new compliance revision (models/user-compliance-info-writes.ts) with the seller's currency moved to it; JP, a
//     guardian, a minor birthday and open compliance requests are handed back;
//   - #remove_credit_card: the whole action (no processor call: it clears credit_card_id and saves the seller);
//   - #paypal_connect: the redirect for missing or foreign PayPal parameters;
//   - #remediation and #verify_stripe_remediation: the redirects for a seller with no Stripe account (and, for #remediation, a
//     rejected account with nothing left to submit), then the Stripe reads and the AccountLink (settings-payments-remediation.ts).
// Handed to Rails whole, before any write or processor call: everything else. A saved payout method, bank account or card, a
// compliance information edits, payout preferences, Stripe account creation and account links, PayPal merchant linking and the
// remediation sync.
import type { UserComplianceInfo } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { alpha2ByName, countryByAlpha2, isBlank } from "../models/compliance-countries.ts";
import { defaultCurrency } from "../models/country-currency.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../models/merchant-account.ts";
import { birthdayUnderMinimumAge, dupAndSaveBang, UserComplianceInfos } from "../models/user-compliance-info-writes.ts";
import {
  aliveUserComplianceInfoRow,
  businessCountryCode,
  countryCode,
  fetchOrBuildComplianceInfo,
  jsonAttr,
  legalEntityCountryCode,
} from "../models/user-compliance-info.ts";
import { TosAgreements } from "../models/tos-agreement.ts";
import { findUserBang, setFlag, setJsonDataForAttr, Users } from "../models/user.ts";
import { domainConfig } from "../page-props/domain.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import { payoutFacts } from "../page-props/settings/payments.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { settingsPaymentsUserPolicy } from "../policies/settings/payments-user.ts";
import { identifyStateCode } from "../tax/us-zip-codes.ts";

import { HandBackToRails, type ActionResult, type Redirected } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";
import { logPayoutSettingsUpdateByNonOwner } from "./settings-payments-mutations.ts";
import {
  remediateStripeAccount,
  verifyStripeRemediation as verifyStripeRemediationOf,
} from "./settings-payments-remediation.ts";

const FOUND = 302;
const PAYMENTS_PATH = "/settings/payments";
const CHECKOUT_FORM_PATH = "/checkout/form";
const FORBIDDEN = 403;
const BAD_REQUEST = 400;
const JAPAN = "JP";

// Compliance::Countries::US_OUTLYING_AREAS_AS_STATES and FRENCH_OVERSEAS_DEPARTMENTS_AS_FRANCE
const US_OUTLYING_AREAS_AS_STATES = ["PR"];
const FRENCH_OVERSEAS_DEPARTMENTS_AS_FRANCE = ["GF", "GP", "MQ", "YT", "MF"];

const FRENCH_OVERSEAS_DEPARTMENT_MESSAGE =
  "French overseas departments are not valid compliance countries. Select France instead.";
const UNCONFIRMED_EMAIL_MESSAGE = "You have to confirm your email address before you can do that.";
const PUERTO_RICO_MESSAGE =
  "Puerto Rico is not a valid compliance country. Select United States and Puerto Rico as your state.";
const PAYPAL_ERROR_MESSAGE = "There was an error connecting your PayPal account with Gumroad.";
const ALL_SET_MESSAGE = "Thanks! You're all set.";

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `value.present?` for a param: only text can be blank, and only text can equal a country code.
const presentText = (value: unknown): value is string => typeof value === "string" && !isBlank(value);

async function guard(input: MutationInput, authorize: (context: SellerContext) => boolean): Promise<Redirected | null> {
  return settingsGuard({ authorize })({
    context: input.context,
    config: domainConfig(process.env),
    url: input.url,
    params: input.routeParams,
    urlOptions: input.urlOptions,
  });
}

const sellerOf = (input: MutationInput) => input.context.currentSeller!;
const authorizeAs =
  (query: (context: SellerContext, record: NonNullable<SellerContext["seller"]>) => boolean) =>
  (context: SellerContext) =>
    query(context, context.seller!);

// `redirect_to settings_payments_path, inertia: { errors: { base: [message] } }`
const refusal = (message: string): Redirected => ({
  status: FOUND,
  location: PAYMENTS_PATH,
  inertiaErrors: { base: [message] },
});

// `return unless country.present?` ends the action without rendering, which a non-browser request answers with `head :no_content`.
const NO_CONTENT: ActionResult = { status: 204, body: "", contentType: "", paramsRead: true };

// PUT|PATCH /settings/payments
async function update(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, authorizeAs(settingsPaymentsUserPolicy.update));
  if (denied) return denied;

  const seller = sellerOf(input);
  if (isBlank(seller.email)) return refusal(UNCONFIRMED_EMAIL_MESSAGE);
  if (isBlank((await fetchOrBuildComplianceInfo(seller.id)).row.country)) return NO_CONTENT;

  // `params.dig(:user, ...)` raises a TypeError on anything but a hash.
  const user = input.params.user;
  if (user !== undefined && user !== null && !isHash(user))
    throw new HandBackToRails("a user param that is not a hash");
  const submitted = (field: string) => (isHash(user) && presentText(user[field]) ? user[field] : null);

  // The row exists: the blank-country check above passed.
  const current = (await aliveUserComplianceInfoRow(seller.id))!;
  const changesTo = (code: string | null, stored: string | null, territories: string[]) =>
    code !== null && code !== stored && territories.includes(code);

  const attemptedTerritoryChange =
    changesTo(submitted("updated_country_code"), legalEntityCountryCode(current), US_OUTLYING_AREAS_AS_STATES) ||
    changesTo(submitted("country"), countryCode(current), US_OUTLYING_AREAS_AS_STATES) ||
    changesTo(submitted("business_country"), businessCountryCode(current), US_OUTLYING_AREAS_AS_STATES);
  if (attemptedTerritoryChange) return refusal(PUERTO_RICO_MESSAGE);

  const attemptedFrenchTerritory =
    changesTo(
      submitted("updated_country_code"),
      legalEntityCountryCode(current),
      FRENCH_OVERSEAS_DEPARTMENTS_AS_FRANCE,
    ) ||
    changesTo(
      submitted("business_country"),
      businessCountryCode(current) ?? countryCode(current),
      FRENCH_OVERSEAS_DEPARTMENTS_AS_FRANCE,
    );
  if (attemptedFrenchTerritory) return refusal(FRENCH_OVERSEAS_DEPARTMENT_MESSAGE);

  return savePayoutPreferences(input, current);
}

const SEE_OTHER = 303;
const MILITARY_STATES = ["AA", "AE", "AP"];
const THRESHOLD_TOO_LOW_MESSAGE = "Your payout threshold must be greater than the minimum payout amount";
const SWITCH_PREFERENCES: readonly string[] = [
  "payouts_paused_by_user",
  "disable_buyer_local_currency",
  "disable_buyer_currency_rounding",
];
const DIGITS = /^\d{1,15}$/u;

type PayoutPreferences = Record<string, boolean | string | number>;

// The params of a save that only changes payout preferences, or null for anything else. Values are limited to the JSON types the
// page sends and whose Rails casts are plain: a switch as a boolean, a frequency as text, a threshold as an integer or digits
// (json_data keeps the writer's value uncast, so a threshold is stored as sent).
function payoutPreferencesOnly(params: Record<string, unknown>): PayoutPreferences | null {
  const preferences: PayoutPreferences = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "user" && (value === null || value === undefined)) continue;
    if (SWITCH_PREFERENCES.includes(key) && typeof value === "boolean") preferences[key] = value;
    else if (key === "payout_frequency" && typeof value === "string") preferences[key] = value;
    else if (key === "payout_threshold_cents" && typeof value === "number" && Number.isSafeInteger(value))
      preferences[key] = value;
    else if (key === "payout_threshold_cents" && typeof value === "string" && DIGITS.test(value))
      preferences[key] = value;
    else return null;
  }
  return preferences;
}

// stored_military_zip_field: a US address in AA, AE or AP, which makes Rails run the save inside a transaction (the refusals below
// then `return` out of its block).
function storedMilitaryZip(current: UserComplianceInfo): boolean {
  const fields: [string | null, string | null][] = current.is_business
    ? [
        [current.business_zip_code, isBlank(current.business_country) ? countryCode(current) : businessCountryCode(current)],
        [current.zip_code, countryCode(current)],
      ]
    : [[current.zip_code, countryCode(current)]];
  return fields.some(([zip, code]) => code === "US" && MILITARY_STATES.includes(identifyStateCode(zip) ?? ""));
}

// The tail of #update for a request that carries payout preferences and nothing else: no payout method and no compliance
// information, so UpdatePayoutMethod and UpdateUserComplianceInfo have nothing to do. Every save first records a TosAgreement with
// the request's IP, even one that is then refused; what follows is the minimum threshold check and
// `current_seller.update(payout_preference_params)`. Anything else is handed back before the first write, and so is a seller the
// save would give a Stripe account (an active bank account and no managed account yet).
async function savePayoutPreferences(input: MutationInput, current: UserComplianceInfo): Promise<ActionResult> {
  const preferences = payoutPreferencesOnly(input.params);
  if (preferences === null)
    throw new HandBackToRails(
      "a payments settings save, which writes compliance information, payout methods and Stripe accounts",
    );

  const seller = sellerOf(input);
  const facts = await payoutFacts(seller);
  if (facts.stripeAccount === null && storedMilitaryZip(current))
    throw new HandBackToRails("a stored military ZIP code, which wraps the save in a transaction");

  if (
    facts.stripeAccount === null &&
    (await db.bankAccount.count({ where: { user_id: Number(seller.id), deleted_at: null } })) > 0
  )
    throw new HandBackToRails("an active bank account, which gets a Stripe account created from the save");

  await TosAgreements.createBang({ user_id: Number(seller.id), ip: remoteIp(input.request) });

  const threshold = preferences.payout_threshold_cents;
  if (threshold !== undefined && Number(threshold) < facts.minimumPayoutThresholdCents)
    return refusal(THRESHOLD_TOO_LOW_MESSAGE);

  if (Object.keys(preferences).length > 0) {
    const user = await findUserBang(seller.id);
    for (const [key, value] of Object.entries(preferences)) {
      if (key === "payouts_paused_by_user") setFlag(user, "payouts_paused_by_user", value === true);
      else setJsonDataForAttr(user, key, value);
    }
    if (!(await Users.save(user))) return refusal(user.errors.fullMessages()[0] ?? "");
    await logPayoutSettingsUpdateByNonOwner(input, "Payout settings updated");
  }

  return { status: SEE_OTHER, location: PAYMENTS_PATH, flash: { notice: ALL_SET_MESSAGE } };
}

// `head :forbidden` answers the request format's bare content type.
const headForbidden: ActionResult = { status: FORBIDDEN, body: "", contentType: "application/json", paramsRead: true };

// UserComplianceInfo validations and the request sync that the compliance write below does not port: such a revision goes to Rails
// before the first write.
async function complianceWriteUnsupported(
  sellerId: bigint,
  current: UserComplianceInfo,
  countryAlpha2: string | null,
): Promise<string | null> {
  if (countryAlpha2 === JAPAN) return "a Japanese compliance country, which validates the kana fields";
  if (alpha2ByName(current.business_country) === JAPAN)
    return "a Japanese business country, which validates the business name";
  if (current.guardian_id != null) return "a revision with a legal guardian";
  if (birthdayUnderMinimumAge(current.birthday, new Date())) return "a birthday under the minimum age";
  if ((await db.userComplianceInfoRequest.count({ where: { user_id: Number(sellerId), state: "requested" } })) > 0)
    return "open compliance requests, which a new revision can mark provided";
  return null;
}

// POST /settings/payments/set_country
function setCountry(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, authorizeAs(settingsPaymentsUserPolicy.setCountry), async () => {
    const { country } = input.params;

    const seller = sellerOf(input);
    const { row, persisted } = await fetchOrBuildComplianceInfo(seller.id);
    if (!isBlank(row.country)) return headForbidden;
    if (typeof country === "string" && US_OUTLYING_AREAS_AS_STATES.includes(country)) return headForbidden;
    if (typeof country === "string" && FRENCH_OVERSEAS_DEPARTMENTS_AS_FRANCE.includes(country))
      return jsonResponse({ error: FRENCH_OVERSEAS_DEPARTMENT_MESSAGE }, FORBIDDEN, true);

    // `ISO3166::Country[param]&.common_name`: a code the list does not know, or a param that is not text, saves a revision
    // with no country (and so no currency change) and answers 204 like any other.
    const chosen = typeof country === "string" ? countryByAlpha2(country) : null;
    const reason = await complianceWriteUnsupported(seller.id, row, chosen?.alpha2 ?? null);
    if (reason !== null) throw new HandBackToRails(reason);

    const revision = persisted ? UserComplianceInfos.load(row) : UserComplianceInfos.build({ user_id: row.user_id });
    const user = await findUserBang(seller.id);
    await dupAndSaveBang(revision, async (copy) => {
      copy.set("country", chosen?.common_name ?? null);
      // Country.new(country_code): the code the stored name resolves back to.
      const currency = defaultCurrency(alpha2ByName(chosen?.common_name));
      if (currency !== null && currency !== user.get("currency_type")) {
        user.set("currency_type", currency);
        await Users.saveBang(user);
      }
    });

    await logPayoutSettingsUpdateByNonOwner(input, "Compliance country set");
    return { status: 204, body: "", contentType: "application/json", paramsRead: true };
  });
}

// User#requires_credit_card?: a preorder authorization, or a paid purchase on a live subscription (`has_active_subscription`).
async function requiresCreditCard(userId: bigint): Promise<boolean> {
  const preorders = await db.purchase.count({
    where: { purchaser_id: userId, purchase_state: "preorder_authorization_successful" },
  });
  if (preorders > 0) return true;
  const [row] = await db.$queryRaw<{ present: bigint }[]>`SELECT COUNT(*) AS present FROM (
    SELECT 1 FROM purchases INNER JOIN subscriptions ON subscriptions.id = purchases.subscription_id
    WHERE purchases.purchaser_id = ${userId} AND purchases.price_cents != 0 AND purchases.purchase_state != 'test_successful'
      AND subscriptions.failed_at IS NULL AND subscriptions.ended_at IS NULL
      AND (subscriptions.cancelled_at IS NULL OR subscriptions.cancelled_at > ${new Date()}) LIMIT 1) active`;
  return Number(row?.present ?? 0) > 0;
}

// POST /settings/payments/remove_credit_card. User#remove_credit_card only clears `credit_card_id` and runs a full save: the
// card is not touched at the processor.
function removeCreditCard(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, authorizeAs(settingsPaymentsUserPolicy.removeCreditCard), async () => {
    const seller = await findUserBang(sellerOf(input).id);
    const removed =
      !(await requiresCreditCard(seller.get("id"))) && (seller.set("credit_card_id", null), await Users.save(seller));
    if (!removed) return jsonResponse({ error: seller.errors.fullMessages().join(",") }, BAD_REQUEST, true);
    await logPayoutSettingsUpdateByNonOwner(input, "Payout settings updated");
    return { status: 204, body: "", contentType: "application/json", paramsRead: true };
  });
}

// GET /settings/payments/paypal_connect
async function paypalConnect(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, authorizeAs(settingsPaymentsUserPolicy.paypalConnect));
  if (denied) return denied;

  const { merchantIdInPayPal, merchantId } = input.params;
  for (const value of [merchantIdInPayPal, merchantId])
    if (value !== undefined && value !== null && typeof value !== "string")
      throw new HandBackToRails("a PayPal parameter that is not text");

  if (
    isBlank(merchantIdInPayPal as string | undefined) ||
    isBlank(merchantId as string | undefined) ||
    sellerOf(input).external_id !== (merchantId as string).split("-")[0]
  )
    return { status: FOUND, location: CHECKOUT_FORM_PATH, flash: { notice: PAYPAL_ERROR_MESSAGE } };

  throw new HandBackToRails("the linking of a PayPal merchant account, which calls PayPal");
}

// `current_seller.stripe_account`
async function stripeAccountOf(input: MutationInput) {
  const accounts = await aliveStripeAccountsOf(sellerOf(input).id);
  return accounts.find((account) => !isStripeConnectAccount(account)) ?? null;
}

// GET /settings/payments/remediation
async function remediation(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, authorizeAs(settingsPaymentsUserPolicy.remediation));
  if (denied) return denied;

  const account = await stripeAccountOf(input);
  if (account === null) return { status: FOUND, location: PAYMENTS_PATH, flash: { notice: ALL_SET_MESSAGE } };

  const hasRequested =
    (await db.userComplianceInfoRequest.count({ where: { user_id: Number(sellerOf(input).id), state: "requested" } })) >
    0;
  const disabledReason = jsonAttr({ json_data: account.json_data as string | null }, "stripe_disabled_reason") ?? "";
  if (disabledReason.startsWith("rejected.") && !hasRequested) return { status: FOUND, location: PAYMENTS_PATH };

  return remediateStripeAccount(input, account, hasRequested);
}

// GET /settings/payments/verify_stripe_remediation
async function verifyStripeRemediation(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, authorizeAs(settingsPaymentsUserPolicy.verifyStripeRemediation));
  if (denied) return denied;

  const account = await stripeAccountOf(input);
  if (account === null) return { status: FOUND, location: PAYMENTS_PATH };
  return verifyStripeRemediationOf(
    input,
    account,
    async () =>
      (await db.userComplianceInfoRequest.count({
        where: { user_id: Number(sellerOf(input).id), state: "requested" },
      })) > 0,
  );
}

registerMutations(
  { method: "PUT", pattern: PAYMENTS_PATH, run: update },
  { method: "PATCH", pattern: PAYMENTS_PATH, run: update },
  { method: "POST", pattern: `${PAYMENTS_PATH}/set_country`, formats: ["json"], run: setCountry },
  { method: "POST", pattern: `${PAYMENTS_PATH}/remove_credit_card`, formats: ["json"], run: removeCreditCard },
  { method: "GET", pattern: `${PAYMENTS_PATH}/paypal_connect`, skipForgeryProtection: true, run: paypalConnect },
  { method: "GET", pattern: `${PAYMENTS_PATH}/remediation`, skipForgeryProtection: true, run: remediation },
  {
    method: "GET",
    pattern: `${PAYMENTS_PATH}/verify_stripe_remediation`,
    skipForgeryProtection: true,
    run: verifyStripeRemediation,
  },
);
