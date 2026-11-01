# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/update-purchasing-power-parity-factors-job.golden.json:
# UpdatePurchasingPowerParityFactorsWorker run by the real app as a Sidekiq job (support/sidekiq_executor.rb)
# against a local stand-in for api.worldbank.org that serves the zip each case scripts, with the Redis
# commands it sent to the `ppp` and `currencies` namespaces, the keys it left, and its error. Also writes
# Float#round(2) vectors for the arithmetic. Run like subscription-reminder-jobs.rb (scratch database and Redis):
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws52 TEST_DATABASE_NAME=gumroad_ws52 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/9 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/9 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/9 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/9 \
#     bundle exec rails runner nextjs/scripts/golden/update-purchasing-power-parity-factors-job.rb
require_relative "support/rails_cases"
require_relative "../../src/server/stripe/__fixtures__/capture_server"
require "base64"
require "zip"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/update-purchasing-power-parity-factors-job.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
Job = UpdatePurchasingPowerParityFactorsWorker

SERVER = CaptureServer.new
URL_PATH = "/v2/en/indicator/PA.NUS.PPP"
Job.send(:remove_const, :API_URL)
Job.const_set(:API_URL, "http://127.0.0.1:#{SERVER.port}#{URL_PATH}?downloadformat=csv")

# The commands sent to the namespaces the job touches while a case is recorded.
module JobCommandLog
  def call(command, config)
    ($job_commands << command.map(&:to_s)) if $job_commands && RailsRecorder.log && command[1].to_s.match?(/\A(ppp|currencies):/)
    super
  end
end
RedisClient.register(JobCommandLog)
$job_commands = nil

HEADER_LINES = ["\"Data Source\",\"World Development Indicators\",", "", "\"Last Updated Date\",\"2025-07-01\",", ""].freeze
COLUMNS = ["Country Name", "Country Code", "Indicator Name", "Indicator Code", "2022", "2023", "2024"].freeze

def quote(value) = value.nil? ? "" : "\"#{value.to_s.gsub('"', '""')}\""
def csv_row(*fields) = fields.map { |f| f.is_a?(Raw) ? f.text : quote(f) }.join(",") + ","
Raw = Struct.new(:text)

# A World Bank file: four lines of metadata, then the header and one line per country. `values` are the
# columns of the last three years.
def csv(rows, columns: COLUMNS, header_lines: HEADER_LINES, eol: "\r\n", extra_lines: [])
  lines = header_lines + [csv_row(*columns)] + rows.map { |name, code, *values| csv_row(name, code, "PPP conversion factor", "PA.NUS.PPP", *values.map { _1.is_a?(Raw) ? _1 : _1 }) } + extra_lines
  lines.map { "#{_1}#{eol}" }.join
end

def zip_of(entries, stored: false)
  io = Zip::OutputStream.write_buffer do |zos|
    entries.each do |name, body|
      zos.put_next_entry(name, nil, nil, stored ? Zip::Entry::STORED : Zip::Entry::DEFLATED)
      zos.write(body)
    end
  end
  io.string
end

DATA_FILE = "API_PA.NUS.PPP_DS2_en_csv_v2_12345.csv"
METADATA_FILE = "Metadata_Country_API_PA.NUS.PPP_DS2_en_csv_v2_12345.csv"
def standard_zip(body, **options) = zip_of([[DATA_FILE, body], [METADATA_FILE, "\"Country Code\",\"Region\"\r\n"]], **options)

# Currency rates the job reads through get_rate (the `currencies` namespace); others come from lib/currency/backup_rates.json.
RATES = { "currencies:INR" => "83.0", "currencies:BRL" => "5.0", "currencies:MXN" => "18.0", "currencies:TRY" => "30.0", "currencies:ARS" => "900.0", "currencies:EGP" => "48.0" }.freeze
ONES = RATES.transform_values { "1.0" }.freeze

