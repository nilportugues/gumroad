// Ports of the offline tax-id validators (OmanVatNumberValidationService, TrnValidationService,
// KraPinValidationService, FirsTinValidationService, TraTinValidationService) and the country routing of
// RegionalVatIdValidationService#process. Validators that call a vendor (ABN/EU VIES/Vatstack, IRAS GST, Revenu
// Quebec QST, MVA, taxid.pro) are not ported: `regionalVatIdValidator` names which one Rails would call.
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITH_TAX_ID_PRO_VALIDATION,
  QUEBEC,
} from "./sales-tax-countries.ts";

// Ruby `blank?` on a String: only [[:space:]] (White_Space). JS `\s` also matches U+FEFF, which Ruby does not.
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
export const isBlank = (value: string | null | undefined): value is null | undefined | "" =>
  value == null || BLANK.test(value);

// JS `$` without the m flag matches only at the very end, like Ruby's `\z`.
export const omanVatNumber = (value: string | null | undefined): boolean =>
  !isBlank(value) && /^OM\d{10}$/u.test(value);
export const bahrainTrn = (value: string | null | undefined): boolean => !isBlank(value) && [...value].length === 15;
export const kenyaKraPin = (value: string | null | undefined): boolean =>
  !isBlank(value) && /^[A-Z]\d{9}[A-Z]$/u.test(value);
export const tanzaniaTraTin = (value: string | null | undefined): boolean =>
  !isBlank(value) && /^\d{2}-\d{6}-[A-Z]$/u.test(value);
// Ruby uses ^ and $ (line anchors) here, unlike the other validators.
export const nigeriaFirsTin = (value: string | null | undefined): boolean =>
  !isBlank(value) && /^\d{8}-\d{4}$/mu.test(value);

export type RegionalVatIdValidator =
  | { kind: "local"; validate: (value: string | null | undefined) => boolean }
  | {
      kind: "remote";
      service:
        | "AbnValidationService"
        | "GstValidationService"
        | "QstValidationService"
        | "MvaValidationService"
        | "TaxIdValidationService"
        | "VatValidationService";
    };

/** Which validator RegionalVatIdValidationService would pick; blank ids are rejected before routing, as in Rails. */
export function regionalVatIdValidator(
  countryCode: string | null | undefined,
  stateCode: string | null | undefined,
): RegionalVatIdValidator {
  if (countryCode === "AU") return { kind: "remote", service: "AbnValidationService" };
  if (countryCode === "SG") return { kind: "remote", service: "GstValidationService" };
  if (countryCode === "CA" && stateCode === QUEBEC) return { kind: "remote", service: "QstValidationService" };
  if (countryCode === "NO") return { kind: "remote", service: "MvaValidationService" };
  if (countryCode === "BH") return { kind: "local", validate: bahrainTrn };
  if (countryCode === "KE") return { kind: "local", validate: kenyaKraPin };
  if (countryCode === "NG") return { kind: "local", validate: nigeriaFirsTin };
  if (countryCode === "TZ") return { kind: "local", validate: tanzaniaTraTin };
  if (countryCode === "OM") return { kind: "local", validate: omanVatNumber };
  if (
    countryCode != null &&
    (COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.includes(countryCode) ||
      COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITH_TAX_ID_PRO_VALIDATION.includes(countryCode))
  ) {
    return { kind: "remote", service: "TaxIdValidationService" };
  }
  return { kind: "remote", service: "VatValidationService" };
}
