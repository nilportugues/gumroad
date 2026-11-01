# frozen_string_literal: true

# Golden vectors for nextjs/src/server/infra/geo-ip.ts: runs the real lib/utilities/geo_ip.rb over the
# maxmind-geoip2 gem's GeoLite2-City test database (copied to infra/__fixtures__) for a list of
# addresses, including malformed ones, and records what GeoIp.lookup answers.
#
# Run from the repo root:
#   bundle exec ruby nextjs/scripts/golden/geo-ip.rb
require "json"
require "active_support"
require "active_support/core_ext/object/try"
require "maxmind/geoip2"

ROOT = File.expand_path("../../..", __dir__)
DATABASE = File.join(ROOT, "nextjs/src/server/infra/__fixtures__/GeoLite2-City-Test.mmdb")
OUT = File.join(ROOT, "nextjs/src/server/infra/__fixtures__/geo-ip.golden.json")

GEOIP = MaxMind::GeoIP2::Reader.new(database: DATABASE)
require File.join(ROOT, "lib/utilities/geo_ip")

IPS = [
  "81.2.69.142", "81.2.69.160", "81.2.69.144", "81.2.69.192", "2.125.160.216", "89.160.20.112", "89.160.20.128",
  "216.160.83.56", "216.160.83.63", "67.43.156.0", "175.16.199.0", "202.196.224.0", "149.101.100.0",
  "2001:230::1", "2001:230:ffff::1", "2a02:ff80::1", "2a02:ffc0::1", "::ffff:81.2.69.142", "::ffff:2.125.160.216",
  "::1", "::", "127.0.0.1", "10.0.0.1", "0.0.0.0", "255.255.255.255", "1.1.1.1", "8.8.8.8",
  "81.2.69.142/24", "81.2.69.142/32", "2001:230::1/32", "81.2.69.142/33", "81.2.69.142/x",
  "81.2.69.142 ", " 81.2.69.142", "81.2.69.0142", "081.2.69.142", "81.2.69", "81.2.69.256", "81.2.69.142.1",
  "not-an-ip", "", "fe80::1%eth0", "2001:230::1%eth0", "[2001:230::1]", "0x51.2.69.142", "1234567890",
  nil
].freeze

results = IPS.map do |ip|
  result = GeoIp.lookup(ip)
  { "ip" => ip, "result" => result && {
    "countryName" => result.country_name, "countryCode" => result.country_code, "regionName" => result.region_name,
    "cityName" => result.city_name, "postalCode" => result.postal_code, "latitude" => result.latitude,
    "longitude" => result.longitude
  } }
end

File.write(OUT, JSON.pretty_generate(results) + "\n")
puts "#{results.size} lookups, #{results.count { _1["result"] }} found"
