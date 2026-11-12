# frozen_string_literal: true

# Produces nextjs/src/server/exports/__fixtures__/purchase-export-time-zone.golden.json: the two instants
# Exports::PurchaseExportService.export builds from `start_time`/`end_time` when `in_seller_time_zone` is set, for every
# time zone a seller can pick, on dates that include midnights a DST change skips or repeats. No rows are needed.
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_test_29 TEST_DATABASE_NAME=gumroad_test_29 DISABLE_TEST_REDIS_ISOLATION=1 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/purchase-export-time-zone.rb
OUT = Rails.root.join("nextjs/src/server/exports/__fixtures__/purchase-export-time-zone.golden.json")
DATES = %w[2025-01-15 2025-03-09 2025-03-10 2025-03-30 2025-04-06 2025-07-01 2025-10-26 2025-11-02 2018-11-04 2018-10-14 2019-09-08].freeze
INPUTS = (DATES + DATES.map { (Date.parse(_1) - 1).to_s }).uniq.sort

def attempt
  yield
rescue StandardError => e
  "#{e.class}: #{e.message}"
end

zones = ActiveSupport::TimeZone.all.map do |zone|
  time_zone = ActiveSupport::TimeZone[zone.name]
  {
    "name" => zone.name,
    "dates" => INPUTS.index_with do |date|
      {
        # PurchaseExportService.export: start_time and end_time
        "start" => attempt { Date.parse(date).in_time_zone(time_zone).beginning_of_day.iso8601 },
        "end" => attempt { (Date.parse(date) + 1).in_time_zone(time_zone).iso8601 },
      }
    end,
  }
end

unmapped = ["Nowhere", "", "utc-ish"].index_with { ActiveSupport::TimeZone[_1].nil? }

File.write(OUT, JSON.pretty_generate({ "zones" => zones, "unmapped_names_read_as_nil" => unmapped }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{zones.size} zones, #{INPUTS.size} dates)"