cases = []
scenario = lambda do |name, body, responses: nil, redis: RATES, hand_back: false|
  responses ||= [[200, { "Content-Type" => "application/zip" }, body]]
  SERVER.requests.clear
  SERVER.responses = responses.map { |status, headers, response_body| [status, headers.dup, response_body] }
  $job_commands = []
  result = capture(name, now: NOW, tables: [], sidekiq: true, setup: -> { redis.each { |key, value| $redis.set(key, value) } }) { Job.new.perform }
  result["commands"] = $job_commands
  $job_commands = nil
  result["requests"] = SERVER.requests.map { _1.slice("method", "path", "query") }
  result["responses"] = responses.map { |status, headers, response_body| { "status" => status, "headers" => headers, "body" => Base64.strict_encode64(response_body) } }
  result["hand_back"] = true if hand_back
  %w[seed statements cache rows].each { result.delete(_1) }
  cases << result
end

# India, Brazil, Mexico and Turkey are priced at 83, 5, 18 and 30 per dollar in RATES.
standard_rows = [
  ["India", "IND", "", "", "21.5"], ["Brazil", "BRA", "2.1", "2.2", "2.3"], ["Mexico", "MEX", "9.9", "9.5", ""], ["Türkiye", "TUR", nil, nil, "12.34"],
  ["Argentina", "ARG", "100", "200", "300"], ["United States", "USA", "1", "1", "1"], ["Germany", "DEU", "0.7", "0.7", "0.7"], ["Egypt, Arab Rep.", "EGY", "", "", "17.6"],
  ["World", "WLD", "1", "1", "1"], ["Narnia", "ZZZ", "1", "1", "1"], ["Philippines", "PHL", "", "", "18.4"], ["Kosovo", "XKX", "", "", "0.3"], ["Belarus", "BLR", "", "", "1.1"],
  ["Hong Kong SAR, China", "HKG", "", "", "5.0"], ["Japan", "JPN", "", "", "100.0"],
]
scenario.("sets a factor per country, clamped to the thresholds", standard_zip(csv(standard_rows.first(11))))
scenario.("a country whose currency has no rate", standard_zip(csv([["Belarus", "BLR", "", "", "1.1"], ["India", "IND", "", "", "21.5"]])))
scenario.("a country without a currency raises", standard_zip(csv([["India", "IND", "", "", "21.5"], ["Kosovo", "XXK", "", "", "0.3"], ["Brazil", "BRA", "", "", "2.3"]])))
scenario.("the excluded countries are set to 1", standard_zip(csv(%w[AE QA SG JP DE US IT ES PT AU HK].map { |a2| c = ISO3166::Country[a2]; [c.common_name, c.alpha3, "", "", "9"] })))
scenario.("an excluded country is set even when it has no currency rate", standard_zip(csv([["Hong Kong SAR, China", "HKG", "", "", "5.0"], ["Japan", "JPN", "", "", "100.0"]])), redis: {})

# Exact thresholds and round-half-up at two digits: the rate is 1.0, so the factor is the stored value.
ties = %w[0.4 0.39 0.395 0.404 0.405 0.8 0.8000001 0.799 0.795 0.805 0.125 0.135 0.145 0.155 0.165 0.175 0.185 0.195 0.205 0.215 0.225 0.235 0.245 0.255 0.265 0.275 0.285 0.295 0.5 0.505 0.515 0.525 0.535 0.545 0.555 0.565 0.575 0.585 0.595 0.605 0.615 0.625 0.635 0.645 0.655 0.665 0.675 0.685 0.695 0.705 0.715 0.725 0.735 0.745 0.755 0.765 0.775 0.785 0.795 1.005 0.1 0.45 0.4449999 0.4450001 0.12345 0.3999999 0.4000001 7 0 -3 1e-1 1e2 .7 5. 0x1A 1_0 +0.6 0,5 NaN Infinity -0.5]
tie_rows = ties.each_with_index.map { |value, i| code = %w[IND BRA MEX TUR ARG][i % 5]; [code, code, "", "", value] }
ties.each_slice(5).each_with_index do |slice, i|
  scenario.("round half up at two digits and the thresholds, group #{i + 1}", standard_zip(csv(slice.each_with_index.map { |value, j| c = ISO3166::Country[%w[IN BR MX TR EG][j]]; [c.common_name, c.alpha3, "", "", value] })), redis: ONES.merge("currencies:EGP" => "1.0"))
