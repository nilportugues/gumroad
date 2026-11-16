# frozen_string_literal: true

# Produces nextjs/src/server/tax/__fixtures__/tax-id-validators.golden.json: the offline tax-id validators (Oman, Bahrain, Kenya,
# Nigeria, Tanzania) run through the real classes on edge-case ids, and RegionalVatIdValidationService#process routed over every
# country, state and a blank id, recording which service ran (a prepended recorder) and what it answered. Outbound HTTP is a WebMock
# stand-in that answers an empty JSON object (capture_http!): nothing leaves the machine and the routing cases only need to know who was called.
#
# Run it in the lane container (env file under tmp/, `USE_DB_WORKER_REPLICAS=true`, fake `IRAS_API_ID`, `IRAS_API_SECRET`,
# `VATSTACK_API_KEY`, `TAX_ID_PRO_API_KEY`):
#
#   bundle exec rails runner nextjs/scripts/golden/tax-id-validators.rb
require_relative "support/rails_cases"
include RailsCases
capture_http!
HttpCapture.responder = ->(*) { { status: 200, body: "{}", headers: { "Content-Type" => "application/json" } } }

OUT = Rails.root.join("nextjs/src/server/tax/__fixtures__/tax-id-validators.golden.json")
Rails.logger = ActiveSupport::Logger.new(nil)

CALLS = []
SERVICES = [OmanVatNumberValidationService, TrnValidationService, KraPinValidationService, FirsTinValidationService, TraTinValidationService,
            AbnValidationService, GstValidationService, QstValidationService, MvaValidationService, TaxIdValidationService, VatValidationService].freeze
SERVICES.each do |klass|
  klass.prepend(Module.new do
    define_method(:process) do |*args|
      CALLS << klass.name
      super(*args)
    end
  end)
end

IDS = [
  nil, "", " ", "  ", "\n", "\t", "\u00a0", "\u3000", "\u0085", "\u200b", "\0", "\ufeff", "\u180e", "\u1680", "\u2000", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f",
  *%W[\ufeff \u180e \u00a0 \u1680 \u2000 \u200a \u2028 \u202f \u205f \u3000 \u0085 \u200b].map { |space| space * 15 },
  "OM1234567890", "OM123456789", "OM12345678901", "om1234567890", "OM1234567890\n", "\nOM1234567890", "OM1234567890 ", " OM1234567890",
  "OM123456789\n0", "OM\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660", "OMOMOMOMOMOM", "OM１２３４５６７８９０",
  "123456789012345", "12345678901234", "1234567890123456", "abcdefghijklmno", "ééééééééééééééé", "日本語日本語日本語日本語日本語", "123456789012345\n",
  "12345678901234\n", "1234567890123 5", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "      123456789",
  "A123456789Z", "a123456789Z", "A123456789z", "A12345678Z", "A1234567890Z", "AA23456789Z", "A123456789Z\n", "\nA123456789Z", "A123456789\nZ", "A12345678\u0669Z",
  "12345678-1234", "1234567-1234", "12345678-123", "12345678-12345", "12345678–1234", "12345678-1234\n", "\n12345678-1234", "x\n12345678-1234\ny",
  "12345678-1234\nfoo", "foo\n12345678-1234", "12345678-1234 ", "123456789-1234", "12345678-１２３４", "12345678_1234",
  "12-345678-A", "12-345678-a", "1-345678-A", "12-34567-A", "12-3456789-A", "12-345678-AB", "12-345678-A\n", "\n12-345678-A", "12-345678-A\nfoo", "12-345678-É",
  "bad", "0", "-", "ZZ"
].freeze

LOCAL = {
  "oman" => OmanVatNumberValidationService, "bahrain" => TrnValidationService, "kenya" => KraPinValidationService,
  "nigeria" => FirsTinValidationService, "tanzania" => TraTinValidationService
}.freeze

validators = LOCAL.transform_values do |klass|
  IDS.map { |id| { "id" => id, "valid" => klass.new(id).process } }
end

routes = []
countries = ISO3166::Country.codes.sort
states = [nil, "QC", "ON", "WA", "qc", "", "CA"]
route = lambda do |id, country, state|
  CALLS.clear
  HttpCapture.requests.clear
  Rails.cache.clear
  result = RegionalVatIdValidationService.new(id, country_code: country, state_code: state).process
  routes << { "id" => id, "country" => country, "state" => state, "service" => CALLS.first, "result" => result }
end
countries.each { |country| route.call("123456789012345", country, nil) }
%w[AU SG CA NO BH KE NG TZ OM DE GB US JP].each do |country|
  states.each { |state| route.call("A123456789Z", country, state) }
end
[nil, "", " ", "\n", "OM1234567890"].each { |id| %w[AU OM DE].each { |country| route.call(id, country, nil) } }
route.call("OM1234567890", nil, nil)
route.call("OM1234567890", "", nil)
route.call("OM1234567890", "om", nil)
route.call("12-345678-A", "TZ", nil)
route.call("12345678-1234", "NG", nil)
route.call("A123456789Z", "KE", nil)

File.write(OUT, "#{JSON.pretty_generate({ "validators" => validators, "routes" => routes })}\n")
puts "wrote #{OUT} (#{validators.sum { |_, v| v.size }} validator cases, #{routes.size} routes)"
