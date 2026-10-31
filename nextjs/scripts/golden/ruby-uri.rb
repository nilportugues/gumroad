# frozen_string_literal: true

# Golden vectors for nextjs/src/server/models/concerns/ruby-uri.ts: what URI.parse returns (scheme,
# host) or raises for hand-picked edge cases plus seeded random strings built from URI pieces.
#
#   ruby nextjs/scripts/golden/ruby-uri.rb
require "json"
require "uri"

OUT = File.expand_path("../../src/server/models/concerns/__fixtures__/ruby-uri.golden.json", __dir__)

CASES = [
  "https://seller.gumroad.com", "https://Seller.Gumroad.COM/x?y#z", "http://my-shop.gumroad.com",
  "https://bad host.gumroad.com", "https://a_b.gumroad.com", "https://user:pw@host:8080/p",
  "https://host:", "https://host:abc", "https://[::1]:3000/", "https://[v1.fe]", "https://[::1",
  "https://1.2.3.4", "https://1.2.3.456", "https://256.1.1.1", "https://%41.com", "https://%zz.com",
  "https://h.com/?a=%zz", "https://h.com/?a=%z1", "https://h.com/?a=b c", "https://h.com/#a b",
  "https://h.com/#%zz", "https://", "https:///path", "://foo", "foo/bar://x", "a://b", "1a://b",
  "https://h\u00e9.com", "https://h.com/\u00e9", "mailto://a@b.com", "mailto://h.com?x=1",
  "mailto:a@b.com?://", "mailto:foo://bar", "MAILTO://h?subject=x", "ftp://h.com/x;type=a",
  "ftp:x://y", "ldap://h.com/dc=x#frag", "ldap://h.com/dc=x", "ldaps://h.com#", "ldap:x://y",
  "file://localhost/etc", "file:///etc", "file://h.com/x", "ws://h.com", "wss://H.com",
  "https://h.com/a\tb", "https://h.com/?a\tb", "https://h.com?%2", "https://h.com\\x",
  "https://h.com/#a#b", "x:y://z", "https://-.gumroad.com", "https://.gumroad.com",
  "https://a..b", "https://a~b!$&'()*+,;=.com", "https://h.com:80:90", "https://@h.com",
  "https://a@b@c.com", "https://h.com/%", "https://[1:2:3:4:5:6:7:8]", "https://[::ffff:1.2.3.4]",
  "https://[1::2:3:4:5:6:7]", "https://[1:2:3:4:5:6:1.2.3.4]", "https://[1::1.2.3.4]",
  "https://[::a:b:c:d:1.2.3.4]",
].freeze

PIECES = [
  "https://", "://", "http:", "mailto:", "ftp:", "ldap:", "file:", "a", "B", "z9", ".", "-", "_",
  "~", "%", "%2F", "%zz", "%z1", "@", ":", "80", "/", "//", "?", "#", "[", "]", "::1", "v1.x",
  "1.2.3.4", " ", "\t", "\n", "\u00e9", "localhost", "x@y", ",", ";", "=", "&", "'", "\\", "\"",
  "{", "}", "|", "^", "`",
].freeze

def outcome(input)
  uri = URI.parse(input)
  { "input" => input, "scheme" => uri.scheme, "host" => uri.host }
rescue URI::Error => e
  { "input" => input, "error" => { "class" => e.class.name, "message" => e.message } }
end

random = Random.new(42)
# Half start with a scheme, as the job's input always does once it is prefixed.
fuzz = Array.new(4000) { |i| (i.even? ? "https://" : "") + Array.new(random.rand(1..8)) { PIECES[random.rand(PIECES.size)] }.join }
vectors = (CASES + fuzz).uniq.map { outcome(_1) }

File.write(OUT, JSON.pretty_generate({ "ruby" => RUBY_VERSION, "uri" => URI::VERSION, "vectors" => vectors }) + "\n")
warn "Wrote #{vectors.size} vectors"
