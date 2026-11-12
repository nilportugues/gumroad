# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/oauth-redirect-uri.golden.json: what Doorkeeper's URIChecker.valid_for_authorization?
# answers for a redirect_uri sent to the token endpoint against the one stored on the grant. Run it inside the Rails container:
#
#   RAILS_ENV=test bundle exec ruby bin/rails runner nextjs/scripts/golden/oauth-redirect-uri.rb
require "json"

REGISTERED = [
  "https://app.example.com/callback",
  "https://app.example.com/callback?tab=1&x=2",
  "https://app.example.com",
  "HTTPS://App.Example.com:443/callback",
  "http://localhost:3000/callback",
  "http://127.0.0.1:3000/callback",
  "http://127.0.0.1/callback",
  "com.example.app:/oauth2redirect",
  "com.example.app://callback",
  "urn:ietf:wg:oauth:2.0:oob",
  "https://app.example.com/a%20b",
  "https://user@app.example.com/callback",
  "https://app.example.com/callback https://other.example.net/cb"
].freeze

REQUESTED = [
  "https://app.example.com/callback",
  "https://app.example.com/callback/",
  "https://app.example.com/Callback",
  "https://APP.example.com/callback",
  "https://app.example.com:443/callback",
  "https://app.example.com:8443/callback",
  "http://app.example.com/callback",
  "https://app.example.com/callback?extra=1",
  "https://app.example.com/callback?x=2&tab=1",
  "https://app.example.com/callback?tab=1",
  "https://app.example.com/callback#frag",
  "https://app.example.com",
  "https://app.example.com/",
  "https://other.example.net/cb",
  "http://localhost:3000/callback",
  "http://localhost:4000/callback",
  "http://127.0.0.1:4000/callback",
  "http://127.0.0.1/callback",
  "http://127.0.0.1:3000/other",
  "com.example.app:/oauth2redirect",
  "com.example.app:/oauth2redirect?code=1",
  "com.example.app://callback",
  "COM.EXAMPLE.APP:/oauth2redirect",
  "localhost:3000/callback",
  "urn:ietf:wg:oauth:2.0:oob",
  "urn:ietf:wg:oauth:2.0:oob:auto",
  "https://app.example.com/a%20b",
  "https://app.example.com/a b",
  "https://user@app.example.com/callback",
  "https://app.example.com/callback ",
  "/callback",
  "callback",
  "https:///callback",
  "https://",
  "",
  "https://app.example.com/callback\n",
  "https://app.example.com/café",
  "https://app.example.com/callback|x",
  "https://[::1]:3000/callback",
  "mailto:a@example.com",
  "ftp://app.example.com/callback"
].freeze

checker = Doorkeeper::OAuth::Helpers::URIChecker
cases = REGISTERED.flat_map do |registered|
  REQUESTED.map do |requested|
    result = begin
      checker.valid_for_authorization?(requested, registered)
    rescue => e
      { "$raises" => e.class.name }
    end
    { "requested" => requested, "registered" => registered, "result" => result }
  end
end

File.write(Rails.root.join("nextjs/src/server/models/__fixtures__/oauth-redirect-uri.golden.json"), JSON.pretty_generate(cases) + "\n")
puts cases.size
