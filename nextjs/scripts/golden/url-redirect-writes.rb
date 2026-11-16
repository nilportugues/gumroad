# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/url-redirect-writes.golden.json: Purchase#create_url_redirect!
# (UrlRedirect.create! with its token validation) run by the real models on the real mysql2 driver
# against a scratch database. Run it like user-writes.rb (see support/rails_cases.rb for what a case records).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/url-redirect-writes.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[purchases url_redirects links users].freeze
IS_GIFT_SENDER_PURCHASE = 1 << 6
IS_RENTAL = 1 << 14
IS_COMMISSION_COMPLETION_PURCHASE = 1 << 29

# UrlRedirect.generate_new_token is SecureRandom.hex: pin it so the INSERT is reproducible.
$token_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def hex(n = nil)
    return super unless n.nil?

    $token_seq += 1
    format("%032x", $token_seq)
  end
end)

def purchase_row(id, **overrides)
  { id:, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, **overrides)
  { id:, user_id: 1, name: "Product #{id}", unique_permalink: "perm#{id}", price_cents: 100, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, seed: {}, &block)
  $token_seq = 0
  capture(name, now: NOW, tables: TABLES, seed:, &block)
end

cases = []
base = { links: [link_row(1)] }

cases << run("creates the redirect", seed: base.merge(purchases: [purchase_row(1)])) { Purchase.find(1).create_url_redirect! }
cases << run("creates a rental redirect", seed: base.merge(purchases: [purchase_row(1, flags: IS_RENTAL)])) { Purchase.find(1).create_url_redirect! }
cases << run("keeps an existing redirect", seed: base.merge(purchases: [purchase_row(1)], url_redirects: [{ id: 1, purchase_id: 1, token: "existing", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }])) do
  Purchase.find(1).create_url_redirect!
end
cases << run("skips a gift sender purchase", seed: base.merge(purchases: [purchase_row(1, flags: IS_GIFT_SENDER_PURCHASE)])) { Purchase.find(1).create_url_redirect! }
cases << run("skips a commission completion purchase", seed: base.merge(purchases: [purchase_row(1, flags: IS_COMMISSION_COMPLETION_PURCHASE)])) { Purchase.find(1).create_url_redirect! }
cases << run("fails when the token is taken", seed: base.merge(purchases: [purchase_row(1)],
                                                              url_redirects: [{ id: 1, purchase_id: 2, token: format("%032x", 1), flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }])) do
  Purchase.find(1).create_url_redirect!
end
cases << run("fails for a purchase that does not exist") { Purchase.find(404).create_url_redirect! }

File.write(OUT, JSON.pretty_generate({ "now" => travel_to(NOW, with_usec: true) { Time.now.to_f }, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