end
scenario.("a repeated country keeps the last value", standard_zip(csv([["India", "IND", "", "", "30"], ["India", "IND", "", "", "60"]])))

# Values that are not plain numbers.
[nil, "", " ", "abc", "1e-1", "0.5abc", "  0.6", "1,5", "1_0", "٣"].each do |value|
  scenario.("a value of #{value.inspect}", standard_zip(csv([["India", "IND", "1", "1", value]])), redis: ONES)
end
scenario.("a quoted empty value", standard_zip(csv([["India", "IND", "1", "1", Raw.new('""')]])), redis: ONES)
scenario.("a quoted value with a comma", standard_zip(csv([["India, the republic", "IND", "1", "1", Raw.new('"0.55"')]])), redis: ONES)

# Zero and non-finite exchange rates.
scenario.("an exchange rate of zero", standard_zip(csv([["India", "IND", "", "", "21.5"], ["Brazil", "BRA", "", "", "0"]])), redis: ONES.merge("currencies:INR" => "0", "currencies:BRL" => "0"))
scenario.("a currency rate Redis lacks is fetched and stored", standard_zip(csv([["Philippines", "PHL", "", "", "18.4"]])), redis: {})
scenario.("a currency rate of zero is fetched again", standard_zip(csv([["Philippines", "PHL", "", "", "18.4"]])), redis: { "currencies:PHP" => "0" })
scenario.("a currency absent from the rates file is stored empty", standard_zip(csv([["Belarus", "BLR", "", "", "1.1"], ["Zambia", "ZMB", "", "", "0"]])), redis: {})
scenario.("a very large factor", standard_zip(csv([["Argentina", "ARG", "", "", "1e300"], ["India", "IND", "", "", "1e-300"]])))
scenario.("a very small exchange rate", standard_zip(csv([["Argentina", "ARG", "", "", "300"]])), redis: { "currencies:ARS" => "0.0000001" })

# Country codes the way the gem's finder reads them.
["IND", "ind", "Ind", " IND", "IND ", "I,ND", "(IND)", "I[]ND", "ÏND", "XXK", "IN", "", "INDIA"].each do |code|
  scenario.("country code #{code.inspect}", standard_zip(csv([["India", code, "", "", "21.5"]])))
end
scenario.("no country code header", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: ["Country Name", "Code", "Indicator Name", "Indicator Code", "2022", "2023", "2024"])))

# The year the file reports.
scenario.("the year is two years old", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: COLUMNS.first(4) + %w[2021 2022 2023])))
scenario.("the year is three years old", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: COLUMNS.first(4) + %w[2020 2021 2022])))
scenario.("the year is two years ahead", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: COLUMNS.first(4) + %w[2025 2026 2027])))
scenario.("the year is three years ahead", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: COLUMNS.first(4) + %w[2026 2027 2028])))
# Integer() reads more than plain decimals ("0x7E8", "2_024", a leading zero for octal); Node hands those back.
plain_integer = /\A\s*[+-]?(0|[1-9]\d*)\s*\z/
["abc", "", " 2024 ", "2024.0", "0x7E8", "2_024", "-2024", "+2024", "2024abc", "02024", "0", "2025", "2023"].each do |year|
  scenario.("the last year column is #{year.inspect}", standard_zip(csv([["India", "IND", "", "", "0.6"]], columns: COLUMNS.first(5) + ["2023", year])), redis: ONES, hand_back: year.match?(/\d/) && !year.match?(plain_integer))
