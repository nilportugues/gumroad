# frozen_string_literal: true

# Writes the country and time zone data the signed-in shared props read (User#avatar-less
# current_seller props, User#no_payout_rail_in_compliance_country?, User::CreateBrandAccountService),
# for src/server/page-props/signed-in/data.ts:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-signed-in-data.rb
require "json"

# Compliance::Countries.find_by_name goes through ISO3166::Country.find_country_by_any_name, which
# also matches translations. The first country wins a shared name.
names = {}
ISO3166::Country.all.each do |country|
  candidates = [country.common_name, country.iso_short_name, country.iso_long_name, *country.unofficial_names, *country.data["gumroad_historical_names"], *country.translations.values]
  candidates.compact.each { |name| names[name.downcase] ||= country.alpha2 }
end

data = {
  "names" => names.sort.to_h,
  "supported" => User::Compliance.const_get(:SUPPORTED_COUNTRIES).map(&:alpha2),
  "paypalPayoutReceiving" => PaypalPayoutProcessor::PAYOUT_RECEIVING_COUNTRY_CODES,
  "usOutlyingAreas" => Compliance::Countries::US_OUTLYING_AREA_ALPHA2,
  "newAccountCreationBlocked" => StripeMerchantAccountManager::NEW_ACCOUNT_CREATION_BLOCKED_COUNTRIES,
  "timeZones" => ActiveSupport::TimeZone::MAPPING,
}
File.write(Rails.root.join("nextjs/src/server/page-props/signed-in/signed-in-data.generated.json"), "#{JSON.generate(data)}\n")
