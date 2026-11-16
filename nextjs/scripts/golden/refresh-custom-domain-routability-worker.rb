# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/refresh-custom-domain-routability-worker.golden.json: RefreshCustomDomainRoutabilityWorker
# run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). CustomDomainRoutabilityService (DNS and
# TLS lookups of the seller's domain) is replaced by a recorder, so nothing leaves the machine; the golden keeps the domain ids it was
# asked to process under `processed`. Run it like expiring-credit-card-message-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/refresh-custom-domain-routability-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[custom_domains].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

$processed = []
recorder = Class.new do
  def initialize(custom_domain) = @custom_domain = custom_domain
  def process = $processed << @custom_domain.id
end
CustomDomainRoutabilityService.singleton_class.prepend(Module.new do
  define_method(:new) { |custom_domain, **| recorder.new(custom_domain) }
end)
abort "routability service is not stubbed" unless CustomDomainRoutabilityService.new(CustomDomain.new).is_a?(recorder)

def ago(seconds) = (NOW - seconds).utc.strftime("%Y-%m-%d %H:%M:%S")

DAY = 86_400
HOUR = 3_600

def domain_row(id, **overrides) = { id:, user_id: 1, domain: "shop#{id}.example.com", state: "verified", ssl_certificate_issued_at: ago(DAY), failed_verification_attempts_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows)
  $processed = []
  result = capture(name, now: NOW, tables: TABLES, seed: { custom_domains: rows }, sidekiq: true, job: "RefreshCustomDomainRoutabilityWorker", args:) do
    RefreshCustomDomainRoutabilityWorker.new.perform(*args)
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("processed" => $processed.dup)
end

cases = []
cases << run("a domain that does not exist", [99], [])
cases << run("a domain id of nil", [nil], [domain_row(1)])
cases << run("a verified domain never checked", [1], [domain_row(1)])
cases << run("a domain id given as a digit string", ["1"], [domain_row(1)])
cases << run("a domain id given as a float", [1.0], [domain_row(1)])
cases << run("a domain id given as a word", ["abc"], [domain_row(1)])
cases << run("a deleted domain", [1], [domain_row(1, deleted_at: SEEDED_AT)])
cases << run("an unverified domain", [1], [domain_row(1, state: "unverified")])
cases << run("a verified domain without a certificate", [1], [domain_row(1, ssl_certificate_issued_at: nil)])
cases << run("a certificate just inside its lifetime", [1], [domain_row(1, ssl_certificate_issued_at: ago(90 * DAY - 1))])
cases << run("a certificate exactly at its lifetime", [1], [domain_row(1, ssl_certificate_issued_at: ago(90 * DAY))])
cases << run("an expired certificate", [1], [domain_row(1, ssl_certificate_issued_at: ago(91 * DAY))])
cases << run("checked a minute ago", [1], [domain_row(1, routability_checked_at: ago(60))])
cases << run("checked just inside the refresh interval", [1], [domain_row(1, routability_checked_at: ago(6 * HOUR - 1))])
cases << run("checked exactly at the refresh interval", [1], [domain_row(1, routability_checked_at: ago(6 * HOUR))])
cases << run("checked just outside the refresh interval", [1], [domain_row(1, routability_checked_at: ago(6 * HOUR + 1))])
cases << run("checked a day ago", [1], [domain_row(1, routability_checked_at: ago(DAY))])
cases << run("checked in the future", [1], [domain_row(1, routability_checked_at: ago(-HOUR))])
cases << run("another domain is due", [2], [domain_row(1), domain_row(2, routability_checked_at: ago(60))])
cases << run("a domain for a product", [1], [domain_row(1, user_id: nil, product_id: 5)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
