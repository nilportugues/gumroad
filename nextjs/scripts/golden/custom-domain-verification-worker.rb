# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/custom-domain-verification-worker.golden.json: CustomDomainVerificationWorker run by the
# real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The read, `deleted?` and `valid?` (the domain
# checks and the owner lookups) run in Node; a valid domain reaches `CustomDomainVerificationService.new` (DNS lookups of the seller's
# domain), which Node hands back, recorded up to there with a marker exception (`hands_back`). Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/custom-domain-verification-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[custom_domains users links].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

CustomDomainVerificationService.singleton_class.prepend(Module.new do
  def new(*, **) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: 0, confirmed_at: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def link_row(id, **overrides) = { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def domain_row(id, **overrides) = { id:, user_id: 1, domain: "shop#{id}.example.com", state: "unverified", failed_verification_attempts_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, domains, users: [user_row(1)], links: [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { custom_domains: domains, users:, links: }, sidekiq: true, job: "CustomDomainVerificationWorker", args:) do
    CustomDomainVerificationWorker.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a domain that does not exist", [99], [])
cases << run("a domain that does not exist among others", [99], [domain_row(1), domain_row(2)])
cases << run("a domain", [1], [domain_row(1)])
cases << run("a domain among others", [2], [domain_row(1), domain_row(2), domain_row(3)])
cases << run("a verified domain", [1], [domain_row(1, state: "verified")])
cases << run("a deleted domain", [1], [domain_row(1, deleted_at: SEEDED_AT)])
cases << run("a domain with an upper case name", [1], [domain_row(1, domain: "Shop.Example.COM")])
cases << run("a bare domain", [1], [domain_row(1, domain: "example.com")])
cases << run("a www domain", [1], [domain_row(1, domain: "www.example.com")])
cases << run("a bare domain whose www variant is taken", [2], [domain_row(1, domain: "www.example.com"), domain_row(2, domain: "example.com")])
cases << run("a www domain whose bare variant is taken", [2], [domain_row(1, domain: "example.com"), domain_row(2, domain: "www.example.com")])
cases << run("a domain another domain already uses", [2], [domain_row(1, domain: "shop.example.com"), domain_row(2, domain: "shop.example.com")])
cases << run("a domain another deleted domain used", [2], [domain_row(1, domain: "shop.example.com", deleted_at: SEEDED_AT), domain_row(2, domain: "shop.example.com")])
cases << run("a domain that is not a valid host name", [1], [domain_row(1, domain: "not a domain")])
cases << run("a domain with a hyphen leading a label", [1], [domain_row(1, domain: "-shop.example.com")])
cases << run("a domain ending in a dot", [1], [domain_row(1, domain: "shop.example.com.")])
cases << run("a domain with an unknown suffix", [1], [domain_row(1, domain: "shop.notatld")])
cases << run("an IP address", [1], [domain_row(1, domain: "192.168.1.10")])
cases << run("a blank domain", [1], [domain_row(1, domain: "")])
cases << run("a nil domain", [1], [domain_row(1, domain: nil)])
cases << run("a domain under the application domain", [1], [domain_row(1, domain: "shop.#{DOMAIN}")])
cases << run("the application domain itself", [1], [domain_row(1, domain: DOMAIN)])
cases << run("a domain under the short domain", [1], [domain_row(1, domain: "shop.#{SHORT_DOMAIN}")])
cases << run("a deleted domain with an invalid name", [1], [domain_row(1, domain: "not a domain", deleted_at: SEEDED_AT)])
cases << run("a domain with neither a user nor a product", [1], [domain_row(1, user_id: nil)])
cases << run("a domain whose user does not exist", [1], [domain_row(1, user_id: 9)])
cases << run("a domain for a product", [1], [domain_row(1, user_id: nil, product_id: 5)], links: [link_row(5)])
cases << run("a domain for a product that does not exist", [1], [domain_row(1, user_id: nil, product_id: 5)])
cases << run("a domain for a user and a product", [1], [domain_row(1, product_id: 5)], links: [link_row(5)])
cases << run("a domain with failed verification attempts", [1], [domain_row(1, failed_verification_attempts_count: 3)])
cases << run("a domain id as a digit string", ["1"], [domain_row(1)])
cases << run("a domain id of nil", [nil], [domain_row(1)])
cases << run("a domain id as a float", [1.0], [domain_row(1)])
cases << run("a domain id as a word", ["one"], [domain_row(1)])
cases << run("no arguments", [], [domain_row(1)])
cases << run("one argument too many", [1, 1], [domain_row(1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
