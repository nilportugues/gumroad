# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/custom-domains-verification-worker.golden.json: CustomDomainsVerificationWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). It only reads custom_domains and schedules a
# CustomDomainVerificationWorker per domain, so nothing leaves the machine. Run it like
# refresh-custom-domain-routability-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/custom-domains-verification-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[custom_domains].freeze
WRAP = CustomDomainsVerificationWorker::MAX_DURATION_TO_VERIFY_ALL_DOMAINS.to_i

Rails.logger = ActiveSupport::Logger.new(nil)

def domain_row(id, **overrides) = { id:, user_id: 1, domain: "shop#{id}.example.com", state: "verified", failed_verification_attempts_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, rows)
  result = capture(name, now: NOW, tables: TABLES, seed: { custom_domains: rows }, sidekiq: true, job: "CustomDomainsVerificationWorker", args: []) do
    CustomDomainsVerificationWorker.new.perform
  end
  result.delete("seed")
  result.delete("rows")
  result
end

# Every domain but the ones at these positions is past its attempts, so the case schedules few jobs but still counts them all.
def long_run(name, count, kept)
  rows = (1..count).map { |id| domain_row(id, failed_verification_attempts_count: kept.include?(id) ? 0 : 3) }
  run(name, rows)
end

cases = []
cases << run("no domains", [])
cases << run("one domain", [domain_row(1)])
cases << run("three domains", [domain_row(1), domain_row(2), domain_row(3)])
cases << run("a deleted domain", [domain_row(1), domain_row(2, deleted_at: SEEDED_AT), domain_row(3)])
cases << run("an unverified domain", [domain_row(1, state: "unverified", failed_verification_attempts_count: 1)])
cases << run("a domain one attempt short of the limit", [domain_row(1, failed_verification_attempts_count: 2)])
cases << run("a domain at the attempt limit", [domain_row(1, failed_verification_attempts_count: 3), domain_row(2)])
cases << run("a domain past the attempt limit", [domain_row(1, failed_verification_attempts_count: 9), domain_row(2)])
cases << run("a domain for a product", [domain_row(1, user_id: nil, product_id: 5)])
cases << run("domains skipped still take an index", [domain_row(1, failed_verification_attempts_count: 3), domain_row(2, failed_verification_attempts_count: 3), domain_row(3)])
cases << long_run("a batch boundary", 1001, [1, 1000, 1001])
cases << long_run("the hour wrap", WRAP + 1, [1, 2, WRAP, WRAP + 1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
