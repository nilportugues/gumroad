# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/report-job-arguments.golden.json: the tax and sales report jobs run by the real app as
# Sidekiq jobs (support/sidekiq_executor.rb) against an empty scratch database. Each opens with argument checks that raise before any
# statement, then builds a CSV from queries that run under a session statement cap (a pooled Node connection cannot hold it) and uploads
# it to S3. A run that passes the checks is recorded up to its first statement, which a marker exception stands in for: Node hands those
# back whole. `statements` of a marker case are checked here to hold nothing but the statement cap, so nothing was written before the
# marker. The country and
# subdivision lists are what the two lookups accept, and every one of them is a case. Run it like pdf-unstampable-notifier-job.rb
# (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/report-job-arguments.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)
Time.zone = "UTC"

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
  raise HandBackMarker if $marker_armed && payload[:name] != "SCHEMA"
end

def run(klass, name, args, now: NOW)
  hands_back = false
  result = capture(name, now:, tables: [], sidekiq: true, job: klass.name, args:, case_now: now.to_f) do
    $marker_armed = true
    klass.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  ensure
    $marker_armed = false
  end
  result.delete("seed")
  result.delete("rows")
  unless result["statements"].all? { |s| s.to_s.match?(/\b(SELECT|SET|SHOW)\b/i) && !s.to_s.match?(/\b(INSERT|UPDATE|DELETE)\b/i) }
    raise "#{name}: a write ran before the marker"
  end
  result.merge("hands_back" => hands_back)
end

ODD = [nil, false, true, "5", [5], { "a" => 1 }, 2**70, -3, 0, 5.0, 5.5, ""].freeze

MONTH_YEAR = [CreateCanadaMonthlySalesReportJob, CreateGlobalSalesTaxSummaryReportJob, GenerateCanadaSalesReportJob,
              GenerateFeesByCreatorLocationReportJob].freeze

