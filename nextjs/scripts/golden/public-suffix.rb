# frozen_string_literal: true

# Writes nextjs/src/server/models/concerns/public-suffix-list.generated.json (the rules of the
# public_suffix gem's bundled list, in the order List.parse adds them) and
# concerns/__fixtures__/public-suffix.golden.json (PublicSuffix.valid? and .parse over hosts that
# exercise normal, wildcard, exception, private and default rules).
#
#   bundle exec ruby nextjs/scripts/golden/public-suffix.rb
gem "public_suffix", "5.1.1"
require "json"
require "public_suffix"

ROOT = File.expand_path("../../..", __dir__)
LIST_OUT = File.join(ROOT, "nextjs/src/server/models/concerns/public-suffix-list.generated.json")
GOLDEN_OUT = File.join(ROOT, "nextjs/src/server/models/concerns/__fixtures__/public-suffix.golden.json")

rules = []
File.read(PublicSuffix::List::DEFAULT_LIST_PATH).each_line do |line|
  line = line.strip
  next if line.empty? || line.start_with?("//")

  rules << line
end
File.write(LIST_OUT, JSON.generate({ "version" => PublicSuffix::VERSION, "rules" => rules }) + "\n")

HOSTS = [
  "example.com", "www.example.com", "shop.example.com", "a.b.example.com", "Example.COM.", " example.com ",
  "example.co.uk", "www.example.co.uk", "shop.example.co.uk", "co.uk", "com", "uk", "",
  ".example.com", "http://example.com", "foo.bar.ck", "bar.ck", "www.ck", "www.www.ck", "ck",
  "kawasaki.jp", "city.kawasaki.jp", "foo.city.kawasaki.jp", "example.kawasaki.jp", "a.example.kawasaki.jp",
  "foo.github.io", "github.io", "www.foo.github.io", "example.unknowntld", "www.example.unknowntld",
  "localhost", "test.gumroad.com", "gumroad.com", "192.168.0.1", "例え.テスト", "xn--r8jz45g.xn--zckzah",
  "sub.example.blogspot.com", "example.s3.amazonaws.com", "foo.compute-1.amazonaws.com",
]

vectors = HOSTS.map do |host|
  parsed =
    begin
      d = PublicSuffix.parse(host)
      { "tld" => d.tld, "sld" => d.sld, "trd" => d.trd, "domain" => d.domain }
    rescue PublicSuffix::Error => e
      { "error" => e.class.name }
    end
  { "host" => host, "valid" => PublicSuffix.valid?(host), "parse" => parsed }
end
File.write(GOLDEN_OUT, JSON.pretty_generate(vectors) + "\n")
puts "wrote #{rules.size} rules and #{vectors.size} vectors"
