// The payloads StripeMerchantAccountManager sends when it creates or updates a Stripe account: `account_hash`, `person_hash`,
// `company_hash` and `bank_account_hash`. Pure: rows in, the Stripe parameter hash out, with Ruby's key order (the order is what
// Stripe's form encoding sends). Nothing here reads the database, decrypts anything or calls Stripe; the caller passes the
// Strongbox plaintexts. A bank account of a type whose Stripe accessors are not ported throws NotPortedError, so a caller hands
// back before it writes anything.
// Golden: models/__fixtures__/stripe-account-payloads.golden.json (scripts/golden/stripe-account-payloads.rb).
import type { BankAccount, UserComplianceInfo } from "@prisma/client";

import { alpha2ByName, isBlank } from "./compliance-countries.ts";
import DATA from "./stripe-account-payload-data.generated.json" with { type: "json" };
import { jsonAttr } from "./user-compliance-info.ts";
import { NotPortedError } from "./user.ts";

// An interface, because a recursive Record alias is circular.
export interface StripeParams {
  [key: string]: string | number | boolean | null | StripeParams;
}

export type ComplianceRow = Pick<
  UserComplianceInfo,
  | "country"
  | "state"
  | "city"
  | "street_address"
  | "zip_code"
  | "first_name"
  | "last_name"
  | "birthday"
  | "is_business"
  | "business_name"
  | "business_street_address"
  | "business_city"
  | "business_state"
  | "business_zip_code"
  | "business_country"
  | "business_type"
  | "json_data"
>;

const USA = "US";
const CAN = "CA";
const ARE = "AE";
const JPN = "JP";
const IND = "IN";
const GIB = "GI";
const CHL = "CL";
const COL = "CO";
const LUX = "LU";
const NLD = "NL";
const ACCOUNT_HOLDER_NAME_SYNC_COUNTRIES = [JPN, "VN", "ID"];
const ECUADOR = "EC";
const SOLE_PROPRIETORSHIP = "sole_proprietorship";
const PERSON_TAX_ID_LAST_FOUR = 4;
const US_NATIONAL_ID_LENGTH = 9;

// UserComplianceInfo::BusinessTypes mapped by StripeMerchantAccountManager::US_COMPANY_STRUCTURES
const US_COMPANY_STRUCTURES: Record<string, string> = {
  sole_proprietorship: "sole_proprietorship",
  single_member_llc: "single_member_llc",
  multi_member_llc: "multi_member_llc",
  corporation: "private_corporation",
  partnership: "private_partnership",
};

const CROSS_BORDER_PAYOUTS_COUNTRIES = new Set<string>(DATA.cross_border_payouts_alpha2);
const JAPAN_PREFECTURE_KANA = new Map(Object.entries(DATA.japan_prefecture_kana));

// Country#supports_stripe_cross_border_payouts?
const supportsCrossBorderPayouts = (alpha2: string | null): boolean =>
  alpha2 !== null && CROSS_BORDER_PAYOUTS_COUNTRIES.has(alpha2);

// String#strip: ASCII whitespace and NUL at both ends, not the Unicode spaces `\s` would take.
const RUBY_STRIP = /^[\t\n\v\f\r \0]+|[\t\n\v\f\r \0]+$/gu;
const rubyStrip = (value: string): string => value.replace(RUBY_STRIP, "");

// Hash#deep_values_strip!
function deepValuesStrip(hash: StripeParams): StripeParams {
  for (const [key, value] of Object.entries(hash)) {
    if (typeof value === "string") hash[key] = rubyStrip(value);
    else if (value !== null && typeof value === "object") deepValuesStrip(value);
  }
  return hash;
}

// Hash#deep_merge!: nested hashes merge, anything else replaces; a new key goes last.
function deepMerge(target: StripeParams, source: StripeParams): StripeParams {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (value !== null && typeof value === "object" && current !== null && typeof current === "object")
      deepMerge(current, value);
    else target[key] = value;
  }
  return target;
}

// `value.presence`
const presence = (value: string | null | undefined): string | null => (value == null || isBlank(value) ? null : value);

// UserComplianceInfo#country_code, #business_country_code and #legal_entity_country_code
const countryCodeOf = (row: ComplianceRow): string | null => alpha2ByName(row.country);
const legalEntityCountryCodeOf = (row: ComplianceRow): string | null =>
  (row.is_business === true ? alpha2ByName(row.business_country) : null) ?? countryCodeOf(row);

