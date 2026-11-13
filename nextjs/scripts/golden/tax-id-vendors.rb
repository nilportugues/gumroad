# frozen_string_literal: true

# Produces nextjs/src/server/tax/__fixtures__/tax-id-vendors.golden.json: the tax-id validators that call a vendor (IRAS GST, Revenu
# Quebec QST, taxid.pro, Vatstack ABN and MVA, VIES through valvat) run through the real classes, each case twice in a row to
# record the ten-minute Rails.cache memo. The vendor is a WebMock stand-in answering from the case (capture_http!); nothing leaves
# the machine and the credentials are fake. Each run records the request (method, url, headers, body) in call order, the cache keys
# written, and what `process` returned or raised. A dropped connection is `Errno::ECONNRESET`.
#
# Run it in the lane container (as tax-id-validators.rb; `IRAS_API_ID=iras-id`, `IRAS_API_SECRET=iras-secret`,
# `VATSTACK_API_KEY=vatstack-key`, `TAX_ID_PRO_API_KEY=taxid-key`):
#
#   bundle exec rails runner nextjs/scripts/golden/tax-id-vendors.rb
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/server/tax/__fixtures__/tax-id-vendors.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
Rails.logger = ActiveSupport::Logger.new(nil)

JSON_TYPE = { "Content-Type" => "application/json" }.freeze

# The URL string HTTParty is handed (WebMock re-normalizes the one it records) and the options it gets, such as `timeout`.
HTTPARTY_CALLS = []
HTTParty.singleton_class.prepend(Module.new do
  %i[get post].each do |verb|
    define_method(verb) do |url, options = {}, &block|
      HTTPARTY_CALLS << { "verb" => verb.to_s, "url" => url, "options" => options.slice(:timeout, :headers, :body).transform_keys(&:to_s) }
      super(url, options, &block)
    end
  end
end)

def json(status, body, headers: JSON_TYPE) = { status:, body: body.is_a?(String) ? body : body.to_json, headers: }

def run(name, service, args, *responses)
  results = []
  HTTPARTY_CALLS.clear
  result = capture(name, now: NOW, tables: [], http_responses: responses, service: service.name, args:) do
    2.times do
      results << { "value" => service.new(*args).process }
    rescue StandardError => e
      results << { "raised" => e.class.name }
    end
  end
  %w[seed statements redis rows].each { result.delete(_1) }
  result["results"] = results
  result["httparty"] = HTTPARTY_CALLS.dup
  result
end

cases = []

