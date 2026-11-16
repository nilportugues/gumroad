// The compliance and time zone rules the signed-in shared props use, over data dumped from Ruby
// (scripts/dump-signed-in-data.rb).
import { alpha2ByName } from "../../models/compliance-countries.ts";
import DATA from "./signed-in-data.generated.json" with { type: "json" };
import type { ComplianceInfoRow, GuardianRow } from "./reads.ts";

const SUPPORTED_COUNTRIES = new Set<string>(DATA.supported);
const PAYPAL_PAYOUT_RECEIVING = new Set<string>(DATA.paypalPayoutReceiving);
const US_OUTLYING_AREAS = new Set<string>(DATA.usOutlyingAreas);
const NEW_ACCOUNT_CREATION_BLOCKED = new Set<string>(DATA.newAccountCreationBlocked);
const TIME_ZONES: Record<string, string> = DATA.timeZones;

const UAE = "AE";
const GUARDIAN_REQUIRED_BELOW_AGE = 18;
const GUARDIAN_SUPPORTED_COUNTRIES = new Set(["US"]);

// Compliance::Countries.find_by_name(name)&.alpha2
export const countryAlpha2 = alpha2ByName;

const isBusiness = (info: ComplianceInfoRow) => Boolean(info.is_business);

// UserComplianceInfo#legal_entity_country_code
export const legalEntityCountryCode = (info: ComplianceInfoRow): string | null =>
  (isBusiness(info) ? countryAlpha2(info.business_country) : null) ?? countryAlpha2(info.country);

// User#native_payouts_supported? (without a country_code argument)
export function nativePayoutsSupported(info: ComplianceInfoRow | null): boolean {
  if (info === null) return false;
  const code = legalEntityCountryCode(info);
  return code !== null && SUPPORTED_COUNTRIES.has(code) && (code !== UAE || isBusiness(info));
}

// User#no_payout_rail_in_compliance_country?, after its bank account check.
export function noPayoutRailInComplianceCountry(info: ComplianceInfoRow | null): boolean {
  const code = info === null ? null : legalEntityCountryCode(info);
  if (code === null) return false;
  const paypalCountry = US_OUTLYING_AREAS.has(code) ? "US" : code;
  return !nativePayoutsSupported(info) && !PAYPAL_PAYOUT_RECEIVING.has(paypalCountry);
}

export const blockedPayoutCountry = (code: string | null) => code !== null && NEW_ACCOUNT_CREATION_BLOCKED.has(code);

// StripeMerchantAccountManager blocks IND, whose bank accounts are the only ones reporting "IN".
export const INDIAN_BANK_ACCOUNT_TYPE = "IndianBankAccount";

function underLegalGuardianAge(info: ComplianceInfoRow, now: Date): boolean {
  if (!info.birthday) return false;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - GUARDIAN_REQUIRED_BELOW_AGE, now.getUTCMonth(), now.getUTCDate()));
  return info.birthday.getTime() > cutoff.getTime();
}

// UserComplianceInfo#legal_guardian_unsupported?
export function legalGuardianUnsupported(info: ComplianceInfoRow, now = new Date()): boolean {
  const code = countryAlpha2(info.country);
  return underLegalGuardianAge(info, now) && code !== null && !GUARDIAN_SUPPORTED_COUNTRIES.has(code);
}

// UserComplianceInfo#requires_legal_guardian?
export function requiresLegalGuardian(info: ComplianceInfoRow, now = new Date()): boolean {
  const code = countryAlpha2(info.country);
  return underLegalGuardianAge(info, now) && code !== null && GUARDIAN_SUPPORTED_COUNTRIES.has(code);
}

// StripeBeneficialOwnersManager::COUNTRIES_WITH_STATE_LIST
const COUNTRIES_WITH_STATE_LIST = new Set(["US", "CA", "AU", "MX", "AE", "IE", "BR", "JP"]);

// String#present?
const present = (value: string | null): boolean => value !== null && value.trim() !== "";

// Guardian#has_completed_info?. individual_tax_id is a Strongbox attribute, whose blank? looks at
// the stored ciphertext.
export function guardianHasCompletedInfo(guardian: GuardianRow): boolean {
  if (guardian.deleted_at !== null) return false;
  const code = present(guardian.country_code) ? guardian.country_code : countryAlpha2(guardian.country);
  const stateRequired = code !== null && COUNTRIES_WITH_STATE_LIST.has(code);
  const hasTaxId = guardian.individual_tax_id !== null && Buffer.from(guardian.individual_tax_id).toString("latin1").trim() !== "";
  const acceptedTerms = Boolean(guardian.stripe_tos_accepted) && guardian.stripe_tos_accepted_at !== null && present(guardian.stripe_tos_ip);
  return (
    present(guardian.first_name) &&
    present(guardian.last_name) &&
    present(guardian.email) &&
    guardian.date_of_birth !== null &&
    present(guardian.street_address) &&
    present(guardian.city) &&
    (!stateRequired || present(guardian.state)) &&
    present(guardian.zip_code) &&
    present(guardian.country) &&
    hasTaxId &&
    acceptedTerms
  );
}

// UserComplianceInfo#legal_guardian_requirement_met?. `guardian` is the row guardian_id points at.
export function legalGuardianRequirementMet(info: ComplianceInfoRow, guardian: GuardianRow | null, now = new Date()): boolean {
  if (legalGuardianUnsupported(info, now)) return false;
  if (!requiresLegalGuardian(info, now)) return true;
  return guardian !== null && guardianHasCompletedInfo(guardian);
}

// ActiveSupport::TimeZone[name].tzinfo.name
export function tzinfoName(railsZone: string): string | null {
  const identifier = TIME_ZONES[railsZone] ?? railsZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: identifier });
    return identifier;
  } catch {
    return null;
  }
}

// TZInfo::Timezone#utc_offset: the offset in force right now, daylight saving included.
export function observedUtcOffset(identifier: string, now = new Date()): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: identifier, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(part);
  if (!match || !match[1]) return 0;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === "-" ? -seconds : seconds;
}