// UserComplianceInfo#legal_entity_name: `"#{first_name} #{last_name}".squeeze(" ").strip` or the business name
function legalEntityNameOf(row: ComplianceRow): string | null {
  if (row.is_business === true) return row.business_name;
  return rubyStrip(`${row.first_name ?? ""} ${row.last_name ?? ""}`.replace(/ {2,}/gu, " "));
}

// StripeMerchantAccountManager.normalize_postal_code
function normalizePostalCode(postalCode: string | null, countryCode: string | null): string | null {
  if (postalCode === null || isBlank(postalCode)) return postalCode;
  const stripped = rubyStrip(postalCode);
  if (countryCode === LUX) {
    const match = /^L[-\t\n\v\f\r ]?(\d{4})$/iu.exec(stripped);
    if (match?.[1]) return match[1];
  } else if (countryCode === NLD) {
    const match = /^(\d{4})[\t\n\v\f\r ]?([A-Za-z]{2})$/u.exec(stripped);
    if (match) return `${match[1]} ${match[2]!.toUpperCase()}`;
  }
  return postalCode;
}

// Compliance::Countries.japan_prefecture_kana
const prefectureKana = (kanji: string | null): string | null =>
  kanji === null ? null : (JAPAN_PREFECTURE_KANA.get(kanji) ?? null);

const attr = (row: ComplianceRow, key: string): string | null => jsonAttr(row, key);

// A birthday is a DATE column: the day, month and year Ruby reads off the Date.
const birthdayPart = (row: ComplianceRow, part: "day" | "month" | "year"): number | null => {
  if (!row.birthday) return null;
  if (part === "day") return row.birthday.getUTCDate();
  if (part === "month") return row.birthday.getUTCMonth() + 1;
  return row.birthday.getUTCFullYear();
};

// StripeMerchantAccountManager.person_hash, with `individual_tax_id.decrypt(passphrase)` passed in.
export function personHash(row: ComplianceRow, email: string, individualTaxId: string): StripeParams {
  const countryCode = countryCodeOf(row);
  const hash: StripeParams = {
    first_name: row.first_name,
    last_name: row.last_name,
    email,
    phone: attr(row, "phone"),
    dob: { day: birthdayPart(row, "day"), month: birthdayPart(row, "month"), year: birthdayPart(row, "year") },
  };

  if (countryCode === JPN) {
    const addressKanji: StripeParams = {
      line1: attr(row, "building_number"),
      town: attr(row, "street_address_kanji"),
      state: row.state,
      country: "JP",
      postal_code: row.zip_code,
    };
    const addressKana: StripeParams = {
      line1: attr(row, "building_number_kana"),
      town: attr(row, "street_address_kana"),
      state: prefectureKana(row.state),
      country: "JP",
      postal_code: row.zip_code,
    };
    // Stripe rejects an explicit null city, so the key exists only when the seller gave one.
    if (!isBlank(row.city)) addressKanji.city = row.city;
    if (!isBlank(attr(row, "city_kana"))) addressKana.city = attr(row, "city_kana");
    deepMerge(hash, {
      first_name_kanji: attr(row, "first_name_kanji"),
      last_name_kanji: attr(row, "last_name_kanji"),
      first_name_kana: attr(row, "first_name_kana"),
      last_name_kana: attr(row, "last_name_kana"),
      address_kanji: addressKanji,
      address_kana: addressKana,
    });
  } else {
    deepMerge(hash, {
      address: {
        line1: row.street_address,
        line2: null,
        city: row.city,
        state: row.state,
        postal_code: normalizePostalCode(row.zip_code, countryCode),
        country: countryCode,
      },
    });
  }

  // Stripe validates the id against the account country: a foreign national id on a US account is omitted.
  if (!isBlank(individualTaxId)) {
    const length = Array.from(individualTaxId).length;
    if (legalEntityCountryCodeOf(row) === USA) {
      if (countryCode === USA && length === PERSON_TAX_ID_LAST_FOUR) deepMerge(hash, { ssn_last_4: individualTaxId });
      else if (length === US_NATIONAL_ID_LENGTH) deepMerge(hash, { id_number: individualTaxId });
    } else {
      deepMerge(hash, { id_number: individualTaxId });
    }
  }

  const nationality = attr(row, "nationality");
  if (nationality !== null) deepMerge(hash, { nationality });

  return deepValuesStrip(hash);
}

