# frozen_string_literal: true

# Writes nextjs/parity/golden/google-image-url.json: what omniauth-google-oauth2's `image_url` (the strategy's own private method, run on
# the picture of a userinfo answer) answers for a corpus of picture values, or the exception it raises. The corpus is curated cases plus a
# seeded random mix of URL pieces, so URI.parse's acceptance (RFC 3986 only, ASCII only) and the rewrite of the query are pinned by Ruby itself.
#
#   docker exec <ruby container> bundle exec ruby nextjs/parity/golden/google-image-url.rb
require "json"
require "omniauth-google-oauth2"

CURATED = [
  "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c",
  "https://lh3.googleusercontent.com/a/photo?sz=50",
  "https://lh3.googleusercontent.com/a/photo?sz=50&a=b",
  "https://lh3.googleusercontent.com/a/photo?a=b&sz=50&a=c",
  "https://lh3.googleusercontent.com/a/photo?a=b%20c&a=d",
  "https://lh3.googleusercontent.com/a/photo?a",
  "https://lh3.googleusercontent.com/a/photo?a&b=",
  "https://lh3.googleusercontent.com/a/photo?=b",
  "https://lh3.googleusercontent.com/a/photo?a=b;c=d",
  "https://lh3.googleusercontent.com/a/photo?a=b&&c=d",
  "https://lh3.googleusercontent.com/a/photo?",
  "https://lh3.googleusercontent.com/a/photo?#frag",
  "https://lh3.googleusercontent.com/a/photo#frag",
  "https://lh3.googleusercontent.com/a/photo?a=%zz",
  "https://lh3.googleusercontent.com/a/photo?a=%FF",
  "https://lh3.googleusercontent.com/a/photo?a=%E2%82%AC",
  "https://lh3.googleusercontent.com/a/photo?a=%C3",
  "https://lh3.googleusercontent.com/a/photo?a+b=c+d",
  "https://lh3.googleusercontent.com/a/photo?a=b+c&a=%2B",
  "https://lh3.googleusercontent.com/a/photo?a=*-._~!$'()",
  "https://lh3.googleusercontent.com/a/photo?a=b/c?d",
  "https://lh3.googleusercontent.com/a/photo?a[]=1&a[]=2",
  "https://lh3.googleusercontent.com/a/photo?q=a b",
  "https://lh3.googleusercontent.com/a b",
  "https://lh3.googleusercontent.com/a\tb",
  "https://lh3.googleusercontent.com/a\nb",
  "https://lh3.googleusercontent.com/a\"b",
  "https://lh3.googleusercontent.com/a\\b",
  "https://lh3.googleusercontent.com/a\u0001b",
  "https://lh3.googleusercontent.com/\#{x}",
  "https://lh3.googleusercontent.com/#\#{x}",
  "https://lh3.googleusercontent.com/a\#$b",
  "https://lh3.googleusercontent.com/\u00e9",
  "https://lh3.googleusercontent.com/\u{1F600}",
  "https://lh3.googleusercontent.com/\u200b",
  "https://lh3.googleusercontent.com/a|b",
  "https://lh3.googleusercontent.com/a{b}",
  "https://lh3.googleusercontent.com/a<b>",
  "https://lh3.googleusercontent.com/a^b",
  "https://lh3.googleusercontent.com/a`b",
  "https://lh3.googleusercontent.com/%",
  "https://lh3.googleusercontent.com/%2",
  "https://lh3.googleusercontent.com/%zz",
  "https://lh3.googleusercontent.com/%20",
  "https://lh3.googleusercontent.com:443/a",
  "https://lh3.googleusercontent.com:8443/a",
  "https://lh3.googleusercontent.com:/a",
  "https://lh3.googleusercontent.com:0443/a",
  "https://lh3.googleusercontent.com:99999/a",
  "https://lh3.googleusercontent.com:abc/a",
  "http://lh3.googleusercontent.com:80/a",
  "http://lh3.googleusercontent.com:443/a",
  "HTTPS://LH3.GoogleUserContent.com/A",
  "Https://host/a",
  "https://user@host/a",
  "https://user:pw@host/a",
  "https://user:@host/a",
  "https://:pw@host/a",
  "https://@host/a",
  "https://:@host/a",
  "https://a:b:c@host/a",
  "https://us%20er@host/a",
  "https://us er@host/a",
  "https://host",
  "https://host?a=1",
  "https://host#f",
  "https://host:443",
  "https:///a",
  "https://",
  "https:/",
  "https:",
  "https:a",
  "https:https://lh3.googleusercontent.com/a",
  "https:https:https://x/y",
  "https:httpsx",
  "//host/a",
  "//host/a?sz=1",
  "/a/photo?sz=1",
  "a/photo?sz=1",
  "photo",
  "photo.jpg",
  "./photo",
  "../photo",
  "?sz=1",
  "?a=b",
  "#f",
  "",
  " ",
  "  https://host/a",
  "https://host/a  ",
  "https://[::1]/a",
  "https://[::1]:8080/a",
  "https://[2001:db8::1]/a",
  "https://[2001:DB8::1]/a",
  "https://[::ffff:1.2.3.4]/a",
  "https://[v1.x]/a",
  "https://[::1/a",
  "https://[zz]/a",
  "https://1.2.3.4/a",
  "https://256.1.1.1/a",
  "https://1.2.3/a",
  "https://host.name_with_underscore/a",
  "https://ho$t/a",
  "https://ho,st/a",
  "https://ho!st/a",
  "https://ho~st/a",
  "https://ho%41st/a",
  "https://ho%4/a",
  "https://ho st/a",
  "https://ho@st@x/a",
  "https://host:80:90/a",
  "ftp://host/a?sz=1",
  "ftp://host:21/a",
  "ftp://host/a;type=i",
  "file:///etc/passwd",
  "file://host/etc/passwd",
  "file:/etc/passwd",
  "mailto:a@b.com",
  "mailto:a@b.com?subject=x",
  "mailto:",
  "mailto:a b",
  "mailto:a@b?sz=1",
  "ldap://host/dc=example",
  "ldap://host:389/dc=example?cn?sub",
  "ldaps://host/dc=example",
  "ws://host/a",
  "wss://host:443/a",
  "wss://host:8443/a",
  "data:image/png;base64,iVBORw0KGgo=",
  "data:,x",
  "javascript:alert(1)",
  "urn:isbn:0451450523",
  "tel:+1-555-0100",
  "x:y",
  "x://y",
  "1x://y",
  "x+y.z-w://host/p",
  "x_y://host/p",
  "s3://bucket/key",
  "custom://host:1234/p?q=1#f",
  "https://host/a/photo.jpg",
  "https://host/a//photo.jpg",
  "https://host/a/s96-c/photo.jpg",
  "https://host/a/photo.jpg?sz=50",
  "https://host/a/photo.jpg?sz=50&x=y",
  "https://host/\u0000",
  "https://host/a\u007fb",
  "https://host/a\u00a0b",
  "https://host/a\u00ffb",
  "https://host/a\u2028b",
  "https://host/a\ud7ffb"
].freeze

