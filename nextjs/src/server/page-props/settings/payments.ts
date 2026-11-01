// SettingsPresenter#payments_props (app/presenters/settings_presenter.rb) for Settings::PaymentsController#show.
//
// Constant lists and per-country tables come from payments-data.generated.json
// (scripts/dump-payments-data.rb). What this does not port throws NotPortedError instead of guessing:
//   - a connected Stripe account's active subscriber and preorder check,
//   - instant payouts for a seller who passes the first eligibility checks (account seasoning),
//   - the payout date of a rejected account, a bank sync failure note, a verification error message,

import { Prisma, type BankAccount, type CreditCard, type Guardian, type MerchantAccount, type User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { getConfig } from "../../infra/config.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { geoIpLookup } from "../../infra/geo-ip.ts";
import { formattedDollarAmount, getRate } from "../../models/concerns/currency-helper.ts";
import { alpha2ByName, mapping } from "../../models/compliance-countries.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount, type MerchantAccountRow } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { isStrongboxBlank } from "../../models/strongbox.ts";
import { isSupportedByStripeConnect, stripeConnectRoutingCountryCode, LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE } from "../../models/stripe-connect-routing.ts";
import {
  businessCountryCode,
  countryCode,
  fetchOrBuildComplianceInfo,
  hasTaxId,
  isBusiness,
  jsonAttr,
  legalEntityCountryCode,
  legalEntityName,
  taxIdIsLastFourOnly,
  taxIdLastFour,
  underLegalGuardianAge,
  type ComplianceInfo,
} from "../../models/user-compliance-info.ts";
import { isFlagged, isOnProbation, isSuspended, jsonDataForAttr, payoutsPausedBy, UserFlags, Users, unpaidBalanceCents } from "../../models/user.ts";
import { settingsPaymentsUserPolicy } from "../../policies/settings/payments-user.ts";
import { settingsProfilePolicy } from "../../policies/settings/profile.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { guardianHasCompletedInfo, nativePayoutsSupported, noPayoutRailInComplianceCountry } from "../signed-in/data.ts";
import { NotPortedError } from "../not-ported.ts";
import DATA from "./payments-data.generated.json" with { type: "json" };
import { settingsPages } from "./presenter.ts";


const C = DATA.constants;
const CARD_BANK_ACCOUNT_TYPE = "CardBankAccount";
const ID_DOCUMENT_FIELDS = ["stripe_identity_document_id", "passport", "visa", "stripe_enhanced_identity_verification"];
const TAX_ID_FIELD = "individual_tax_id";
const NATIONALITY_FIELDS = ["nationality", "individual.nationality"];
const PAYOUT_PAUSE_SOURCE = { STRIPE: "stripe", SYSTEM: "system", ADMIN: "admin", USER: "user" } as const;
const SYSTEM_PAUSE_AUTHORS_THAT_PAUSE = ["pause_payouts_after_repeated_failures", "pause_payouts_for_seller_based_on_chargeback_rate"];
const SOCIAL_CONNECT_SURFACE = "account_review";
// Settings::PaymentsController: the individual tax id is asked for in these countries.
const INDIVIDUAL_TAX_ID_NEEDED_COUNTRIES = ["US", "CA", "HK", "SG", "AE", "MX", "BD", "MZ", "UY", "AR", "PE", "CR", "CL", "CO", "GT", "DO", "BO", "KZ", "PY", "PK"];

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const pairsToObject = (pairs: readonly (readonly string[])[]): Record<string, string> => Object.fromEntries(pairs.map(([code, name]) => [code!, name!]));
const codeAndName = (pairs: readonly (readonly string[])[]) => pairs.map(([code, name]) => ({ code, name }));
// ActiveModel::Type::Boolean#cast
const FALSE_VALUES = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);
const castBoolean = (value: unknown): boolean | null => (value === null || value === undefined || value === "" ? null : !FALSE_VALUES.has(value as never));
// Array#to_sentence
function toSentence(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
// String#humanize
const humanize = (value: string) => {
  const spaced = value.replace(/_id$/u, "").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
// Time#strftime("%B %-d, %Y") and ("%B %e, %Y")
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const strftimeLongDate = (date: Date, padDay: boolean) => `${MONTHS[date.getUTCMonth()]} ${padDay ? String(date.getUTCDate()).padStart(2, " ") : date.getUTCDate()}, ${date.getUTCFullYear()}`;

type Seller = User;

type Facts = {
  seller: Seller;
  record: ReturnType<typeof Users.load>;
  info: ComplianceInfo;
  aliveInfo: ComplianceInfo["row"] | null;
  now: Date;
  bankAccount: BankAccount | null;
  stripeAccounts: MerchantAccountRow[];
};

const flag = (seller: Seller, name: Parameters<typeof UserFlags.isSet>[1]) => UserFlags.isSet(seller.flags, name);
const featureActive = (name: string, seller: Seller) => isFeatureEnabled(name, userActor(seller.id));

// User#compliance_country_code
const complianceCountryCode = (facts: Facts) => (facts.aliveInfo ? legalEntityCountryCode(facts.aliveInfo) : null);

// User#payouts_paused? and #payouts_paused_by_source
const payoutsPaused = (seller: Seller) => flag(seller, "payouts_paused_internally") || flag(seller, "payouts_paused_by_user");
function payoutsPausedBySource(facts: Facts): string | null {
  const { seller, record } = facts;
  if (!payoutsPaused(seller)) return null;
  if (flag(seller, "payouts_paused_internally")) {
    const by = payoutsPausedBy(record);
    return by === PAYOUT_PAUSE_SOURCE.STRIPE || by === PAYOUT_PAUSE_SOURCE.SYSTEM ? (by as string) : PAYOUT_PAUSE_SOURCE.ADMIN;
  }
  return PAYOUT_PAUSE_SOURCE.USER;
}

// User#stripe_connect_account and #stripe_account
const stripeConnectAccount = (facts: Facts) => facts.stripeAccounts.find(isStripeConnectAccount) ?? null;
const stripeAccount = (facts: Facts) => facts.stripeAccounts.find((account) => !isStripeConnectAccount(account)) ?? null;

// User#merchant_migration_enabled? and #has_stripe_account_connected?
async function hasStripeAccountConnected(facts: Facts): Promise<boolean> {
  const { seller } = facts;
  let enabled = flag(seller, "check_merchant_account_is_linked");
  if (!enabled && (await featureActive("merchant_migration", seller))) {
    const legalEntityRouting = await featureActive(LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE, seller);
    const routingCountry = facts.aliveInfo ? stripeConnectRoutingCountryCode(facts.aliveInfo, legalEntityRouting) : null;
    enabled = isSupportedByStripeConnect(routingCountry);
  }
  return enabled && stripeConnectAccount(facts) !== null;
}

// Signed up from: the legal entity country of the alive compliance info.
const signedUpFrom = (facts: Facts, code: string) => complianceCountryCode(facts) === code;
const countryPredicates = (code: string | null) => (code === null ? null : ((DATA.countryPredicates as Record<string, { europe: boolean; iban: boolean }>)[code] ?? null));

// User#can_create_bank_payout_rail?
const canCreateBankPayoutRail = (facts: Facts) => (nativePayoutsSupported(facts.aliveInfo) && !signedUpFrom(facts, "IN")) || signedUpFrom(facts, "AE");

// Country#payout_currency and #min_cross_border_payout_amount_usd_cents
const perCountry = (code: string | null) => (code === null ? null : ((DATA.perCountry as Record<string, { payout_currency: string | null; min_cross_border_local_cents: number | null }>)[code] ?? null));
async function minimumPayoutThresholdCents(facts: Facts): Promise<number> {
  const code = facts.aliveInfo ? legalEntityCountryCode(facts.aliveInfo) : null;
  const country = code !== null && code !== "" ? perCountry(code) : null;
  let crossBorder: number | undefined;
  if (country) {
    crossBorder = 0;
    if (country.payout_currency) {
      const rate = Number(await getRate(country.payout_currency));
      crossBorder = Math.round((country.min_cross_border_local_cents ?? 0) / rate);
    }
  }
  return Math.max(C.payoutsMinAmountCents, crossBorder ?? C.payoutsMinAmountCents);
}

// `seller.unpaid_balances.where.not(merchant_account_id: Gumroad's own accounts)`, summed.
async function balanceToForfeitCents(seller: Seller): Promise<bigint> {
  const gumroadAccounts = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "id")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} IN ('stripe', 'paypal', 'braintree')`,
  );
  // Rails takes the first account per processor; a processor with several would change the set.
  const processors = await selectRows<{ charge_processor_id: string; count: bigint }>(
    Prisma.sql`SELECT ${column("merchant_accounts", "charge_processor_id")}, COUNT(*) AS count FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} IN ('stripe', 'paypal', 'braintree') GROUP BY ${column("merchant_accounts", "charge_processor_id")}`,
  );
  if (processors.some((row) => Number(row.count) > 1)) throw new NotPortedError("ForfeitBalanceService with several Gumroad merchant accounts for one processor");
  const ids = gumroadAccounts.map((row) => row.id);
  const exclusion = ids.length === 0 ? Prisma.empty : Prisma.sql`AND ${column("balances", "merchant_account_id")} NOT IN (${Prisma.join(ids)})`;
  const [row] = await selectRows<{ sum: bigint | number | Prisma.Decimal | null }>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) AS sum FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${seller.id} AND ${column("balances", "state")} = 'unpaid' AND ${column("balances", "merchant_account_id")} IS NOT NULL ${exclusion}`,
  );
  return row?.sum == null ? 0n : BigInt(row.sum.toString());
}

