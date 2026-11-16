# frozen_string_literal: true

# Writes the constant data the payments settings page renders (SettingsPresenter#payments_props), for
# src/server/page-props/settings/payments-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-payments-data.rb
#
# Re-run it when Compliance::Countries, the business types, the bank account classes, the fee
# constants or Country's payout tables change.
require "json"

Rails.application.eager_load!

alpha2_codes = ISO3166::Country.all.map(&:alpha2).sort

# The state of a user as far as the country predicates go: only compliance_country_code matters.
country_predicates = alpha2_codes.to_h do |code|
  user = User.new
  user.define_singleton_method(:compliance_country_code) { code }
  [code, { "europe" => user.signed_up_from_europe?, "iban" => user.country_supports_iban? }]
end

per_country = alpha2_codes.to_h do |code|
  country = Country.new(code)
  [code, { "payout_currency" => country.payout_currency, "min_cross_border_local_cents" => country.min_cross_border_payout_amount_local_cents }]
end

# BankAccount#routing_number per class, as a template over bank_number and branch_code. Evaluated
# for every nil/present combination of the two columns because `"#{x}"` and a bare `x` differ for nil.
BN = "S1B2N3"
BR = "S4B5R6"
BN2 = "q9w8e7r"
BR2 = "t6y5u4i"
routing = {}
BankAccount.descendants.sort_by(&:name).each do |klass|
  next if klass == CardBankAccount

  cases = [[true, true], [true, false], [false, true], [false, false]].to_h do |has_bn, has_br|
    build = ->(bn, br) { klass.new(bank_number: (bn if has_bn), branch_code: (br if has_br)) }
    first = build.call(BN, BR).routing_number
    second = build.call(BN2, BR2).routing_number
    template = first&.sub(BN, "{bank_number}")&.sub(BR, "{branch_code}")
    rebuilt = template&.sub("{bank_number}", BN2)&.sub("{branch_code}", BR2)
    key = "#{has_bn ? 'bn' : '-'}#{has_br ? 'br' : '-'}"
    if rebuilt == second && (template.nil? || !template.include?(BN) && !template.include?(BR))
      [key, template]
    else
      [key, { "unsupported" => [first, second] }]
    end
  rescue StandardError => e
    [key, { "unsupported" => e.class.name }]
  end
  routing[klass.name] = cases
end

data = {
  "countries" => Compliance::Countries.for_select_for_seller_compliance,
  "personCountries" => Compliance::Countries.for_select,
  "representativeCountries" => Compliance::Countries.for_select_for_business_representative,
  "states" => SettingsPresenter.new(pundit_user: SellerContext.logged_out).send(:states),
  "businessTypes" => {
    "us" => UserComplianceInfo::BusinessTypes::BUSINESS_TYPES_US.to_a,
    "uae" => UserComplianceInfo::BusinessTypes::BUSINESS_TYPES_UAE.to_a,
    "india" => UserComplianceInfo::BusinessTypes::BUSINESS_TYPES_INDIA.to_a,
    "canada" => UserComplianceInfo::BusinessTypes::BUSINESS_TYPES_CANADA.to_a,
  },
  "countryPredicates" => country_predicates,
  "perCountry" => per_country,
  "bankAccountRouting" => routing,
  "constants" => {
    "paypalPayoutFeeExempt" => PaypalPayoutProcessor::PAYPAL_PAYOUT_FEE_EXEMPT_COUNTRY_CODES,
    "minAuBacktaxOwedCentsForContact" => User::MIN_AU_BACKTAX_OWED_CENTS_FOR_CONTACT,
    "payoutsMinAmountCents" => Payouts::MIN_AMOUNT_CENTS,
    "rejectedAccountMinAmountCents" => Payouts::REJECTED_ACCOUNT_MIN_AMOUNT_CENTS,
    "instantPayoutFeePercent" => StripePayoutProcessor::INSTANT_PAYOUT_FEE_PERCENT,
    "minimumDateOfBirthAge" => UserComplianceInfo::MINIMUM_DATE_OF_BIRTH_AGE,
    "chargebackRatePayoutReservePercent" => User::CHARGEBACK_RATE_PAYOUT_RESERVE_PERCENT,
    "highVolumeFeePerThousand" => User::HIGH_VOLUME_FEE_PER_THOUSAND,
    "gumroadFlatFeePerThousand" => Purchase::GUMROAD_FLAT_FEE_PER_THOUSAND,
    "gumroadDiscoverFeePerThousand" => Purchase::GUMROAD_DISCOVER_FEE_PER_THOUSAND,
    "gumroadFixedFeeCents" => Purchase::GUMROAD_FIXED_FEE_CENTS,
    "processorFeePerThousand" => Purchase::PROCESSOR_FEE_PER_THOUSAND,
    "processorFixedFeeCents" => Purchase::PROCESSOR_FIXED_FEE_CENTS,
    "retryWindowWeeks" => RetryStripeRejectedPayoutSetupsJob::RETRY_WINDOW_WEEKS,
    "gumroadAdminId" => GUMROAD_ADMIN_ID,
    "postalCodeFailureNotePrefix" => StripeMerchantAccountManager::POSTAL_CODE_FAILURE_NOTE_PREFIX,
    "bankSyncFailureNotePrefix" => StripeMerchantAccountManager::BANK_SYNC_FAILURE_NOTE_PREFIX,
    "guardianSupportedCountryCodes" => UserComplianceInfo::GUARDIAN_SUPPORTED_COUNTRY_CODES,
    "guardianRequiredBelowAge" => UserComplianceInfo::GUARDIAN_REQUIRED_BELOW_AGE,
    "countriesWithStateList" => StripeBeneficialOwnersManager::COUNTRIES_WITH_STATE_LIST,
    "cardDataHandlingMode" => CardDataHandlingMode.get_card_data_handling_mode(nil),
  },
}
File.write(Rails.root.join("nextjs/src/server/page-props/settings/payments-data.generated.json"), "#{JSON.generate(data)}\n")
