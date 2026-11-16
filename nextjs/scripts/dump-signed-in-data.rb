# frozen_string_literal: true

# Writes the country and time zone data the signed-in shared props read (User#avatar-less
# current_seller props, User#no_payout_rail_in_compliance_country?, User::CreateBrandAccountService),
# for src/server/page-props/signed-in/data.ts:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-signed-in-data.rb
require "json"

data = {
  "supported" => User::Compliance.const_get(:SUPPORTED_COUNTRIES).map(&:alpha2),
  "paypalPayoutReceiving" => PaypalPayoutProcessor::PAYOUT_RECEIVING_COUNTRY_CODES,
  "usOutlyingAreas" => Compliance::Countries::US_OUTLYING_AREA_ALPHA2,
  "newAccountCreationBlocked" => StripeMerchantAccountManager::NEW_ACCOUNT_CREATION_BLOCKED_COUNTRIES,
  "timeZones" => ActiveSupport::TimeZone::MAPPING,
}
File.write(Rails.root.join("nextjs/src/server/page-props/signed-in/signed-in-data.generated.json"), "#{JSON.generate(data)}\n")