// User#formatted_balance_to_forfeit
async function formattedBalanceToForfeit(seller: Seller): Promise<string | null> {
  const cents = await balanceToForfeitCents(seller);
  return cents > 0n ? formattedDollarAmount(cents) : null;
}

const requestsScope = (userId: bigint) => ({ user_id: Number(userId), state: "requested" });
const requestedRequests = (seller: Seller) => db.userComplianceInfoRequest.findMany({ where: requestsScope(seller.id), orderBy: { id: "asc" } });

// SettingsPresenter#stripe_rejected? : MerchantAccount#stripe_rejected?
const accountRejected = (account: MerchantAccountRow | null) => String(account ? (jsonAttrOfAccount(account, "stripe_disabled_reason") ?? "") : "").startsWith("rejected.");
function jsonAttrOfAccount(account: MerchantAccountRow, key: string): string | null {
  return jsonAttr({ json_data: account.json_data as string | null }, key);
}

// Newest alive admin postal-code payout note, current only when it postdates the compliance info.
async function postalCodeRejectedByStripe(facts: Facts): Promise<boolean> {
  const note = await db.comment.findFirst({
    where: {
      commentable_id: facts.seller.id,
      commentable_type: "User",
      comment_type: "payout_note",
      deleted_at: null,
      author_id: BigInt(C.gumroadAdminId),
      content: { startsWith: C.postalCodeFailureNotePrefix },
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });
  if (!note) return false;
  return facts.aliveInfo === null || note.created_at.getTime() >= facts.aliveInfo.created_at.getTime();
}

// SettingsPresenter#current_bank_sync_failure_note: any such note is a banner this does not port.
async function assertNoBankSyncFailureNote(facts: Facts): Promise<void> {
  const { bankAccount, seller } = facts;
  if (!bankAccount) return;
  if (await hasStripeAccountConnected(facts)) return;
  const note = await db.comment.findFirst({
    where: {
      commentable_id: seller.id,
      commentable_type: "User",
      comment_type: "payout_note",
      deleted_at: null,
      author_id: BigInt(C.gumroadAdminId),
      content: { startsWith: C.bankSyncFailureNotePrefix },
    },
  });
  if (note) throw new NotPortedError("The bank sync failure banner (StripeMerchantAccountManager's rejection note classification)");
}

// UserComplianceInfoFieldProperty.name_tag_for_field
const BUSINESS_TAX_ID_NAMES: Record<string, string> = {
  US: "Business EIN",
  AU: "Australian Business Number (ABN)",
  CA: "Business Number (BN)",
  GB: "Company Number (CRN)",
  NO: "Norway VAT ID Number (MVA)",
};
const INDIVIDUAL_TAX_ID_NAMES: Record<string, string> = {
  US: "Social Security Number (SSN)",
  AU: "Australian Business Number (ABN)",
  CA: "Social Insurance Number (SIN)",
  GB: "Unique Taxpayer Reference (UTR)",
  NO: "Norway VAT ID Number (MVA)",
};
const FIELD_NAMES: Record<string, string> = {
  bank_account: "Bank Account",
  bank_account_statement: "Bank Statement",
  birthday: "Date of birth",
  business_name: "Business name",
  business_phone_number: "Business phone number",
  business_street_address: "Address",
  business_vat_id_number: "Business VAT ID Number",
  first_name: "First name",
  last_name: "Last name",
  legal_entity_street_address: "Address",
  memorandum_of_association: "Memorandum of Association",
  proof_of_registration: "Proof of Registration",
  company_registration_verification: "Company Registration",
  passport: "Passport",
  phone_number: "Phone number",
  power_of_attorney: "Power of Attorney",
  street_address: "Personal address",
  stripe_additional_document_id: "An ID or a utility bill with address",
  stripe_enhanced_identity_verification: "Enhanced Identity Verification",
  visa: "Visa",
};
function nameTagForField(field: string, country: string | null): string {
  if (field === "business_tax_id") return BUSINESS_TAX_ID_NAMES[country ?? ""] ?? "Business tax ID";
  if (field === "individual_tax_id") return INDIVIDUAL_TAX_ID_NAMES[country ?? ""] ?? "Individual tax ID";
  if (field === "stripe_company_document_id") return country === "AE" ? "Trade License issued within the UAE" : "Company registration document";
  if (field === "stripe_identity_document_id") return country === "AE" ? "Emirates ID" : "Government-issued photo ID";
  return FIELD_NAMES[field] ?? humanize(field.split(".").at(-1)!);
}

// SettingsPresenter#country_code_for_compliance_field
function countryCodeForComplianceField(field: string, info: ComplianceInfo["row"]): string | null {
  if (field === "business_tax_id" || field === "business_vat_id_number") return businessCountryCode(info);
  if (field === "individual_tax_id") return countryCode(info);
  return legalEntityCountryCode(info);
}

type ComplianceAction = { message: string; href: string | null };

// SettingsPresenter#social_connections_for_review
async function socialConnectionsForReview(facts: Facts, context: SellerContext): Promise<{ provider: string; connected: boolean }[] | null> {
  if (!settingsProfilePolicy.manageSocialConnections(context)) return null;
  const { seller } = facts;
  const connections = [{ provider: "twitter", connected: present(seller.twitter_user_id ?? undefined) }];
  if (await featureActive("youtube_connect", seller)) connections.push({ provider: "youtube", connected: (await db.userYoutubeIdentity.findFirst({ where: { user_id: seller.id } })) !== null });
  if (await featureActive("instagram_connect", seller)) connections.push({ provider: "instagram", connected: (await db.userInstagramIdentity.findFirst({ where: { user_id: seller.id } })) !== null });
  if (await featureActive("tiktok_connect", seller)) connections.push({ provider: "tiktok", connected: (await db.userTiktokIdentity.findFirst({ where: { user_id: seller.id } })) !== null });
  return connections;
}

// SocialConnectFunnel.record_offers!(surface: "account_review", skip: impersonating?): one "offered"
// event per provider that is not connected yet (`once: true`).
async function recordSocialConnectOffers(seller: Seller, connections: { provider: string; connected: boolean }[], now: Date): Promise<void> {
  for (const { provider, connected } of connections) {
    if (connected) continue;
    const eventName = "social_connect_offered";
    const existing = await db.event.findFirst({ where: { user_id: Number(seller.id), event_name: eventName, parent_referrer: provider, view_url: SOCIAL_CONNECT_SURFACE }, select: { id: true } });
    if (existing) continue;
    await db.event.create({ data: { event_name: eventName, user_id: Number(seller.id), parent_referrer: provider, view_url: SOCIAL_CONNECT_SURFACE, created_at: now, updated_at: now } });
  }
}

// SettingsPresenter#account_status_details
async function accountStatusDetails(facts: Facts, context: SellerContext, canUpdate: boolean): Promise<Record<string, unknown>> {
  const { seller } = facts;
  const requested = await requestedRequests(seller);
  const pendingCompliance = requested.length > 0;
  const suspended = isSuspended(facts.record);
  const underReview = isOnProbation(facts.record) || isFlagged(facts.record);
  const pausedInternally = flag(seller, "payouts_paused_internally");
  const pausedByUser = flag(seller, "payouts_paused_by_user");
  const state = seller.user_risk_state;
  const suspensionReason = state === "suspended_for_fraud" ? "Your account has been suspended due to fraudulent activity." : state === "suspended_for_tos_violation" ? "Your account has been suspended for a policy violation." : null;

  const needsIdUpload = requested.some((request) => request.field_needed !== null && ID_DOCUMENT_FIELDS.includes(request.field_needed));
  const account = stripeAccount(facts);
  const stripeRejected = accountRejected(account) && !pendingCompliance;

  let rejectedBalanceStatus: string | null = null;
  let rejectedFormattedBalance: string | null = null;
  const rejectedPayoutDate: string | null = null;
  if (stripeRejected) {
    const balanceCents = await unpaidBalanceCents(facts.record, db);
    if (balanceCents > 0n) rejectedFormattedBalance = formattedDollarAmount(balanceCents);
    if (balanceCents <= 0n) rejectedBalanceStatus = null;
    else if (balanceCents < BigInt(C.rejectedAccountMinAmountCents)) rejectedBalanceStatus = "too_small";
    else if (pausedInternally && payoutsPausedBySource(facts) === PAYOUT_PAUSE_SOURCE.STRIPE) rejectedBalanceStatus = "stripe_hold";
    else if (payoutsPaused(seller)) rejectedBalanceStatus = "held";
    else rejectedBalanceStatus = "auto_payout";
    if (rejectedBalanceStatus === "auto_payout") throw new NotPortedError("User#next_payout_date (the payout date shown for a rejected account)");
  }

  const pausedByStripe = pausedInternally && payoutsPausedBySource(facts) === PAYOUT_PAUSE_SOURCE.STRIPE;
  const complianceActions: ComplianceAction[] = [];
  if ((pendingCompliance || pausedByStripe) && account !== null && !stripeRejected && canUpdate) {
    complianceActions.push({ message: "Complete pending verification requirements via Stripe", href: "/settings/payments/remediation" });
  }
  if (pendingCompliance && account === null) {
    const missing: string[] = [];
    for (const request of requested) {
      if (jsonAttr({ json_data: request.json_data }, "verification_error") !== null) throw new NotPortedError("UserComplianceInfoRequest#verification_error_message");
      missing.push(nameTagForField(request.field_needed ?? "", countryCodeForComplianceField(request.field_needed ?? "", facts.info.row)));
    }
    const unique = [...new Set(missing)];
    if (unique.length > 0) complianceActions.push({ message: `Please provide: ${toSentence(unique)}.`, href: null });
  }

  if (account === null && (await postalCodeRejectedByStripe(facts))) {
    const country = facts.aliveInfo ? (isBusiness(facts.aliveInfo) ? (facts.aliveInfo.business_country ?? facts.aliveInfo.country) : facts.aliveInfo.country) : undefined;
    complianceActions.push({
      message: `Our payment partner couldn't verify the postal code you entered${present(country ?? undefined) ? ` for ${country}` : ""}. Please double-check it and re-save your address. If you're sure it's correct (for example, a newly built address), you don't need to do anything — we'll automatically re-check it once a week for up to ${C.retryWindowWeeks} weeks.`,
      href: null,
    });
  }

  if (!stripeRejected) await assertNoBankSyncFailureNote(facts);

  const gumroadStatus = underReview && !suspended ? "Your account is under review and payouts are on hold until it's resolved." : null;
  const showSection = suspended || underReview || pausedInternally || pausedByUser || complianceActions.length > 0 || stripeRejected;

  let socialConnections: unknown[] | null = null;
  if (underReview && !suspended) {
    socialConnections = await socialConnectionsForReview(facts, context);
  }

  return {
    show_section: showSection,
    is_suspended: suspended,
    suspension_reason: suspensionReason,
    compliance_actions: complianceActions,
    needs_id_upload: needsIdUpload,
    gumroad_status: gumroadStatus,
    social_connections_for_review: socialConnections,
    stripe_rejected: stripeRejected,
    stripe_rejected_balance_status: rejectedBalanceStatus,
    stripe_rejected_formatted_balance: rejectedFormattedBalance,
    stripe_rejected_payout_date: rejectedPayoutDate,
  };
}

// User#credit_creation_date: [(Time.now.utc.to_date + 1.month).beginning_of_month, Date.new(2023, 7, 1)].max
export function creditCreationDate(now: Date): string {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const floor = new Date(Date.UTC(2023, 6, 1));
  return strftimeLongDate(nextMonth > floor ? nextMonth : floor, false);
}

// Date.today.year - UserComplianceInfo::MINIMUM_DATE_OF_BIRTH_AGE (the process's time zone)
export const minDobYear = (now: Date): number => now.getFullYear() - C.minimumDateOfBirthAge;

// SettingsPresenter#aus_backtax_details
async function ausBacktaxDetails(facts: Facts, now: Date) {
  const { record, seller } = facts;
  const owed = Number(jsonDataForAttr(record, "au_backtax_owed_cents", 0));
  const sales = Number(jsonDataForAttr(record, "au_backtax_sales_cents", 0));
  const agreement = await db.backtaxAgreement.findFirst({ where: { user_id: seller.id, jurisdiction: "AUSTRALIA" }, orderBy: { id: "asc" } });
  const credit = agreement ? await db.credit.findFirst({ where: { backtax_agreement_id: agreement.id }, orderBy: { id: "asc" } }) : null;
  const emailInfo = owed >= C.minAuBacktaxOwedCentsForContact ? await db.australiaBacktaxEmailInfo.findFirst({ where: { user_id: seller.id } }) : null;
  return {
    show_au_backtax_prompt: owed >= C.minAuBacktaxOwedCentsForContact && emailInfo !== null,
    total_amount_to_au: formattedDollarAmount(sales, { noCentsIfWhole: false }),
    au_backtax_amount: formattedDollarAmount(owed, { noCentsIfWhole: false }),
    opt_in_date: agreement ? strftimeLongDate(agreement.created_at, true) : null,
    credit_creation_date: creditCreationDate(now),
    opted_in_to_au_backtax: agreement !== null,
    legal_entity_name: legalEntityName(facts.info.row),
    are_au_backtaxes_paid: credit !== null,
    au_backtaxes_paid_date: credit ? strftimeLongDate(credit.created_at, false) : null,
  };
}

// SettingsPresenter#stripe_connect
async function stripeConnectProps(facts: Facts) {
  const connect = stripeConnectAccount(facts);
  const connected = await hasStripeAccountConnected(facts);
  // User#stripe_disconnect_allowed? asks whether subscriptions or preorders still run on the account.
  if (connected) throw new NotPortedError("User#stripe_disconnect_allowed? (active subscribers and preorders on a connected Stripe account)");
  return {
    has_connected_stripe: connect !== null,
    stripe_connect_account_id: connect ? String(connect.charge_processor_merchant_id) : null,
    stripe_connect_routing_active: connected,
    // connect.blank? => false; otherwise has_stripe_account_connected? || Feature.inactive?(...)
    blocks_managed_account: connect === null ? false : connected || !(await featureActive("managed_stripe_account_beside_inactive_connect", facts.seller)),
    stripe_disconnect_allowed: true,
    supported_countries_help_text:
      "This feature is available in <a href='https://stripe.com/en-in/global'>all countries where Stripe operates</a>, except India, Indonesia, Malaysia, Mexico, Philippines, and Thailand.",
  };
}

// BankAccount#routing_number for the class in the `type` column.
function routingNumber(bank: BankAccount): string | null {
  const templates = (DATA.bankAccountRouting as Record<string, Record<string, string | null | { unsupported: unknown }>>)[bank.type ?? "AchAccount"];
  if (!templates) throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  const key = `${bank.bank_number === null ? "-" : "bn"}${bank.branch_code === null ? "-" : "br"}`;
  const template = templates[key];
  if (template === undefined || (template !== null && typeof template === "object")) throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  return template === null ? null : template.replace("{bank_number}", bank.bank_number ?? "").replace("{branch_code}", bank.branch_code ?? "");
}

// CreditCard#expiry_visual
const expiryVisual = (card: CreditCard) =>
  card.expiry_month === null || card.expiry_year === null ? null : `${String(card.expiry_month).padStart(2, "0")}/${String(card.expiry_year).slice(-2)}`;

// CreditCard#requires_mandate?
function requiresMandate(card: CreditCard): boolean {
  const upi = card.payment_method_type === "upi" || card.card_type === "upi";
  return !upi && card.card_country === "IN";
}

// CheckoutPresenter.saved_card
const savedCard = (card: CreditCard | null) =>
  card && card.card_type !== "paypal" ? { type: card.card_type, number: card.visual, expiration_date: expiryVisual(card), requires_mandate: requiresMandate(card) } : null;

// SettingsPresenter#bank_account_details
async function bankAccountDetails(facts: Facts) {
  const { bankAccount: bank, seller } = facts;
  const isCard = bank?.type === CARD_BANK_ACCOUNT_TYPE;
  const canCreateRail = canCreateBankPayoutRail(facts);
  const code = complianceCountryCode(facts);
  const paypalAllowed =
    present(seller.payment_address ?? undefined) ||
    present(jsonDataForAttr(facts.record, "invalidated_paypal_payout_address") as string | null) ||
    !nativePayoutsSupported(facts.aliveInfo) ||
    code === "AE" ||
    code === "EG" ||
    code === "KZ" ||
    code === "IN";
  let card: unknown = null;
  if (isCard) {
    const creditCard = bank!.credit_card_id === null ? null : await db.creditCard.findUnique({ where: { id: bank!.credit_card_id } });
    if (!creditCard) throw new TypeError("undefined method 'card_type' for nil");
    card = { type: (creditCard.card_type ?? "").charAt(0).toUpperCase() + (creditCard.card_type ?? "").slice(1).toLowerCase(), number: creditCard.visual, expiration_date: expiryVisual(creditCard), requires_mandate: false };
    // CardBankAccount#routing_number is the capitalized card type, but the page shows the card.
    card = { ...(card as object), type: creditCard.card_type };
  }
  const regular = bank !== null && !isCard;
  return {
    show_bank_account: bank !== null || canCreateRail,
    show_paypal: paypalAllowed,
    card_data_handling_mode: C.cardDataHandlingMode,
    is_a_card: isCard,
    card,
    routing_number: regular ? routingNumber(bank) : null,
    account_number_visual: regular ? `******${bank.account_number_last_four ?? ""}` : null,
    bank_account: regular ? { account_holder_full_name: bank.account_holder_full_name } : null,
  };
}

// FeeInfoPresenter
async function feeInfo(facts: Facts) {
  const countryCodeOfInfo = countryCode(facts.info.row);
  const percent = (perThousand: number) => {
    const rounded = Math.round((perThousand / 10) * 10) / 10;
    return Number.isInteger(rounded) ? Math.trunc(rounded) : rounded;
  };
  const gumroadFee = `${percent(await gumroadFeePerThousand(facts))}% + ${C.gumroadFixedFeeCents}¢`;
  const discoverFee = `${percent(C.gumroadDiscoverFeePerThousand)}%`;
  const summary = "Your fees depend on how buyers find your product:";
  const breakdown = (direct: string, discover: string) => ({ summary, items: [{ label: "Direct sales", value: direct }, { label: "Discover sales", value: discover }] });
  const processorFee = `${percent(C.processorFeePerThousand)}% + ${C.processorFixedFeeCents}¢ processing fee`;
  return {
    merchant_account_fee_info: breakdown(`${gumroadFee} Gumroad fee + ${processorFee}`, `${discoverFee}, processing fee included`),
    connect_account_fee_info:
      countryCodeOfInfo === "BR" ? { summary: "You pay a 0% Gumroad fee on all sales.", items: [] } : breakdown(`${gumroadFee} Gumroad fee`, `${discoverFee} Gumroad fee`),
  };
}

// User#gumroad_fee_per_thousand
async function gumroadFeePerThousand(facts: Facts): Promise<number> {
  const custom = jsonDataForAttr(facts.record, "custom_fee_per_thousand");
  if (custom !== null && custom !== undefined && custom !== "") return Number(custom);
  if (await featureActive("high_volume_seller_fee", facts.seller)) {
    const month = jsonDataForAttr(facts.record, "high_volume_fee_month");
    const now = facts.now;
    if (month === `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`) return C.highVolumeFeePerThousand;
  }
  return C.gumroadFlatFeePerThousand;
}

// User#requires_credit_card?
async function requiresCreditCard(seller: Seller, now: Date): Promise<boolean> {
  const preorders = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${seller.id} AND ${column("purchases", "purchase_state")} = 'preorder_authorization_successful' LIMIT 1`,
  );
  if (preorders.length > 0) return true;
  const subscriptions = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("purchases")} INNER JOIN ${table("subscriptions")} ON ${column("subscriptions", "id")} = ${column("purchases", "subscription_id")} WHERE ${column("purchases", "purchaser_id")} = ${seller.id} AND ${column("purchases", "price_cents")} != 0 AND ${column("purchases", "purchase_state")} != 'test_successful' AND ${column("subscriptions", "failed_at")} IS NULL AND ${column("subscriptions", "ended_at")} IS NULL AND (${column("subscriptions", "cancelled_at")} IS NULL OR ${column("subscriptions", "cancelled_at")} > ${now}) LIMIT 1`,
  );
  return subscriptions.length > 0;
}

