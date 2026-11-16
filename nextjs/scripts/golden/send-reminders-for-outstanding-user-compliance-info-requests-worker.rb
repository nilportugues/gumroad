# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-reminders-for-outstanding-user-compliance-info-requests-worker.golden.json:
# SendRemindersForOutstandingUserComplianceInfoRequestsWorker run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). A rejected Stripe account makes the worker ask Stripe, which is replaced by a marker that ends the
# case with `hands_back`. Run it like publish-scheduled-post.rb (env as there, USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-reminders-for-outstanding-user-compliance-info-requests-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users merchant_accounts user_compliance_info_requests].freeze

ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end

Stripe::Account.singleton_class.prepend(Module.new do
  def retrieve(*) = raise(HandBackMarker)
end)

def user_row(id, **overrides)
  { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def account_row(id, user_id, country: "US", disabled_reason: nil, connect: false, **overrides)
  data = { stripe_disabled_reason: disabled_reason, meta: connect ? { stripe_connect: "true" } : nil }.compact
  { id:, user_id:, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_#{id}", json_data: data.to_json, country:, currency: "usd",
    charge_processor_alive_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def request_row(id, user_id, sent: nil, state: "requested", field: "individual.first_name", **overrides)
  data = { emails_sent_at: sent }.compact
  { id:, user_id:, field_needed: field, state:, json_data: data.empty? ? nil : data.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def ago(seconds) = (NOW - seconds).iso8601(3)

def run(name, seed)
  $uuid_seq = 0
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendRemindersForOutstandingUserComplianceInfoRequestsWorker", args: []) do
    SendRemindersForOutstandingUserComplianceInfoRequestsWorker.new.perform
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("seed")
  result.delete("rows")
  result.merge("hands_back" => hands_back)
end

DAY = 86_400
SG_ENHANCED = UserComplianceInfoFields::Individual::STRIPE_ENHANCED_IDENTITY_VERIFICATION

cases = []
cases << run("no requests", { users: [user_row(1)] })
cases << run("a request never emailed", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a request emailed three days ago", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(3 * DAY)])] })
cases << run("a request emailed one day ago", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(DAY)])] })
cases << run("a request emailed just over two days ago", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(2 * DAY + 1)])] })
cases << run("a request emailed exactly two days ago", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(2 * DAY)])] })
cases << run("a request already emailed twice", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(10 * DAY), ago(5 * DAY)])] })
cases << run("a request emailed twice with an older third stamp ignored by count", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(20 * DAY)])] })
cases << run("a request with emails_sent_at not a list", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, json_data: { emails_sent_at: nil, other: 1 }.to_json)] })
cases << run("a provided request", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, state: "provided")] })
cases << run("two requests for one seller, the oldest due", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(3 * DAY)]), request_row(2, 1, sent: [ago(DAY)])] })
cases << run("two requests for one seller, the oldest recently emailed", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, sent: [ago(DAY)]), request_row(2, 1)] })
cases << run("a provided request listed before a requested one", { users: [user_row(1)], user_compliance_info_requests: [request_row(1, 1, state: "provided", sent: [ago(DAY)]), request_row(2, 1)] })
cases << run("two sellers, both due", { users: [user_row(1), user_row(2)], user_compliance_info_requests: [request_row(1, 1), request_row(2, 2)] })
cases << run("a deleted seller before a due one", { users: [user_row(1, deleted_at: SEEDED_AT), user_row(2)], user_compliance_info_requests: [request_row(1, 1), request_row(2, 2)] })
cases << run("a suspended seller before a due one", { users: [user_row(1, user_risk_state: "suspended_for_fraud"), user_row(2)], user_compliance_info_requests: [request_row(1, 1), request_row(2, 2)] })
cases << run("a request of a seller that does not exist", { user_compliance_info_requests: [request_row(1, 9)] })
cases << run("a seller with a US Stripe account", { users: [user_row(1)], merchant_accounts: [account_row(1, 1)], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a seller with a Stripe Connect account only", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", connect: true)], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a seller with a rejected Stripe account", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, disabled_reason: "rejected.fraud")], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a rejected Stripe account after a seller that was emailed", { users: [user_row(1), user_row(2)], merchant_accounts: [account_row(1, 2, disabled_reason: "rejected.listed")], user_compliance_info_requests: [request_row(1, 1), request_row(2, 2)] })
cases << run("a disabled reason that starts like a rejection without the dot", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, disabled_reason: "rejected_other")], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a seller whose Stripe account is not alive", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, disabled_reason: "rejected.fraud", charge_processor_alive_at: nil)], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a seller whose Stripe account is deleted", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, disabled_reason: "rejected.fraud", deleted_at: SEEDED_AT)], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a disabled reason that only resembles a rejection", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, disabled_reason: "under_review")], user_compliance_info_requests: [request_row(1, 1)] })
sg = ->(**o) { { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", created_at: (NOW - 10 * DAY).strftime("%F %T"))], user_compliance_info_requests: [request_row(1, 1, field: SG_ENHANCED, **o)] } }
cases << run("a Singapore seller with a verification request never reminded", sg.call)
cases << run("a Singapore seller reminded eight days ago", sg.call(json_data: { sg_verification_reminder_sent_at: ago(8 * DAY), emails_sent_at: [ago(DAY)] }.to_json))
cases << run("a Singapore seller reminded exactly seven days ago", sg.call(json_data: { sg_verification_reminder_sent_at: ago(7 * DAY), emails_sent_at: [ago(DAY)] }.to_json))
cases << run("a Singapore seller reminded a second over seven days ago", sg.call(json_data: { sg_verification_reminder_sent_at: ago(7 * DAY + 1), emails_sent_at: [ago(DAY)] }.to_json))
cases << run("a Singapore seller reminded six days ago", sg.call(json_data: { sg_verification_reminder_sent_at: ago(6 * DAY), emails_sent_at: [ago(DAY)] }.to_json))
cases << run("a Singapore seller whose account is past 120 days", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", created_at: (NOW - 121 * DAY).strftime("%F %T"))], user_compliance_info_requests: [request_row(1, 1, field: SG_ENHANCED)] })
cases << run("a Singapore seller whose account is 119 days old", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", created_at: (NOW - 119 * DAY).strftime("%F %T"))], user_compliance_info_requests: [request_row(1, 1, field: SG_ENHANCED)] })
cases << run("a Singapore seller with a request for another field", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", created_at: (NOW - 10 * DAY).strftime("%F %T"))], user_compliance_info_requests: [request_row(1, 1)] })
cases << run("a Singapore seller with two verification requests", { users: [user_row(1)], merchant_accounts: [account_row(1, 1, country: "SG", created_at: (NOW - 10 * DAY).strftime("%F %T"))], user_compliance_info_requests: [request_row(1, 1, field: SG_ENHANCED), request_row(2, 1, field: SG_ENHANCED)] })
cases << run("a Singapore seller with a provided verification request", sg.call(state: "provided"))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