cases = []
MONTH_YEAR.each do |klass|
  [[3, 2026], [1, 2014], [12, 3200], [6, 2025]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
  [[0, 2026], [13, 2026], [-1, 2026], [3, 2013], [3, 3201], [0, 0], [3, 0], [13, 3201]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
  ODD.each do |value|
    cases << run(klass, "#{klass.name} with month #{value.inspect}", [value, 2026])
    cases << run(klass, "#{klass.name} with year #{value.inspect}", [3, value])
  end
  [[], [3], [3, 2026, 1]].each { cases << run(klass, "#{klass.name} with #{_1.size} arguments", _1) }
end

klass = CreateVatReportJob
[[1, 2026], [4, 2026], [2, 2014], [3, 3200]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
[[0, 2026], [5, 2026], [-1, 2026], [2, 2013], [2, 3201], [0, 0]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
ODD.each do |value|
  cases << run(klass, "#{klass.name} with quarter #{value.inspect}", [value, 2026])
  cases << run(klass, "#{klass.name} with year #{value.inspect}", [2, value])
end
[[], [2], [2, 2026, 1]].each { cases << run(klass, "#{klass.name} with #{_1.size} arguments", _1) }

klass = CreateIndiaSalesReportJob
[[3, 2026], [1, 2014], [12, 3200], [nil, 2026], [3, nil], [nil, nil], [false, 2026], [3, false], [], [3]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
cases << run(klass, "#{klass.name} with no arguments in January", [], now: Time.utc(2027, 1, 15, 8, 0, 0, 500_000))
cases << run(klass, "#{klass.name} with no arguments in March", [], now: Time.utc(2026, 3, 31, 23, 59, 59))
cases << run(klass, "#{klass.name} with no arguments in December", [], now: Time.utc(2026, 12, 31, 12, 0, 0))
cases << run(klass, "#{klass.name} with no arguments in 2013", [], now: Time.utc(2014, 1, 31, 12, 0, 0))
[[0, 2026], [13, 2026], [-1, 2026], [3, 2013], [3, 3201], [0, 0], [nil, 2013], [13, nil]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
ODD.each do |value|
  cases << run(klass, "#{klass.name} with month #{value.inspect}", [value, 2026])
  cases << run(klass, "#{klass.name} with year #{value.inspect}", [3, value])
end
cases << run(klass, "#{klass.name} with three arguments", [3, 2026, 1])

klass = CreateUsStateMonthlySalesReportsJob
subdivision_codes = Compliance::Countries::USA.subdivisions.keys
subdivision_codes.each { cases << run(klass, "#{klass.name} with #{_1} in March 2026", [_1, 3, 2026]) }
["ZZ", "ca", "", "California", "US-CA", " CA", "CA ", "USA"].each { cases << run(klass, "#{klass.name} with subdivision #{_1.inspect}", [_1, 3, 2026]) }
[nil, false, true, 5, 5.0, ["CA"], { "CA" => 1 }].each { cases << run(klass, "#{klass.name} with subdivision #{_1.inspect}", [_1, 3, 2026]) }
[[0, 2026], [13, 2026], [3, 2013], [3, 3201]].each { cases << run(klass, "#{klass.name} with CA and #{_1.inspect}", ["CA", *_1]) }
[[0, 2026], [3, 2013]].each { cases << run(klass, "#{klass.name} with an invalid subdivision and #{_1.inspect}", ["ZZ", *_1]) }
ODD.each do |value|
  cases << run(klass, "#{klass.name} with CA and month #{value.inspect}", ["CA", value, 2026])
  cases << run(klass, "#{klass.name} with CA and year #{value.inspect}", ["CA", 3, value])
end
[[], ["CA"], ["CA", 3], ["CA", 3, 2026, 1]].each { cases << run(klass, "#{klass.name} with #{_1.size} arguments", _1) }

klass = CreateUsStatesSalesSummaryReportJob
[[["CA"], 3, 2026], [["CA", "NY"], 3, 2026, true], [["CA"], 3, 2026, false], [[], 3, 2026], [nil, 3, 2026], ["CA", 3, 2026]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
[[["CA"], 0, 2026], [["CA"], 13, 2026], [["CA"], 3, 2013], [["CA"], 3, 3201], [nil, 0, 2026]].each { cases << run(klass, "#{klass.name} with #{_1.inspect}", _1) }
ODD.each do |value|
  cases << run(klass, "#{klass.name} with month #{value.inspect}", [["CA"], value, 2026])
  cases << run(klass, "#{klass.name} with year #{value.inspect}", [["CA"], 3, value])
end
[[], [["CA"]], [["CA"], 3], [["CA"], 3, 2026, true, 1]].each { cases << run(klass, "#{klass.name} with #{_1.size} arguments", _1) }

klass = GenerateSalesReportJob
country_codes = ISO3166::Country.all.map(&:alpha2).sort
country_codes.each { cases << run(klass, "#{klass.name} with #{_1}", [_1, "2026-03-01", "2026-03-31", "all_sales"]) }
["GB", "US"].each do |code|
  cases << run(klass, "#{klass.name} with #{code} discover sales", [code, "2026-03-01", "2026-03-31", "discover_sales"])
  cases << run(klass, "#{klass.name} with #{code} and an invalid sales type", [code, "2026-03-01", "2026-03-31", "other"])
  cases << run(klass, "#{klass.name} with #{code} and a bad date", [code, "nonsense", "2026-03-31", "all_sales"])
  cases << run(klass, "#{klass.name} with #{code} and no notification", [code, "2026-03-01", "2026-03-31", "all_sales", false, "prefix"])
end
["ZZ", "gb", "Gb", "GBR", "", "United Kingdom", " GB", nil, false, 5, ["GB"]].each do |code|
  cases << run(klass, "#{klass.name} with country #{code.inspect}", [code, "2026-03-01", "2026-03-31", "all_sales"])
  cases << run(klass, "#{klass.name} with country #{code.inspect} and an invalid sales type", [code, "2026-03-01", "2026-03-31", "other"])
end
[nil, false, true, 5, "", "ALL_SALES", "all_sales ", ["all_sales"], "discover"].each do |type|
  cases << run(klass, "#{klass.name} with GB and sales type #{type.inspect}", ["GB", "2026-03-01", "2026-03-31", type])
end
[[], ["GB"], ["GB", "2026-03-01", "2026-03-31"], ["GB", "2026-03-01", "2026-03-31", "all_sales", true, "p", 1]].each { cases << run(klass, "#{klass.name} with #{_1.size} arguments", _1) }

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "subdivision_codes" => subdivision_codes, "country_codes" => country_codes, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
