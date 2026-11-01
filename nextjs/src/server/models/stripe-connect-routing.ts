// The country of a seller's compliance record as app/models/user_compliance_info.rb and
// app/modules/user/feature_status.rb derive it. The table stores country names ("country",
// "business_country"); the codes are looked up through Compliance::Countries.find_by_name on every read.
import { alpha2ByName, COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT } from "./compliance-countries.ts";

// User::FeatureStatus::LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE
export const LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE = "stripe_connect_routing_by_legal_entity_country";

export type ComplianceInfoCountries = {
  is_business?: unknown;
  business_country?: string | null;
  country?: string | null;
};

// `is_business?` on a boolean column: nil and false are no, 0 is false in MySQL's tinyint(1).
const isBusiness = (info: ComplianceInfoCountries) => info.is_business != null && info.is_business !== false && Number(info.is_business) !== 0;

// UserComplianceInfo#country_code
export const countryCode = (info: ComplianceInfoCountries): string | null => alpha2ByName(info.country);

// UserComplianceInfo#business_country_code
export const businessCountryCode = (info: ComplianceInfoCountries): string | null => alpha2ByName(info.business_country);

// UserComplianceInfo#legal_entity_country_code: `(business_country_code if is_business?) || country_code`
export const legalEntityCountryCode = (info: ComplianceInfoCountries): string | null => (isBusiness(info) ? businessCountryCode(info) : null) ?? countryCode(info);

// User#stripe_connect_routing_country_code, once the routing feature has been looked up for the seller
export const stripeConnectRoutingCountryCode = (info: ComplianceInfoCountries, legalEntityRouting: boolean): string | null =>
  legalEntityRouting ? legalEntityCountryCode(info) : countryCode(info);

// StripeMerchantAccountManager::COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT.include?(code)
export const isSupportedByStripeConnect = (code: string | null): boolean => code !== null && COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT.includes(code);
