# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/generate-ssl-certificate.golden.json: GenerateSslCertificate run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). `SslCertificates::Generate.supported_environment?` (production, or staging
# outside a branch deployment) finishes the job anywhere else; where it is supported the domain is found and, unless deleted, the ACME order
# is built, which Node hands back to Rails: those cases are recorded up to `SslCertificates::Generate.new`, which a marker exception stands in
# for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/generate-ssl-certificate.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[custom_domains].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SslCertificates::Generate.singleton_class.prepend(Module.new do
  def new(*) = raise(HandBackMarker)
end)

def domain_row(id, **overrides) = { id:, user_id: 1, domain: "shop#{id}.example.com", state: "verified", failed_verification_attempts_count: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, args, rows, env: "production", branch_deployment: nil)
  hands_back = false
  original = Rails.env.to_s
  Rails.env = env
  branch_deployment.nil? ? ENV.delete("BRANCH_DEPLOYMENT") : ENV["BRANCH_DEPLOYMENT"] = branch_deployment
  result = capture(name, now: NOW, tables: TABLES, seed: { custom_domains: rows }, sidekiq: true, job: "GenerateSslCertificate", args:, rails_env: env, branch_deployment:) do
    GenerateSslCertificate.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  ENV.delete("BRANCH_DEPLOYMENT")
  Rails.env = original
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("a domain to certify", [1], [domain_row(1)])
cases << run("a domain among others", [2], [domain_row(1), domain_row(2), domain_row(3)])
cases << run("a domain that does not exist", [9], [domain_row(1)])
cases << run("a deleted domain", [1], [domain_row(1, deleted_at: SEEDED_AT)])
cases << run("a domain that already has a certificate", [1], [domain_row(1, ssl_certificate_issued_at: SEEDED_AT)])
cases << run("an unverified domain", [1], [domain_row(1, state: "unverified")])
cases << run("a domain of a product", [1], [domain_row(1, user_id: nil, product_id: 5)])
cases << run("the domain id as a digit string", ["2"], [domain_row(1), domain_row(2)])
cases << run("a rate limit reschedule count", [1, 3], [domain_row(1)])
cases << run("a domain id of zero", [0], [domain_row(1)])
cases << run("a domain id of nil", [nil], [domain_row(1)])
cases << run("a domain id as a float", [1.0], [domain_row(1)])
cases << run("a domain id as a word", ["one"], [domain_row(1)])
cases << run("no arguments", [], [domain_row(1)])
cases << run("three arguments", [1, 0, 0], [domain_row(1)])
cases << run("staging outside a branch deployment", [1], [domain_row(1)], env: "staging")
cases << run("staging in a branch deployment", [1], [domain_row(1)], env: "staging", branch_deployment: "true")
cases << run("staging with an empty branch deployment", [1], [domain_row(1)], env: "staging", branch_deployment: "")
cases << run("the test environment", [1], [domain_row(1)], env: "test")
cases << run("the development environment", [1], [domain_row(1)], env: "development")

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