end
scenario.("a header row with one column", standard_zip(csv([["India", "IND", "", "", "21.5"]], columns: ["2024"])))
scenario.("a header row with two columns", standard_zip(csv([], columns: ["Country Code", "2024"])))
scenario.("the file has only the header", standard_zip(csv([])))
scenario.("the data column of the year is missing a value for every country", standard_zip(csv([["India", "IND", "1", "1"]])))

# Where the lines run out.
scenario.("exactly four lines", standard_zip(HEADER_LINES.map { "#{_1}\r\n" }.join))
scenario.("three lines", standard_zip(HEADER_LINES.first(3).map { "#{_1}\r\n" }.join))
scenario.("no lines", standard_zip(""))
scenario.("five lines, the header only", standard_zip(csv([])))
scenario.("no trailing line break", standard_zip(csv([["India", "IND", "", "", "21.5"]]).chomp))
scenario.("lines end with line feeds", standard_zip(csv([["India", "IND", "", "", "21.5"], ["Brazil", "BRA", "", "", "2.3"]], eol: "\n")))
scenario.("a blank line between countries", standard_zip(csv([["India", "IND", "", "", "21.5"]], extra_lines: ["", csv_row("Brazil", "BRA", "x", "y", "", "", "2.3")])))
scenario.("a row shorter than the header", standard_zip(csv([["India", "IND"], ["Brazil", "BRA", "", "", "2.3"]])))
scenario.("a row longer than the header", standard_zip(csv([["India", "IND", "", "", "21.5", "9", "9"]])))
scenario.("a byte order mark and non-ASCII names", standard_zip("\xEF\xBB\xBF".b + csv([["Côte d'Ivoire", "CIV", "", "", "18.4"], ["Türkiye", "TUR", "", "", "12.34"]]).b))
scenario.("non-ASCII bytes that are not UTF-8", standard_zip(csv([["Cote d\xE9", "IND", "", "", "21.5"]]).b))
scenario.("lines end with a bare carriage return", standard_zip(csv([["India", "IND", "", "", "21.5"]], eol: "\r")))
scenario.("mixed line endings", standard_zip(csv([["India", "IND", "", "", "21.5"]], eol: "\r\n") + "#{csv_row("Brazil", "BRA", "x", "y", "", "", "2.3")}\n"), hand_back: true)
scenario.("a quote inside an unquoted field", standard_zip(csv([["India", "IND", "", "", Raw.new("2\"1")]])), hand_back: true)
scenario.("an unclosed quote", standard_zip(csv([["India", "IND", "", "", Raw.new('"21.5')]])), hand_back: true)
scenario.("text after a closing quote", standard_zip(csv([["India", "IND", "", "", Raw.new('"21.5"x')]])), hand_back: true)
scenario.("a line break inside a quoted field", standard_zip(csv([["India\r\nthe republic", "IND", "", "", "21.5"]])))

# The zip.
scenario.("the data file is stored uncompressed", standard_zip(csv([["India", "IND", "", "", "21.5"]]), stored: true))
scenario.("the metadata file comes first", zip_of([[METADATA_FILE, "x"], [DATA_FILE, csv([["India", "IND", "", "", "21.5"]])]]))
scenario.("the first matching file wins", zip_of([[DATA_FILE, csv([["India", "IND", "", "", "21.5"]])], ["API_PA_other.csv", csv([["Brazil", "BRA", "", "", "2.3"]])]]))
scenario.("the file name prefix is case sensitive", zip_of([["api_pa.csv", csv([["India", "IND", "", "", "21.5"]])]]))
scenario.("a data file in a directory", zip_of([["data/#{DATA_FILE}", csv([["India", "IND", "", "", "21.5"]])]]))
scenario.("no matching file", zip_of([[METADATA_FILE, "x"]]))
scenario.("an empty zip", zip_of([]))
scenario.("not a zip", "this is not a zip file", hand_back: true)
scenario.("an empty body", "")