// StripeMerchantAccountManager.company_tax_id_accepted?
function companyTaxIdAccepted(row: ComplianceRow): boolean {
  if (legalEntityCountryCodeOf(row) !== IND) return true;
  return row.business_type !== SOLE_PROPRIETORSHIP;
}

// StripeMerchantAccountManager.company_hash, with `business_tax_id.decrypt(passphrase)` passed in.
export function companyHash(row: ComplianceRow, businessTaxId: string): StripeParams {
  const legalEntityCountry = legalEntityCountryCodeOf(row);
  const residence = countryCodeOf(row);
  const company: StripeParams = {
    name: presence(row.business_name),
    address: {
      line1: row.is_business === true ? row.business_street_address : row.street_address,
      line2: null,
      city: row.is_business === true ? row.business_city : row.city,
      state: row.is_business === true ? row.business_state : row.state,
      postal_code: normalizePostalCode(
        row.is_business === true ? row.business_zip_code : row.zip_code,
        legalEntityCountry,
      ),
      country: legalEntityCountry,
    },
    tax_id: presence(businessTaxId),
    phone: attr(row, "business_phone"),
    directors_provided: true,
    executives_provided: true,
  };
  const hash: StripeParams = { company };

  if (!companyTaxIdAccepted(row)) delete company.tax_id;

  // The kanji and kana blocks carry a hardcoded country, so they follow the account-country rule too.
  if (residence === JPN && legalEntityCountry === JPN) {
    const addressKanji: StripeParams = {
      line1: attr(row, "business_building_number"),
      town: attr(row, "business_street_address_kanji"),
      state: row.business_state,
      country: "JP",
      postal_code: row.is_business === true ? row.business_zip_code : row.zip_code,
    };
    const addressKana: StripeParams = {
      line1: attr(row, "business_building_number_kana"),
      town: attr(row, "business_street_address_kana"),
      state: prefectureKana(row.business_state),
      country: "JP",
      postal_code: row.is_business === true ? row.business_zip_code : row.zip_code,
    };
    if (!isBlank(row.business_city)) addressKanji.city = row.business_city;
    if (!isBlank(attr(row, "business_city_kana"))) addressKana.city = attr(row, "business_city_kana");
    deepMerge(hash, {
      company: {
        name_kanji: attr(row, "business_name_kanji"),
        name_kana: attr(row, "business_name_kana"),
        address_kanji: addressKanji,
        address_kana: addressKana,
      },
    });
  }

  // Stripe validates `company[structure]` against the account country, which comes from the legal entity.
  if (residence === ARE && legalEntityCountry === ARE) {
    deepMerge(hash, { company: { structure: row.business_type, vat_id: attr(row, "business_vat_id_number") } });
  } else if (legalEntityCountry === CAN) {
    deepMerge(hash, { company: { structure: row.business_type === "non_profit" ? "" : row.business_type } });
  } else if (
    legalEntityCountry === USA &&
    row.business_type !== null &&
    Object.hasOwn(US_COMPANY_STRUCTURES, row.business_type)
  ) {
    company.structure = US_COMPANY_STRUCTURES[row.business_type]!;
  }
  return hash;
}

export type AccountHashInput = {
  userExternalId: string;
  businessProfileUrl: string;
  tosAgreement: { createdAtEpoch: number; ip: string | null; externalId: string } | null;
  info: {
    row: ComplianceRow;
    externalId: string;
    email: string;
    individualTaxId: string;
    businessTaxId: string;
  } | null;
};

// StripeMerchantAccountManager.account_hash. `tos_agreement.created_at.to_time.to_i` arrives as `createdAtEpoch`.
export function accountHash({
  userExternalId,
  businessProfileUrl,
  tosAgreement,
  info,
}: AccountHashInput): StripeParams {
  const hash: StripeParams = { metadata: { user_id: userExternalId } };

  if (tosAgreement) {
    if (info === null) throw new TypeError("undefined method 'legal_entity_country_code' for nil");
    const tosAcceptance: StripeParams = { date: tosAgreement.createdAtEpoch, ip: tosAgreement.ip };
    if (supportsCrossBorderPayouts(legalEntityCountryCodeOf(info.row))) tosAcceptance.service_agreement = "recipient";
    deepMerge(hash, { tos_acceptance: tosAcceptance, metadata: { tos_agreement_id: tosAgreement.externalId } });
  }

  if (info) {
    const { row } = info;
    const legalEntityCountry = legalEntityCountryCodeOf(row);
    let businessType = "individual";
    if (row.is_business === true)
      businessType =
        legalEntityCountry === CAN && ["non_profit", "registered_charity"].includes(row.business_type ?? "")
          ? "non_profit"
          : "company";
    deepMerge(hash, {
      metadata: { user_compliance_info_id: info.externalId },
      business_type: businessType,
      business_profile: {
        name: legalEntityNameOf(row),
        url: businessProfileUrl,
        product_description: legalEntityNameOf(row),
      },
    });
    if ([ARE, CAN].includes(countryCodeOf(row) ?? ""))
      (hash.business_profile as StripeParams).support_phone = attr(row, "business_phone");

    if (row.is_business === true) deepMerge(hash, companyHash(row, info.businessTaxId));
    else deepMerge(hash, { individual: personHash(row, info.email, info.individualTaxId) });
  }
  return deepValuesStrip(hash);
}

