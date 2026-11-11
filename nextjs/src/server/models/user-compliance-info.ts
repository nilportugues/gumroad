// The reads of app/models/user_compliance_info.rb the payments settings page makes: the alive revision
// (or the blank one `fetch_or_build_user_compliance_info` builds), the country codes derived from the
// stored country names, the attributes kept in json_data, and the Strongbox tax ids. No writes: a
// UserComplianceInfo is immutable and every edit goes through Rails.
import { Prisma, type UserComplianceInfo } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { isBlank as rubyBlank } from "./compliance-countries.ts";
import { alpha2ByName } from "./compliance-countries.ts";
import { isPossiblePoBoxMatch, POSSIBLE_MATCH_SQL_HINT } from "./po-box-address.ts";
import { selectRows } from "./sql.ts";
import { isStrongboxBlank, strongboxDecrypt } from "./strongbox.ts";
import { getConfig } from "../infra/config.ts";

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
export function aliveUserComplianceInfoRow(userId: bigint): Promise<UserComplianceInfo | null> {
  return db.userComplianceInfo.findFirst({ where: { user_id: Number(userId), deleted_at: null }, orderBy: { id: "desc" } });
}

// `user.po_box_in_address_history?`: every revision, deleted ones included, as the association has no scope.
export async function poBoxInAddressHistory(userId: bigint): Promise<boolean> {
  const rows = await selectRows<{ street_address: string | null; business_street_address: string | null }>(
    Prisma.sql`SELECT DISTINCT street_address, business_street_address FROM user_compliance_info WHERE user_id = ${userId} AND (street_address LIKE ${POSSIBLE_MATCH_SQL_HINT} OR business_street_address LIKE ${POSSIBLE_MATCH_SQL_HINT})`,
  );
  return rows.some(
    (row) => isPossiblePoBoxMatch(row.street_address) || isPossiblePoBoxMatch(row.business_street_address),
  );
}

// `build_user_compliance_info`: nothing set, json_data = {}.
const BLANK: UserComplianceInfo = {
  id: 0,
  user_id: null,
  full_name: null,
  street_address: null,
  city: null,
  state: null,
  zip_code: null,
  country: null,
  telephone_number: null,
  vertical: null,
  is_business: null,
  has_sold_before: null,
  individual_tax_id: null,
  json_data: "{}",
  flags: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
  business_name: null,
  business_street_address: null,
  business_city: null,
  business_state: null,
  business_zip_code: null,
  business_country: null,
  business_type: null,
  business_tax_id: null,
  birthday: null,
  deleted_at: null,
  dba: null,
  verticals: null,
  first_name: null,
  last_name: null,
  stripe_identity_document_id: null,
  guardian_id: null,
};

// `fetch_or_build_user_compliance_info`; `persisted` tells the two apart.
export type ComplianceInfo = { row: UserComplianceInfo; persisted: boolean };

export async function fetchOrBuildComplianceInfo(userId: bigint): Promise<ComplianceInfo> {
  const row = await aliveUserComplianceInfoRow(userId);
  return row ? { row, persisted: true } : { row: { ...BLANK, user_id: Number(userId) }, persisted: false };
}

// JsonData#json_data_for_attr: the stored value, or the default when it is blank.
export function jsonAttr(row: Pick<UserComplianceInfo, "json_data">, key: string): string | null {
  if (rubyBlank(row.json_data)) return null;
  const data: unknown = JSON.parse(row.json_data!);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("json_data must be a hash");
  const value = (data as Record<string, unknown>)[key];
  if (value === undefined || value === null || value === false || value === "" || (typeof value === "string" && rubyBlank(value))) return null;
  return value as string;
}

export const isBusiness = (row: UserComplianceInfo): boolean => row.is_business === true;

// UserComplianceInfo#country_code and #business_country_code
export const countryCode = (row: UserComplianceInfo): string | null => alpha2ByName(row.country);
export const businessCountryCode = (row: UserComplianceInfo): string | null => alpha2ByName(row.business_country);

// UserComplianceInfo#legal_entity_country_code
export const legalEntityCountryCode = (row: UserComplianceInfo): string | null => (isBusiness(row) ? businessCountryCode(row) : null) ?? countryCode(row);

// UserComplianceInfo#legal_entity_name
export const legalEntityName = (row: UserComplianceInfo): string | null => {
  if (isBusiness(row)) return row.business_name;
  // first_and_last_name: "#{first_name} #{last_name}".squeeze(" ").strip
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.replace(/ {2,}/gu, " ").replace(/^[\s\0]+|[\s\0]+$/gu, "");
};

// UserComplianceInfo#under_legal_guardian_age?: birthday > 18.years.ago.to_date
export function underLegalGuardianAge(row: UserComplianceInfo, ageLimit: number, now: Date): boolean {
  if (!row.birthday) return false;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - ageLimit, now.getUTCMonth(), now.getUTCDate()));
  return row.birthday.getTime() > cutoff.getTime();
}

// Unicode White_Space, which is what [[:space:]] matches in a Ruby UTF-8 string.
const SPACE = new RegExp("[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]", "gu");

// Strongbox decryption returns a binary string; Rails forces it to UTF-8 and drops invalid bytes.
function scrubbedUtf8(plain: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return plain.toString("utf8").replaceAll("�", "");
  }
}

export function decryptedTaxId(ciphertext: Uint8Array | null): string {
  const password = getConfig("STRONGBOX_GENERAL_PASSWORD");
  if (password === undefined) throw new Error("STRONGBOX_GENERAL_PASSWORD is not configured");
  return scrubbedUtf8(strongboxDecrypt(ciphertext, password) ?? Buffer.alloc(0));
}

export const hasTaxId = (ciphertext: Uint8Array | null): boolean => !isStrongboxBlank(ciphertext);

// SettingsPresenter#tax_id_last_four: the last four characters once whitespace is gone; nil when
// there is no value, or fewer than four characters (`"abc"[-4..]` is nil).
export function taxIdLastFour(ciphertext: Uint8Array | null): string | null {
  if (isStrongboxBlank(ciphertext)) return null;
  const characters = Array.from(decryptedTaxId(ciphertext).replace(SPACE, ""));
  return characters.length < 4 ? null : characters.slice(-4).join("");
}

// SettingsPresenter#tax_id_is_last_four_only?: exactly four digits on file.
export function taxIdIsLastFourOnly(ciphertext: Uint8Array | null): boolean {
  if (isStrongboxBlank(ciphertext)) return false;
  return decryptedTaxId(ciphertext).replace(/\D/gu, "").length === 4;
}
