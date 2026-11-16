# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/reissue-ssl-certificate-for-updated-custom-domains.golden.json:
# ReissueSslCertificateForUpdatedCustomDomains run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). The sweep reads alive domains with a certificate and then asks DNS and the ACME order about each, so a
# case with one is recorded up to its first `valid?`, which a marker exception stands in for; Node hands those back. Run it like
# pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/reissue-ssl-certificate-for-updated-custom-domains.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[custom_domains].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

CustomDomain.prepend(Module.new do
  def valid?(*) = raise(HandBackMarker)
end)

def domain_row(id, **overrides) = { id:, user_id: 1, domain: "shop#{id}.example.com", state: "verified", failed_verification_attempts_count: 0, ssl_certificate_issued_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, rows, args = [])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { custom_domains: rows }, sidekiq: true, job: "ReissueSslCertificateForUpdatedCustomDomains", args:) do
    ReissueSslCertificateForUpdatedCustomDomains.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no domains", [])
cases << run("a domain that never had a certificate", [domain_row(1, ssl_certificate_issued_at: nil)])
cases << run("a deleted domain with a certificate", [domain_row(1, deleted_at: SEEDED_AT)])
cases << run("an unverified domain with a certificate", [domain_row(1, state: "unverified")])
cases << run("a domain for a product", [domain_row(1, user_id: nil, product_id: 5)])
cases << run("one domain with a certificate", [domain_row(1)])
cases << run("domains without a certificate before one with", [domain_row(1, ssl_certificate_issued_at: nil), domain_row(2, deleted_at: SEEDED_AT), domain_row(3)])
cases << run("three domains with a certificate", [domain_row(1), domain_row(2), domain_row(3)])
cases << run("an argument", [], [1])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