// What the Stripe accessors of the ported bank account classes answer: BankAccount's defaults, which AchAccount keeps, and
// the three country classes whose routing number is built from their columns.
const BANK_ACCOUNT_TYPES: Record<
  string,
  { country: string; currency: string; routingNumber: (bank: BankRow) => string | null }
> = {
  AchAccount: { country: USA, currency: "usd", routingNumber: (bank) => bank.bank_number },
  CanadianBankAccount: {
    country: CAN,
    currency: "cad",
    routingNumber: (bank) => `${bank.branch_code ?? ""}-${bank.bank_number ?? ""}`,
  },
  UkBankAccount: { country: "GB", currency: "gbp", routingNumber: (bank) => bank.bank_number },
  AustralianBankAccount: { country: "AU", currency: "aud", routingNumber: (bank) => bank.bank_number },
};

type BankRow = Pick<BankAccount, "type" | "bank_number" | "branch_code" | "account_type" | "account_holder_full_name">;

export type BankAccountHashInput = {
  bank: BankRow;
  externalId: string;
  accountNumber: string;
  legalEntity: ComplianceRow;
  stripeMetadata?: Record<string, string> | null;
};

// StripeMerchantAccountManager.bank_account_hash for a bank account (not a card), with `account_number.decrypt(passphrase)` passed in.
export function bankAccountHash({
  bank,
  externalId,
  accountNumber,
  legalEntity,
  stripeMetadata,
}: BankAccountHashInput): StripeParams {
  const accessors = BANK_ACCOUNT_TYPES[bank.type ?? "AchAccount"];
  if (accessors === undefined)
    throw new NotPortedError(`${bank.type} Stripe accessors`, "the bank account classes of app/models");
  const metadata: Record<string, string> = { ...stripeMetadata };
  // The Ruby hash would hold the string key and the symbol key side by side.
  if (Object.hasOwn(metadata, "bank_account_id"))
    throw new NotPortedError("metadata that already names a bank account", "bank_account_hash");

  const countryCode = legalEntityCountryCodeOf(legalEntity);
  const bankAccountField: StripeParams = {
    country: accessors.country,
    currency: accessors.currency,
    account_number: accountNumber.replace(/[ -]/gu, ""),
  };
  let routingNumber = accessors.routingNumber(bank);
  routingNumber = routingNumber === null ? null : rubyStrip(routingNumber).toUpperCase();
  if (routingNumber !== null && !isBlank(routingNumber)) {
    if (countryCode === GIB) routingNumber = routingNumber.replace(/[ -]/gu, "");
    bankAccountField.routing_number = routingNumber;
  }
  if ([CHL, COL].includes(countryCode ?? "") && !isBlank(bank.account_type))
    bankAccountField.account_type = bank.account_type;
  if (accountHolderNameSyncedToStripe(legalEntity))
    bankAccountField.account_holder_name = bank.account_holder_full_name;

  return deepValuesStrip({
    metadata: { ...metadata, bank_account_id: externalId },
    bank_account: bankAccountField,
    settings: {
      payouts: { schedule: { interval: "manual" }, debit_negative_balances: !supportsCrossBorderPayouts(countryCode) },
    },
  });
}

// StripeMerchantAccountManager.account_holder_name_synced_to_stripe?, with the seller's alive compliance info given
function accountHolderNameSyncedToStripe(info: ComplianceRow): boolean {
  const country = legalEntityCountryCodeOf(info);
  return (
    ACCOUNT_HOLDER_NAME_SYNC_COUNTRIES.includes(country ?? "") || (info.is_business === true && country === ECUADOR)
  );
}