# IRAS GST (Singapore): POST with the id in the JSON body and the credentials in headers
gst = ->(status, data) { json(200, { returnCode: status, data: }) }
cases << run("a registered GST id", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }))
cases << run("a deregistered GST id", GstValidationService, ["M12345678X"], gst.call("10", { Status: "De-Registered" }))
cases << run("a status in lower case", GstValidationService, ["M12345678X"], gst.call("10", { Status: "registered" }))
cases << run("a return code other than 10", GstValidationService, ["M12345678X"], json(200, { returnCode: "20", data: { Status: "Registered" } }))
cases << run("an integer return code", GstValidationService, ["M12345678X"], json(200, { returnCode: 10, data: { Status: "Registered" } }))
cases << run("a return code with no data", GstValidationService, ["M12345678X"], json(200, { returnCode: "20" }))
cases << run("return code 10 with no data", GstValidationService, ["M12345678X"], json(200, { returnCode: "10" }))
cases << run("return code 10 with null data", GstValidationService, ["M12345678X"], json(200, { returnCode: "10", data: nil }))
cases << run("return code 10 with a status that is null", GstValidationService, ["M12345678X"], gst.call("10", { Status: nil }))
cases << run("return code 10 with a data array", GstValidationService, ["M12345678X"], gst.call("10", []))
cases << run("an empty object", GstValidationService, ["M12345678X"], json(200, {}))
cases << run("a JSON null", GstValidationService, ["M12345678X"], json(200, "null"))
cases << run("a JSON array", GstValidationService, ["M12345678X"], json(200, "[]"))
cases << run("a 500 answer", GstValidationService, ["M12345678X"], json(500, { returnCode: "30" }))
cases << run("a 401 answer with a registered body", GstValidationService, ["M12345678X"], json(401, { returnCode: "10", data: { Status: "Registered" } }))
cases << run("a body that is not JSON", GstValidationService, ["M12345678X"], json(200, "not json"))
cases << run("an empty body", GstValidationService, ["M12345678X"], json(200, ""))
cases << run("a JSON answer typed text/plain", GstValidationService, ["M12345678X"], json(200, { returnCode: "10", data: { Status: "Registered" } }, headers: { "Content-Type" => "text/plain" }))
cases << run("a JSON answer with no content type", GstValidationService, ["M12345678X"], json(200, { returnCode: "10", data: { Status: "Registered" } }, headers: {}))
cases << run("a dropped connection", GstValidationService, ["M12345678X"], { dropped: true })
cases << run("data that is a string", GstValidationService, ["M12345678X"], gst.call("10", "Registered"))
cases << run("data that is a number", GstValidationService, ["M12345678X"], gst.call("10", 1))
cases << run("data that is true", GstValidationService, ["M12345678X"], gst.call("10", true))
cases << run("a JSON number", GstValidationService, ["M12345678X"], json(200, "1"))
cases << run("a JSON true", GstValidationService, ["M12345678X"], json(200, "true"))
cases << run("a JSON string", GstValidationService, ["M12345678X"], json(200, '"10"'))
cases << run("a registered answer typed text/javascript", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }).merge(headers: { "Content-Type" => "text/javascript" }))
cases << run("a registered answer typed application/json with a charset", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }).merge(headers: { "Content-Type" => "application/json; charset=utf-8" }))
cases << run("a registered answer typed in capitals", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }).merge(headers: { "Content-Type" => "Application/JSON" }))
cases << run("a registered answer typed application/hal+json", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }).merge(headers: { "Content-Type" => "application/hal+json" }))
cases << run("a registered answer typed text/html", GstValidationService, ["M12345678X"], gst.call("10", { Status: "Registered" }).merge(headers: { "Content-Type" => "text/html" }))
cases << run("a blank id", GstValidationService, [" "])
cases << run("a nil id", GstValidationService, [nil])
cases << run("an id with quotes and a backslash", GstValidationService, ["M\"1\\2"], gst.call("10", { Status: "Registered" }))
cases << run("an id with a newline and a non-ASCII character", GstValidationService, ["M1\né"], gst.call("10", { Status: "Registered" }))
cases << run("an id with angle brackets and an ampersand", GstValidationService, ["<M&1>"], gst.call("10", { Status: "Registered" }))
cases << run("an integer id", GstValidationService, [12_345], gst.call("10", { Status: "Registered" }))
cases << run("a lower-case id", GstValidationService, ["m12345678x"], gst.call("10", { Status: "Registered" }))

