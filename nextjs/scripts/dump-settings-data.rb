# frozen_string_literal: true

# Writes the constant lists the settings pages render (SettingsPresenter#main_props and #billing_props),
# for src/server/page-props/settings/settings-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-settings-data.rb
#
# Re-run it when the time zone mapping, CURRENCY_CHOICES, Compliance::Countries or BusinessIdLabels change.
require "json"
include CurrencyHelper

data = {
  "timezones" => ActiveSupport::TimeZone.all.map { |tz| { "name" => tz.name, "offset" => tz.formatted_offset } },
  "currencies" => currency_choices.map { |name, code| { "name" => name, "code" => code } },
  "countries" => Compliance::Countries.for_select.to_a,
  "businessIdCountryCodes" => BusinessIdLabels::COUNTRY_CODES,
  "businessIdLabels" => BusinessIdLabels::LABELS,
}
File.write(Rails.root.join("nextjs/src/server/page-props/settings/settings-data.generated.json"), "#{JSON.generate(data)}\n")
