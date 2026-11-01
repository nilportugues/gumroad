# frozen_string_literal: true

# Writes the constant data the sales analytics page renders (AnalyticsPresenter#page_props), for
# src/server/page-props/analytics/analytics-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-analytics-data.rb
#
# Re-run it when Compliance::Countries, STATES_SUPPORTED_BY_ANALYTICS or the US subdivisions change.
require "json"

data = {
  "generated_by" => "nextjs/scripts/dump-analytics-data.rb",
  "country_codes" => Compliance::Countries.alpha2_by_name,
  "state_codes" => STATES_SUPPORTED_BY_ANALYTICS,
  "state_names" => STATES_SUPPORTED_BY_ANALYTICS.map { |state_code| Compliance::Countries::USA.subdivisions[state_code]&.name || "Other" },
  "product_event_tracking_started_date" => PRODUCT_EVENT_TRACKING_STARTED_DATE.to_s,
}

path = File.expand_path("../src/server/page-props/analytics/analytics-data.generated.json", __dir__)
File.write(path, "#{JSON.pretty_generate(data)}\n")
puts "wrote #{path}"