# Revenu Quebec QST: GET with the id in the path
qst = ->(status) { json(200, { Resultat: { StatutSousDossierUsager: status } }) }
cases << run("a registered QST id", QstValidationService, ["1234567890TQ0001"], qst.call("R"))
cases << run("a QST id with another status", QstValidationService, ["1234567890TQ0001"], qst.call("A"))
cases << run("a QST status in lower case", QstValidationService, ["1234567890TQ0001"], qst.call("r"))
cases << run("a 404 answer with a registered body", QstValidationService, ["1234567890TQ0001"], json(404, { Resultat: { StatutSousDossierUsager: "R" } }))
cases << run("a 500 answer", QstValidationService, ["1234567890TQ0001"], json(500, "{}"))
cases << run("a 204 answer", QstValidationService, ["1234567890TQ0001"], json(204, ""))
cases << run("an answer with no Resultat", QstValidationService, ["1234567890TQ0001"], json(200, {}))
cases << run("an answer whose Resultat is null", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: nil }))
cases << run("an answer whose Resultat is a string", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: "R" }))
cases << run("an answer that is a JSON string", QstValidationService, ["1234567890TQ0001"], json(200, '"R"'))
cases << run("an answer that is an array", QstValidationService, ["1234567890TQ0001"], json(200, "[]"))
cases << run("a body that is not JSON", QstValidationService, ["1234567890TQ0001"], json(200, "not json"))
cases << run("a registered answer typed text/plain", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: { StatutSousDossierUsager: "R" } }, headers: { "Content-Type" => "text/plain" }))
cases << run("a registered answer typed text/xml", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: { StatutSousDossierUsager: "R" } }, headers: { "Content-Type" => "text/xml" }))
cases << run("a registered answer with no content type", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: { StatutSousDossierUsager: "R" } }, headers: {}))
cases << run("a dropped connection", QstValidationService, ["1234567890TQ0001"], { dropped: true })
cases << run("a blank id", QstValidationService, [""])
cases << run("an id with a space", QstValidationService, ["1234 567890"], qst.call("R"))
cases << run("an id with a slash", QstValidationService, ["1234/567890"], qst.call("R"))
cases << run("an id with a question mark and a hash", QstValidationService, ["12?34#56"], qst.call("R"))
cases << run("an id with a percent sign", QstValidationService, ["12%34"], qst.call("R"))
cases << run("an id with non-ASCII characters", QstValidationService, ["12é日34"], qst.call("R"))
cases << run("an id with reserved characters", QstValidationService, ["a+b&c=d;e,f:g@h$i!j*k(l)m'n[o]"], qst.call("R"))
cases << run("an id with dots and tildes", QstValidationService, ["a.b~c-d_e"], qst.call("R"))
cases << run("an id with a dot-dot segment", QstValidationService, ["../x"], qst.call("R"))
cases << run("an id with every other printable ASCII character", QstValidationService, ["\"<>\\^`{|}"], qst.call("R"))
cases << run("an id with a control character", QstValidationService, ["a\tb\u007fc"], qst.call("R"))
cases << run("an answer that is a JSON null", QstValidationService, ["1234567890TQ0001"], json(200, "null"))
cases << run("an empty 200 body", QstValidationService, ["1234567890TQ0001"], json(200, ""))
cases << run("a Resultat that is a number", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: 1 }))
cases << run("a Resultat that is an array", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: [] }))
cases << run("a status that is not a string", QstValidationService, ["1234567890TQ0001"], qst.call(1))
cases << run("a registered answer typed application/json with a charset", QstValidationService, ["1234567890TQ0001"], json(200, { Resultat: { StatutSousDossierUsager: "R" } }, headers: { "Content-Type" => "application/json; charset=utf-8" }))
cases << run("an integer id", QstValidationService, [1_234_567_890], qst.call("R"))