# The HTTP exchange.
good = standard_zip(csv([["India", "IND", "", "", "21.5"]]))
scenario.("not found", nil, responses: [[404, {}, "nope"]])
scenario.("a server error", nil, responses: [[500, {}, "boom"]])
scenario.("no scripted response", nil, responses: [])
scenario.("a redirect to a relative path", nil, responses: [[302, { "Location" => "/v2/en/other.zip?x=1" }, ""], [200, {}, good]])
scenario.("a permanent redirect", nil, responses: [[301, { "Location" => "/moved.zip" }, ""], [200, {}, good]])
scenario.("a see other redirect", nil, responses: [[303, { "Location" => "/other.zip" }, ""], [200, {}, good]])
scenario.("a temporary redirect", nil, responses: [[307, { "Location" => "/other.zip" }, ""], [200, {}, good]])
scenario.("a redirect to the same address", nil, responses: [[302, { "Location" => "#{Job::API_URL}" }, ""], [200, {}, good]])
scenario.("a redirect to an address already visited", nil, responses: [[302, { "Location" => "/b.zip" }, ""], [302, { "Location" => "/b.zip" }, ""], [200, {}, good]])
scenario.("a redirect to a missing file", nil, responses: [[302, { "Location" => "/gone.zip" }, ""], [404, {}, "gone"]])
scenario.("a redirect without a location", nil, responses: [[302, {}, ""], [200, {}, good]])
scenario.("a 204 response", nil, responses: [[204, {}, ""]])
scenario.("a 206 response", nil, responses: [[206, {}, good]])
scenario.("a 308 response", nil, responses: [[308, { "Location" => "/b.zip" }, ""], [200, {}, good]])
scenario.("a 300 response", nil, responses: [[300, { "Location" => "/b.zip" }, ""], [200, {}, good]])

# Float#round(2) on its own.
rng = Random.new(52)
round_inputs = [0.0, -0.0, 0.005, 0.015, 0.025, 0.035, 0.045, 0.055, 0.065, 0.075, 0.085, 0.095, 0.105, 0.115, 0.125, 0.135, 0.145, 0.155, 0.165, 0.175, 0.185, 0.195, 1.005, 2.675, 1.115, 8.345,
                0.4, 0.8, 0.39999999999999997, 0.8000000000000002, 0.7999999999999999, 1e-7, 1e-4, 2.4e-4, 2.5e-4, 1e-300, 5e-324, 1e15, 1e16, 1e17, 1e22, 1e300, 1.7976931348623157e308, 123456789012345.67,
                -0.005, -0.015, -0.125, -2.675, -1e-7, -1e300, Float::INFINITY, -Float::INFINITY, Float::NAN]
round_inputs += Array.new(20_000) { (rng.rand * 10**rng.rand(-6..8)).then { |v| rng.rand < 0.1 ? -v : v } }
round_inputs += Array.new(10_000) { (rng.rand(1..99_999) / 1000.0) } # three decimals: many exact-looking ties
round_inputs += Array.new(10_000) { rng.rand(1..9999) / 200.0 + 0.0 } # halves of cents
round_inputs += Array.new(5_000) { (rng.rand(0..60) / 100.0).then { |v| v + (rng.rand(-2..2) * Float::EPSILON * 4) } }
round_vectors = round_inputs.map { |x| [x.nan? ? "NaN" : x.infinite? ? (x > 0 ? "Infinity" : "-Infinity") : x, (r = x.round(2)).nan? ? "NaN" : r.infinite? ? (r > 0 ? "Infinity" : "-Infinity") : r] }

now_f = travel_to(NOW, with_usec: true) { Time.now.to_f }
File.write(OUT, "{\n\"now\": #{now_f.to_json},\n\"cases\": [\n#{cases.map(&:to_json).join(",\n")}\n],\n\"round2\": [\n#{round_vectors.map(&:to_json).join(",\n")}\n]\n}\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases, #{round_vectors.size} round vectors)"