PIECES = {
  scheme: ["https", "http", "HTTP", "ftp", "file", "mailto", "x", "", "1a", "h t"],
  userinfo: ["", "u@", "u:p@", ":@", "@", "a:b:c@", "u%41@", "u v@", "u[@"],
  host: ["h.com", "H.COM", "1.2.3.4", "[::1]", "[::]", "[fe80::1%251]", "", "h c", "h%41", "h_", "h:1", "h!$&'()*+,;=", "-.", "999.1.1.1", "ex\u00e9.com"],
  port: ["", ":", ":80", ":443", ":0", ":00080", ":65536", ":9999999999", ":a", ":8a"],
  path: ["", "/", "/a", "/a/b", "//", "/a//b", "/a%20b", "/a%2", "/a b", "/a;b", "/a:b", "/@", "/a?b", "/photo.jpg", "/p/s96-c/photo.jpg", "/\u00e9", "/%zz", "/a|b", "/a\\b"],
  query: ["", "?", "?sz=1", "?a=b", "?a=b&sz=2&a=c", "?a", "?=", "?a=%zz", "?a=%FF", "?a=b c", "?a=\u00e9", "?a=b#c", "?%", "?a=%", "?a=+", "?a=%2B", "?a;b=c;sz=1", "?a=b&&", "?sz", "?sz=", "?SZ=1", "?a=1&a=2", "?a[b]=c", "?a=|", "?a=%00", "?a=\u0000"],
  fragment: ["", "#", "#f", "#f g", "#f#g", "#%zz", "#a/b?c", "#\u00e9", "#[x]"]
}.freeze