# taxid.pro: GET with the country and the tax id in the query, a bearer token
tax_id = ->(valid) { json(200, { is_valid: valid }) }
cases << run("a valid taxid.pro id", TaxIdValidationService, ["123456789", "ZA"], tax_id.call(true))
cases << run("an invalid taxid.pro id", TaxIdValidationService, ["123456789", "ZA"], tax_id.call(false))
cases << run("is_valid null", TaxIdValidationService, ["123456789", "ZA"], tax_id.call(nil))
cases << run("is_valid missing", TaxIdValidationService, ["123456789", "ZA"], json(200, {}))
cases << run("is_valid as a string", TaxIdValidationService, ["123456789", "ZA"], tax_id.call("true"))
cases << run("is_valid as the string false", TaxIdValidationService, ["123456789", "ZA"], tax_id.call("false"))
cases << run("is_valid as zero", TaxIdValidationService, ["123456789", "ZA"], tax_id.call(0))
cases << run("is_valid as an array", TaxIdValidationService, ["123456789", "ZA"], tax_id.call([]))
cases << run("a valid body with a 400 status", TaxIdValidationService, ["123456789", "ZA"], json(400, { is_valid: true }))
cases << run("a valid body with a 401 status", TaxIdValidationService, ["123456789", "ZA"], json(401, { is_valid: true }))
cases << run("a valid body with a 201 status", TaxIdValidationService, ["123456789", "ZA"], json(201, { is_valid: true }))
cases << run("a 500 answer", TaxIdValidationService, ["123456789", "ZA"], json(500, "{}"))
cases << run("a body that is not JSON", TaxIdValidationService, ["123456789", "ZA"], json(200, "not json"))
cases << run("a JSON array", TaxIdValidationService, ["123456789", "ZA"], json(200, "[]"))
cases << run("a JSON string", TaxIdValidationService, ["123456789", "ZA"], json(200, '"x"'))
cases << run("a valid answer typed text/plain", TaxIdValidationService, ["123456789", "ZA"], json(200, { is_valid: true }, headers: { "Content-Type" => "text/plain" }))
cases << run("a valid answer with no content type", TaxIdValidationService, ["123456789", "ZA"], json(200, { is_valid: true }, headers: {}))
cases << run("a dropped connection", TaxIdValidationService, ["123456789", "ZA"], { dropped: true })
cases << run("a JSON null", TaxIdValidationService, ["123456789", "ZA"], json(200, "null"))
cases << run("an empty 200 body", TaxIdValidationService, ["123456789", "ZA"], json(200, ""))
cases << run("a JSON number", TaxIdValidationService, ["123456789", "ZA"], json(200, "1"))
cases << run("a JSON string that holds is_valid", TaxIdValidationService, ["123456789", "ZA"], json(200, '"is_valid"'))
cases << run("a text/plain answer without is_valid", TaxIdValidationService, ["123456789", "ZA"], json(200, "ok", headers: { "Content-Type" => "text/plain" }))
cases << run("a valid answer typed application/json with a charset", TaxIdValidationService, ["123456789", "ZA"], json(200, { is_valid: true }, headers: { "Content-Type" => "application/json; charset=utf-8" }))
cases << run("an id with every other printable ASCII character", TaxIdValidationService, ["\"<>\\^`{|}'()*!$,;:@=[]", "ZA"], tax_id.call(true))
cases << run("an id with a control character", TaxIdValidationService, ["a\tb\u007fc", "ZA"], tax_id.call(true))
cases << run("a blank id", TaxIdValidationService, ["", "ZA"])
cases << run("a nil id", TaxIdValidationService, [nil, "ZA"])
cases << run("a blank country", TaxIdValidationService, ["123456789", ""])
cases << run("a nil country", TaxIdValidationService, ["123456789", nil])
cases << run("an id with a space", TaxIdValidationService, ["1234 5678", "ZA"], tax_id.call(true))
cases << run("an id with an ampersand and an equals sign", TaxIdValidationService, ["12&tin=3", "ZA"], tax_id.call(true))
cases << run("an id with a hash", TaxIdValidationService, ["12#3", "ZA"], tax_id.call(true))
cases << run("an id with a plus sign and a slash", TaxIdValidationService, ["12+3/4", "ZA"], tax_id.call(true))
cases << run("an id with non-ASCII characters", TaxIdValidationService, ["12é3", "ZA"], tax_id.call(true))
cases << run("a lower-case country", TaxIdValidationService, ["123456789", "za"], tax_id.call(true))
cases << run("a country with a space", TaxIdValidationService, ["123456789", "Z A"], tax_id.call(true))
cases << run("a country that is not a code", TaxIdValidationService, ["123456789", "ZA&x=1"], tax_id.call(true))
cases << run("an id with a percent sign", TaxIdValidationService, ["12%3", "ZA"], tax_id.call(true))
cases << run("an id with a newline", TaxIdValidationService, ["12\n3", "ZA"], tax_id.call(true))

