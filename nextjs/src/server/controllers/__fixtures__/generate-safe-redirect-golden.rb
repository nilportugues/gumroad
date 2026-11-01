# frozen_string_literal: true

# Golden vectors for SafeRedirectPathService, CGI.escape/unescape and the class of Accept headers
# Rails reads as JSON, run through the real Ruby. Regenerate with:
#
#   RAILS_ENV=test bundle exec rails runner nextjs/src/server/controllers/__fixtures__/generate-safe-redirect-golden.rb
#
# The port answers the plain cases and hands the rest to Rails, so rails-params.test.ts checks every
# case the port does answer against what Ruby said here.
require "json"

REQUEST = Struct.new(:host).new("app.test.gumroad.com")

PATHS = [
  "/products", "/products?x=1&y=2", "/dashboard", "/library", "products", "//", "///a//b", "/", "?query=param", "?",
  "http://app.test.gumroad.com:31337/x", "http://app.test.gumroad.com/x", "https://app.test.gumroad.com/x?a=1#frag",
  "https://evil.example.com/steal?a=1", "https://evil.example.com", "https://evil.example.com/", "//evil.example.com/steal",
  "http://seller.test.gumroad.com/x", "http://seller.test.gumroad.com:31337/x", "http://test.gumroad.com/x",
  "%2Fdashboard%3Fa%3D1", "/a%2Fb", "/a%252Fb", "/%5Cevil.example.com/x", "\\\\evil.example.com/x", "/ok?next=a\\b",
  "/path#fragment", "/path?x=1#fragment", "/a+b", "/a%2Bb", "/a?b=c+d", "/a%20b", "/a b", "/é", "/%C3%A9", "/a%zz", "/a%",
  "javascript:alert(1)", "mailto:a@example.com", "http://user@host/x", "ftp://host/x", "http://[::1]/x", "HTTP://EVIL.example.com/x",
  "http://Evil.Example.com/x", "/two-factor/verify.html?token=1", "/settings/team/invitations/abc/accept?email=a%40example.com",
  "/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Ffoo&scope=edit_products", "", " ", nil, "#",
  "http://app.test.gumroad.com", "http:///x", "/a;b=c", "/a,b", "/a(b)", "/a'b", "/a!b", "/a*b", "/~user", "/a:b", "a:b", "1:2",
].freeze

safe_redirect = PATHS.flat_map do |path|
  [true, false].map do |allow_subdomain_host|
    result = begin
      { "value" => SafeRedirectPathService.new(path, REQUEST, allow_subdomain_host:).process }
    rescue StandardError => e
      { "raises" => e.class.name }
    end
    { "path" => path, "allow_subdomain_host" => allow_subdomain_host }.merge(result)
  end
end

ESCAPES = ["/two-factor?next=/dashboard", "http://host:3000/a b~c*d(e)!'", "é", "a+b c", "100%", "a&b=c", "~", "-_.", "*", "\n"].freeze
UNESCAPES = ["%2Fdashboard+x%2B%25zz%", "%C3%A9", "%2F%2f", "a+b", "%", "%4", "%41%42", "100%25", "%zz", "a%2"].freeze

File.write(
  File.join(__dir__, "safe-redirect-path.golden.json"),
  JSON.pretty_generate(
    "safe_redirect_path" => safe_redirect,
    "cgi_escape" => ESCAPES.index_with { |value| CGI.escape(value) },
    "cgi_unescape" => UNESCAPES.index_with { |value| CGI.unescape(value) },
  ) + "\n",
)
puts "ok"
