# frozen_string_literal: true

# Writes the static data the workflow and email form contexts read, for
# src/server/page-props/audience/audience-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-audience-data.rb
#
# - countries: Compliance::Countries.for_select names, in order
# - currencies: what MoneyFormatter.symbol_for and Money#format(no_cents_if_whole: true, symbol: false) read
# - timeZones: the abbreviation ("%Z") of the standard and the daylight period of each Rails time zone
require "json"

countries = Compliance::Countries.for_select.map(&:last)

currencies = CURRENCY_CHOICES.keys.to_h do |code|
  currency = Money::Currency.new(code)
  [code.to_s, {
    "symbol" => MoneyFormatter.symbol_for(code),
    "decimal_mark" => currency.decimal_mark,
    "thousands_separator" => currency.thousands_separator,
    "exponent" => currency.exponent,
    "subunit_to_unit" => currency.subunit_to_unit,
  }]
end

zones = ActiveSupport::TimeZone::MAPPING.keys.to_h do |name|
  zone = ActiveSupport::TimeZone[name]
  periods = (2020..2030).flat_map { |year| (1..12).map { |month| zone.tzinfo.period_for_utc(Time.utc(year, month, 15)) } }.uniq
  standard = periods.reject(&:dst?).map(&:abbreviation).tally.max_by(&:last)&.first
  daylight = periods.select(&:dst?).map(&:abbreviation).tally.max_by(&:last)&.first
  [name, { "standard" => standard, "daylight" => daylight }]
end

data = { "countries" => countries, "currencies" => currencies, "timeZones" => zones }
File.write(Rails.root.join("nextjs/src/server/page-props/audience/audience-data.generated.json"), "#{JSON.generate(data)}\n")