# Vatstack (ABN and MVA): POST of a form body; the cache holds the whole HTTParty::Response, so Node does not serve these
vatstack = ->(body) { json(200, body) }
[[AbnValidationService, "12345678901"], [MvaValidationService, "123456789MVA"]].each do |service, id|
  cases << run("#{service.name} valid and active", service, [id], vatstack.call({ valid: true, active: true }))
  cases << run("#{service.name} valid and inactive", service, [id], vatstack.call({ valid: true, active: false }))
  cases << run("#{service.name} invalid", service, [id], vatstack.call({ valid: false, active: false }))
  cases << run("#{service.name} valid with no active", service, [id], vatstack.call({ valid: true }))
  cases << run("#{service.name} valid null", service, [id], vatstack.call({ valid: nil }))
  cases << run("#{service.name} invalid input", service, [id], vatstack.call({ code: "INVALID_INPUT", valid: true, active: true }))
  cases << run("#{service.name} a dropped connection", service, [id], { dropped: true })
  cases << run("#{service.name} a blank id", service, [nil])
end

# What HTTParty reads before it looks at the type: a BOM, a blank body, the literal null
bom = "\u{feff}"
[["a BOM before the JSON", "#{bom}%s"], ["blank padding around the JSON", "\n\t %s \n"], ["a NaN inside the JSON", "%s"]].each do |label, template|
  gst_body = template % '{"returnCode":"10","data":{"Status":"Registered"}}'
  gst_body = '{"returnCode":"10","data":{"Status":NaN}}' if label.include?("NaN")
  cases << run("GST with #{label}", GstValidationService, ["M12345678X"], json(200, gst_body))
  qst_body = template % '{"Resultat":{"StatutSousDossierUsager":"R"}}'
  cases << run("QST with #{label}", QstValidationService, ["1234567890TQ0001"], json(200, qst_body))
  tax_body = template % '{"is_valid":true}'
  cases << run("taxid.pro with #{label}", TaxIdValidationService, ["123456789", "ZA"], json(200, tax_body))
end
["   ", "\n", "null", " null"].each do |body|
  cases << run("GST with the body #{body.inspect}", GstValidationService, ["M12345678X"], json(200, body))
  cases << run("QST with the body #{body.inspect}", QstValidationService, ["1234567890TQ0001"], json(200, body))
  cases << run("taxid.pro with the body #{body.inspect}", TaxIdValidationService, ["123456789", "ZA"], json(200, body))
  cases << run("taxid.pro with the plain-text body #{body.inspect}", TaxIdValidationService, ["123456789", "ZA"], json(200, body, headers: { "Content-Type" => "text/plain" }))
end

# HTTParty picks the parser from the exact Content-Type: these decide whether an answer is read as JSON or as a bare String
[
  "text/json", "application/vnd.api+json", "application/ld+json", "application/javascript", "application/json;charset=utf-8", " application/json",
  "application/json ", "application/jsonx", "application/xml", "text/csv", "application/x-www-form-urlencoded", "APPLICATION/JSON"
].each do |type|
  answer = ->(body) { json(200, body, headers: { "Content-Type" => type }) }
  cases << run("GST typed #{type}", GstValidationService, ["M12345678X"], answer.call({ returnCode: "10", data: { Status: "Registered" } }))
  cases << run("QST typed #{type}", QstValidationService, ["1234567890TQ0001"], answer.call({ Resultat: { StatutSousDossierUsager: "R" } }))
  cases << run("taxid.pro typed #{type}", TaxIdValidationService, ["123456789", "ZA"], answer.call({ is_valid: true }))
end

File.write(OUT, "#{JSON.pretty_generate(cases)}\n")
puts "wrote #{OUT} (#{cases.size} cases)"
