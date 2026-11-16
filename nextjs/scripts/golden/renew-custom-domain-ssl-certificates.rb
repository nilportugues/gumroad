# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/renew-custom-domain-ssl-certificates.golden.json: RenewCustomDomainSslCertificates run by
# the real app as a Sidekiq job (support/sidekiq_executor.rb) in each Rails environment and with BRANCH_DEPLOYMENT unset, empty and set.
# `SslCertificates::Renew.supported_environment?` is production, or staging outside a branch deployment; anywhere else it returns at
# once. Where it is supported the job builds SslCertificates::Renew (S3 and DNS), which Node hands back to Rails; those cases are
# recorded up to it, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/renew-custom-domain-ssl-certificates.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

SslCertificates::Renew.singleton_class.prepend(Module.new do
  def new(*) = raise(HandBackMarker)
end)

def run(env, branch_deployment, args)
  hands_back = false
  original = Rails.env.to_s
  Rails.env = env
  branch_deployment.nil? ? ENV.delete("BRANCH_DEPLOYMENT") : ENV["BRANCH_DEPLOYMENT"] = branch_deployment
  result = capture("#{env}, BRANCH_DEPLOYMENT #{branch_deployment.inspect}, args #{args.inspect}", now: NOW, tables: [], sidekiq: true, job: "RenewCustomDomainSslCertificates", args:, rails_env: env, branch_deployment:) do
    RenewCustomDomainSslCertificates.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  ENV.delete("BRANCH_DEPLOYMENT")
  Rails.env = original
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = %w[test development staging production].flat_map do |env|
  [nil, "", "true"].map { |branch| run(env, branch, []) }
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