// User#charge_paypal_payout_fee?
async function chargePaypalPayoutFee(facts: Facts): Promise<boolean> {
  const code = facts.aliveInfo ? legalEntityCountryCode(facts.aliveInfo) : null;
  return (await featureActive("paypal_payout_fee", facts.seller)) && !flag(facts.seller, "paypal_payout_fee_waived") && !(C.paypalPayoutFeeExempt as string[]).includes(code ?? "");
}

// SettingsPresenter#user_details
async function userDetails(facts: Facts) {
  const { seller, info, aliveInfo } = facts;
  const row = info.row;
  const code = complianceCountryCode(facts);
  const predicates = countryPredicates(code);
  const requested = await requestedRequests(seller);
  // has_outstanding_full_ssn_requirement?: requested individual tax id requests not marked partial.
  const outstandingFullSsn = requested.some((request) => request.field_needed === TAX_ID_FIELD && (request.flags & 1) === 0);
  const outstandingNationality = requested.some((request) => request.field_needed !== null && NATIONALITY_FIELDS.includes(request.field_needed));
  const hasBank = facts.bankAccount !== null;
  return {
    country_supports_native_payouts: nativePayoutsSupported(aliveInfo),
    no_payout_rail_in_country: !hasBank && noPayoutRailInComplianceCountry(aliveInfo),
    country_supports_iban: predicates?.iban ?? false,
    need_full_ssn: outstandingFullSsn,
    country_code: legalEntityCountryCode(row),
    payout_currency: perCountry(legalEntityCountryCode(row))?.payout_currency ?? null,
    is_from_europe: predicates?.europe ?? false,
    individual_tax_id_needed_countries: INDIVIDUAL_TAX_ID_NEEDED_COUNTRIES,
    individual_tax_id_entered: hasTaxId(row.individual_tax_id),
    individual_tax_id_last_four: taxIdLastFour(row.individual_tax_id),
    individual_tax_id_is_last_four: taxIdIsLastFourOnly(row.individual_tax_id),
    has_outstanding_full_ssn_requirement: outstandingFullSsn,
    has_outstanding_nationality_requirement: outstandingNationality,
    business_tax_id_entered: hasTaxId(row.business_tax_id),
    business_tax_id_last_four: taxIdLastFour(row.business_tax_id),
    requires_credit_card: await requiresCreditCard(seller, facts.now),
    is_charged_paypal_payout_fee: await chargePaypalPayoutFee(facts),
    joined_at: seller.created_at!.toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
}

// SettingsPresenter#compliance_info_details
function complianceInfoDetails(info: ComplianceInfo["row"]) {
  const attr = (key: string) => jsonAttr(info, key);
  const birthday = info.birthday;
  return {
    is_business: isBusiness(info),
    business_name: info.business_name,
    business_name_kanji: attr("business_name_kanji"),
    business_name_kana: attr("business_name_kana"),
    business_type: info.business_type,
    business_street_address: info.business_street_address,
    business_building_number: attr("business_building_number"),
    business_building_number_kana: attr("business_building_number_kana"),
    business_street_address_kanji: attr("business_street_address_kanji"),
    business_street_address_kana: attr("business_street_address_kana"),
    business_city: info.business_city,
    business_city_kana: attr("business_city_kana"),
    business_state: info.business_state,
    business_country: businessCountryCode(info) ?? countryCode(info),
    business_zip_code: info.business_zip_code,
    business_phone: attr("business_phone"),
    job_title: attr("job_title"),
    first_name: info.first_name,
    last_name: info.last_name,
    first_name_kanji: attr("first_name_kanji"),
    last_name_kanji: attr("last_name_kanji"),
    first_name_kana: attr("first_name_kana"),
    last_name_kana: attr("last_name_kana"),
    street_address: info.street_address,
    building_number: attr("building_number"),
    building_number_kana: attr("building_number_kana"),
    street_address_kanji: attr("street_address_kanji"),
    street_address_kana: attr("street_address_kana"),
    city: info.city,
    city_kana: attr("city_kana"),
    state: info.state,
    country: countryCode(info),
    zip_code: info.zip_code,
    phone: attr("phone"),
    nationality: attr("nationality"),
    dob_month: birthday ? birthday.getUTCMonth() + 1 : 0,
    dob_day: birthday ? birthday.getUTCDate() : 0,
    dob_year: birthday ? birthday.getUTCFullYear() : 0,
  };
}

// GuardianPresenter#props
const guardianProps = (guardian: Guardian) => ({
  id: externalId(guardian.id),
  first_name: guardian.first_name,
  last_name: guardian.last_name,
  email: guardian.email,
  phone: guardian.phone,
  date_of_birth: guardian.date_of_birth ? guardian.date_of_birth.toISOString().slice(0, 10) : null,
  street_address: guardian.street_address,
  city: guardian.city,
  state: guardian.state,
  zip_code: guardian.zip_code,
  country: guardian.country,
  nationality: guardian.nationality,
  has_individual_tax_id: !isStrongboxBlank(guardian.individual_tax_id),
  accepted_terms: guardian.stripe_tos_accepted && guardian.stripe_tos_accepted_at !== null && present(guardian.stripe_tos_ip ?? undefined),
  has_completed_info: guardianHasCompletedInfo(guardian),
});

// SettingsPresenter#legal_guardian_details
async function legalGuardianDetails(facts: Facts) {
  const row = facts.info.row;
  const guardian = row.guardian_id === null ? null : await db.guardian.findUnique({ where: { id: row.guardian_id } });
  // StripePayoutProcessor.pays_user_via_stripe_connect?: a connected account that is not Brazilian.
  const connect = stripeConnectAccount(facts);
  if ((await hasStripeAccountConnected(facts)) && connect && connect.country !== "BR") {
    return { required: false, unsupported: false, blocking_payouts: false, guardian: null };
  }
  const supported = C.guardianSupportedCountryCodes as string[];
  const underAge = underLegalGuardianAge(row, C.guardianRequiredBelowAge, facts.now);
  const code = countryCode(row);
  const required = underAge && supported.includes(code ?? "");
  const unsupported = underAge && present(code ?? undefined) && !supported.includes(code ?? "");
  const requirementMet = unsupported ? false : required ? guardian !== null && guardianHasCompletedInfo(guardian) : true;
  return {
    required,
    unsupported,
    blocking_payouts: !requirementMet,
    guardian: guardian && guardian.deleted_at === null ? guardianProps(guardian) : null,
  };
}


// User#instant_payouts_supported?: false unless the first eligibility checks hold.
async function instantPayoutsSupported(facts: Facts): Promise<boolean> {
  const { seller } = facts;
  const compliant = seller.user_risk_state === "compliant";
  if (!compliant || payoutsPaused(seller) || legalEntityCountryCodeOf(facts) !== "US") return false;
  const completed = await db.payment.findFirst({ where: { user_id: Number(seller.id), state: "completed" }, select: { id: true } });
  if (!completed) return false;
  throw new NotPortedError("User#instant_payouts_supported? (stripe_accounts_seasoned_for_instant_payouts?)");
}
const legalEntityCountryCodeOf = (facts: Facts) => facts.aliveInfo && legalEntityCountryCode(facts.aliveInfo);

export async function paymentsProps(context: SellerContext, { impersonating, remoteIp, now = new Date() }: { impersonating: boolean; remoteIp: string | null; now?: Date }) {
  const seller = context.seller!;
  const info = await fetchOrBuildComplianceInfo(seller.id);
  const bankAccount = await db.bankAccount.findFirst({ where: { user_id: Number(seller.id), deleted_at: null }, orderBy: { id: "asc" } });
  const stripeAccounts = await aliveStripeAccountsOf(seller.id);
  const facts: Facts = { seller, record: Users.load(seller), info, aliveInfo: info.persisted ? info.row : null, now, bankAccount, stripeAccounts };
  const canUpdate = settingsPaymentsUserPolicy.update(context, seller);
  const creditCard = seller.credit_card_id === null ? null : await db.creditCard.findUnique({ where: { id: Number(seller.credit_card_id) } });
  const minimumThreshold = await minimumPayoutThresholdCents(facts);
  const legalEntityCode = facts.aliveInfo ? legalEntityCountryCode(facts.aliveInfo) : null;
  const storedThreshold = jsonDataForAttr(facts.record, "payout_threshold_cents", minimumThreshold);

  const props = {
    settings_pages: await settingsPages(context),
    is_form_disabled: !canUpdate,
    should_show_country_modal: !present(info.row.country ?? undefined) && settingsPaymentsUserPolicy.setCountry(context, seller),
    aus_backtax_details: await ausBacktaxDetails(facts, now),
    stripe_connect: await stripeConnectProps(facts),
    countries: pairsToObject(DATA.countries),
    // People's addresses and nationalities are not compliance countries, so they keep the full list.
    person_countries: pairsToObject(DATA.personCountries),
    representative_countries: pairsToObject(DATA.representativeCountries),
    ip_country_code: geoIpLookup(remoteIp)?.countryCode ?? null,
    bank_account_details: await bankAccountDetails(facts),
    paypal_address: seller.payment_address,
    fee_info: await feeInfo(facts),
    user: await userDetails(facts),
    compliance_info: complianceInfoDetails(info.row),
    min_dob_year: minDobYear(now),
    us_business_types: codeAndName(DATA.businessTypes.us),
    uae_business_types: codeAndName(DATA.businessTypes.uae),
    india_business_types: codeAndName(DATA.businessTypes.india),
    canada_business_types: codeAndName(DATA.businessTypes.canada),
    states: {
      us: DATA.states.us,
      ca: DATA.states.ca,
      au: DATA.states.au,
      mx: DATA.states.mx,
      ae: DATA.states.ae,
      ir: DATA.states.ir,
      br: DATA.states.br,
      jp: DATA.states.jp,
    },
    saved_card: savedCard(creditCard),
    formatted_balance_to_forfeit_on_country_change: await formattedBalanceToForfeit(seller),
    formatted_balance_to_forfeit_on_payout_method_change: await formattedBalanceToForfeit(seller),
    paypal_switch_loses_bank_rail: bankAccount !== null && bankAccount.type !== CARD_BANK_ACCOUNT_TYPE && !canCreateBankPayoutRail(facts),
    payouts_paused_internally: flag(seller, "payouts_paused_internally"),
    payout_reserve_available: await chargebackRatePayoutReserveAvailable(facts),
    payouts_paused_by: payoutsPausedBySource(facts),
    payout_reserve_percent: !flag(seller, "payouts_paused_by_user") && (await chargebackRatePayoutReserveAvailable(facts)) ? C.chargebackRatePayoutReservePercent : null,
    account_status: await accountStatusDetails(facts, context, canUpdate),
    payouts_paused_by_user: flag(seller, "payouts_paused_by_user"),
    payout_threshold_cents: storedThreshold,
    minimum_payout_threshold_cents: minimumThreshold,
    payout_country_name: legalEntityCode === null ? null : (mapping().find(([alpha2]) => alpha2 === legalEntityCode)?.[1] ?? null),
    payout_frequency: jsonDataForAttr(facts.record, "payout_frequency", "weekly"),
    payout_frequency_daily_supported: await instantPayoutsSupported(facts),
    instant_payout_fee_percent: C.instantPayoutFeePercent,
    buyer_local_currency_enabled: await featureActive("buyer_local_currency", seller),
    disable_buyer_local_currency: castBoolean(jsonDataForAttr(facts.record, "disable_buyer_local_currency", false)),
    buyer_currency_charging_enabled: await featureActive("buyer_currency_charging", seller),
    disable_buyer_currency_rounding: castBoolean(jsonDataForAttr(facts.record, "disable_buyer_currency_rounding", false)),
    can_manage_beneficial_owners: canUpdate && stripeAccountEligibleForBeneficialOwners(facts),
    legal_guardian: await legalGuardianDetails(facts),
  };
  // Settings::PaymentsController#show: record the offers the account review section shows.
  const offers = props.account_status.social_connections_for_review as { provider: string; connected: boolean }[] | null;
  if (offers && !impersonating) await recordSocialConnectOffers(seller, offers, now);
  return props;
}

// StripeBeneficialOwnersManager.eligible?
function stripeAccountEligibleForBeneficialOwners(facts: Facts): boolean {
  const account = stripeAccount(facts);
  if (account === null) return false;
  return facts.aliveInfo !== null && isBusiness(facts.aliveInfo);
}

// User#chargeback_rate_payout_reserve_available?
async function chargebackRatePayoutReserveAvailable(facts: Facts): Promise<boolean> {
  const { seller } = facts;
  if (await isFeatureEnabled("disable_chargeback_rate_payout_reserve")) return false;
  if (seller.deleted_at !== null) return false;
  if (!flag(seller, "payouts_paused_internally") || payoutsPausedBySource(facts) !== PAYOUT_PAUSE_SOURCE.SYSTEM) return false;
  const latest = await db.comment.findFirst({
    where: { commentable_id: seller.id, commentable_type: "User", comment_type: "on", author_name: { in: SYSTEM_PAUSE_AUTHORS_THAT_PAUSE } },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });
  return latest?.author_name === "pause_payouts_for_seller_based_on_chargeback_rate";
}

export type { Seller, MerchantAccount };
