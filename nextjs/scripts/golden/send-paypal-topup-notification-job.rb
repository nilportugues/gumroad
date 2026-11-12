# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-paypal-topup-notification-job.golden.json: SendPaypalTopupNotificationJob run by the
# real app as a Sidekiq job (support/sidekiq_executor.rb) in each Rails environment. Outside production it returns at once. In
# production it builds PaypalBalanceCheckService (PayPal and payout reads), which Node hands back to Rails; those cases are recorded
# up to it, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-paypal-topup-notification-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

PaypalBalanceCheckService.singleton_class.prepend(Module.new do
  def new(*) = raise(HandBackMarker)
end)

def run(env, args)
  hands_back = false
  original = Rails.env
  Rails.env = env
  result = capture("#{env} with #{args.inspect}", now: NOW, tables: [], sidekiq: true, job: "SendPaypalTopupNotificationJob", args:, rails_env: env) do
    SendPaypalTopupNotificationJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  Rails.env = original.to_s
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = %w[test development staging production].flat_map do |env|
  [[], [true], [false], [nil], ["yes"]].map { |args| run(env, args) }
end

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