def build(rng)
  scheme = PIECES[:scheme].sample(random: rng)
  authority = rng.rand < 0.85
  s = +""
  s << scheme << ":" unless scheme.empty? && rng.rand < 0.3
  s << "//" << PIECES[:userinfo].sample(random: rng) << PIECES[:host].sample(random: rng) << PIECES[:port].sample(random: rng) if authority
  s << PIECES[:path].sample(random: rng)
  s << PIECES[:query].sample(random: rng) if rng.rand < 0.7
  s << PIECES[:fragment].sample(random: rng) if rng.rand < 0.3
  s
end

# Pieces that URI.parse accepts, so that most of these cases reach the rewrite of the query and `to_s`.
VALID = {
  scheme: ["https", "http", "HTTPS", "ws", "wss", "x", "custom+scheme.1"],
  userinfo: ["", "u@", "u:p@", ":@", "@", "a:b:c@", "u%41@", "us.er-n_a~me!$&'()*+,;=@"],
  host: ["lh3.googleusercontent.com", "H.COM", "1.2.3.4", "[::1]", "[2001:db8::7334]", "[::ffff:1.2.3.4]", "", "h%41", "h_x", "a-b.c"],
  port: ["", ":", ":80", ":443", ":8080", ":0", ":00080", ":65536", ":9999999999"],
  path: ["", "/", "/a", "/a/b", "//", "/a//b", "/a%20b", "/a;b=c", "/a:b", "/@", "/photo.jpg", "/p/s96-c/photo.jpg", "/a=s96-c", "/a~b_c-d.e!$&'()*+,;=:@"],
  query: ["?", "?sz=50", "?a=b", "?a=b&sz=2&a=c", "?a", "?=", "?a=%FF", "?a=%E2%82%AC", "?a=b c", "?a=b+c", "?a=%2B", "?a;b=c;sz=1", "?a=b&&", "?sz", "?sz=", "?SZ=1", "?a=1&a=2", "?a[b]=c", "?a=|", "?a=%00", "?a=\"x\"", "?a='x'", "?a=<x>", "?a=`x`", "?a=%", "?a=%2", "?%61=b", "?s%7a=1&k=v", "?a=b\tc", "?q=a/b?c#"],
  fragment: ["#", "#f", "#f g", "#f%20g", "#a/b?c", "#[x]"]
}.freeze

def build_valid(rng)
  s = +"#{VALID[:scheme].sample(random: rng)}:"
  s << "//" << VALID[:userinfo].sample(random: rng) << VALID[:host].sample(random: rng) << VALID[:port].sample(random: rng) if rng.rand < 0.9
  s << VALID[:path].sample(random: rng)
  s << VALID[:query].sample(random: rng) if rng.rand < 0.8
  s << VALID[:fragment].sample(random: rng) if rng.rand < 0.3
  s = s.sub(/\A[^:]*:/, "") if rng.rand < 0.1
  s
end

def run(input)
  strategy = OmniAuth::Strategies::GoogleOauth2.new(nil)
  strategy.instance_variable_set(:@raw_info, { "picture" => input })
  { "ok" => strategy.send(:image_url) }
rescue StandardError => e
  { "raises" => e.class.name, "message" => e.message }
end

rng = Random.new(20_261_112)
inputs = CURATED.dup
inputs.concat(Array.new(1500) { build(rng) })
inputs.concat(Array.new(4000) { build_valid(rng) })
inputs = inputs.uniq
# A lone surrogate cannot be written to JSON and cannot arrive from it, so no case holds one.
results = inputs.to_h { |input| [input, run(input)] }
out = File.expand_path("google-image-url.json", __dir__)
File.write(out, "#{JSON.pretty_generate(results)}\n")
puts "#{results.size} cases, #{results.count { |_, v| v.key?('raises') }} raise"
