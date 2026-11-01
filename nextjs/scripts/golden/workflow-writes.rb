# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/workflow-writes.golden.json: Workflow#publish!, #unpublish! and #mark_deleted!
# (and the InstallmentRule#advance_version! and Installment writes they run) called by the real app against a scratch database
# in a Sidekiq executor (support/sidekiq_executor.rb). Every statement, Redis write (the pending-version scripts, the
# schedule intents' dispatch job) and Elasticsearch request is recorded. Run it like publish-scheduled-post.rb:
#
#   bundle exec rails runner nextjs/scripts/golden/workflow-writes.rb   (env as in publish-scheduled-post.rb)
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/workflow-writes.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users workflows installments installment_rules versions product_files payments workflow_installment_schedule_intents merchant_accounts purchases].freeze
SHOWN_ON_PROFILE = 1 << 7
SEND_EMAILS = 1 << 8
TEAM_MEMBER = 1 << 27

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

# Sequential uuids: the pending-version token, the schedule intents' tokens and their dispatch tokens come out in call order.
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end
end)

# The one body EsCapture answers every request with: the audience count and both sales_cents_total aggregations.
def es_answer(count, price_cents = 0)
  seller = %w[price_cents fee_cents amount_refunded_cents fee_refunded_cents affiliate_credit_amount_cents affiliate_credit_amount_partially_refunded_cents
              direct_affiliate_credit_amount_cents direct_affiliate_credit_amount_partially_refunded_cents].to_h { ["#{_1}_total", { "value" => _1 == "price_cents" ? price_cents : 0 }] }
  own = %w[affiliate_credit direct_affiliate_credit].product(%w[amount_cents fee_cents amount_partially_refunded_cents fee_partially_refunded_cents])
    .to_h { |prefix, measure| ["#{prefix}_#{measure}_own", { "total" => { "value" => 0 } }] }
  { "count" => count, "aggregations" => seller.merge(own) }
end

def at(time) = time.utc.strftime("%Y-%m-%d %H:%M:%S.%6N")

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: TEAM_MEMBER, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def workflow_row(id = 1, **overrides)
  { id:, name: "Workflow #{id}", seller_id: 1, workflow_type: "audience", flags: 0, json_data: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id, workflow_id: 1, **overrides)
  { id:, seller_id: 1, workflow_id:, installment_type: "audience", name: "Email #{id}", message: "<p>Hello</p>", slug: "email-#{id}", flags: SEND_EMAILS,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(installment_id, **overrides)
  { id: installment_id, installment_id:, delayed_delivery_time: 3600, time_period: "hour", version: 3, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(user_id, **overrides)
  { id: user_id, user_id:, state: "completed", amount_cents: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

cases = []
call = lambda do |name, kind, es_body: nil, **seed|
  seed = { users: [user_row(1)], workflows: [workflow_row(published_at: nil)], installments: [], installment_rules: [] }.merge(seed)
  $uuid_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, kind:, case_now: NOW.to_f, es_body:) do
    workflow = Workflow.find(1)
    $return = case kind
              when "publish!" then workflow.publish!
              when "unpublish!" then workflow.unpublish!
              else workflow.mark_deleted!
    end
  end
  result.delete("rows")
  result.delete("seed")
  result["return"] = result["error"] ? nil : $return.as_json
  cases << result
end

two_emails = { installments: [installment_row(10), installment_row(11, name: "Email 11")], installment_rules: [rule_row(10), rule_row(11, delayed_delivery_time: 86_400, time_period: "day", version: 1)] }
published = { workflows: [workflow_row(published_at: SEEDED_AT, first_published_at: SEEDED_AT)] }
published_emails = { installments: [installment_row(10, published_at: SEEDED_AT), installment_row(11, published_at: SEEDED_AT)], installment_rules: two_emails[:installment_rules] }

# --- publish! -----------------------------------------------------------------------------------------------------------
call.call("publish!: a workflow that is published already", "publish!", **published, **two_emails)
call.call("publish!: a team member's workflow without emails", "publish!")
call.call("publish!: a team member's workflow with one email", "publish!", es_body: es_answer(3), installments: [installment_row(10)], installment_rules: [rule_row(10)])
call.call("publish!: a team member's workflow with two emails", "publish!", es_body: es_answer(3), **two_emails)
call.call("publish!: a workflow published before keeps its first publication", "publish!", es_body: es_answer(3),
          workflows: [workflow_row(first_published_at: "2024-06-01 00:00:00")], **two_emails)
call.call("publish!: deleted emails stay out", "publish!", es_body: es_answer(3),
          installments: [installment_row(10), installment_row(11, deleted_at: SEEDED_AT), installment_row(12, workflow_id: 2)],
          installment_rules: [rule_row(10), rule_row(11), rule_row(12)])
call.call("publish!: an email without a rule", "publish!", es_body: es_answer(3), installments: [installment_row(10)])
call.call("publish!: an email shown on the profile only", "publish!", installments: [installment_row(10, flags: SHOWN_ON_PROFILE)], installment_rules: [rule_row(10)])
call.call("publish!: an abandoned cart workflow", "publish!", workflows: [workflow_row(workflow_type: "abandoned_cart")], users: [user_row(1, flags: 0, user_risk_state: "suspended_for_fraud")],
          installments: [installment_row(10, installment_type: "abandoned_cart")], installment_rules: [rule_row(10, delayed_delivery_time: 86_400, time_period: "hour")])
call.call("publish!: a seller who is not eligible", "publish!", es_body: es_answer(3), users: [user_row(1, flags: 0)], **two_emails)
call.call("publish!: a seller with sales and a completed payout", "publish!", es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0)], payments: [payment_row(1)], **two_emails)
call.call("publish!: a verified seller with sales", "publish!", es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0, verified: 1)], **two_emails)
call.call("publish!: a verified seller who is flagged", "publish!", es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0, verified: 1, user_risk_state: "flagged_for_fraud")], **two_emails)
call.call("publish!: a seller with sales but no payout and not verified", "publish!", es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0)], **two_emails)
call.call("publish!: a seller with sales through a Stripe Connect account", "publish!", es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0)], **two_emails,
          merchant_accounts: [{ id: 1, user_id: 1, charge_processor_id: "stripe", charge_processor_merchant_id: "acct_1", json_data: { meta: { stripe_connect: "true" } }.to_json, created_at: SEEDED_AT, updated_at: SEEDED_AT }],
          purchases: [{ id: 1, link_id: 1, seller_id: 1, purchase_state: "successful", price_cents: 100, merchant_account_id: 1, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
call.call("publish!: a suspended seller", "publish!", users: [user_row(1, flags: 0, user_risk_state: "suspended_for_fraud")], **two_emails)
call.call("publish!: a seller who has not confirmed their email", "publish!", es_body: es_answer(3), users: [user_row(1, confirmed_at: nil)], **two_emails)
call.call("publish!: an email with a file", "publish!", es_body: es_answer(3), **two_emails,
          product_files: [{ id: 1, installment_id: 11, url: "https://example.com/f.pdf", flags: 0, position: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
call.call("publish!: an email to more than 100 people from a seller with small sales", "publish!", es_body: es_answer(101, 100), **two_emails)
call.call("publish!: an email without a message", "publish!", es_body: es_answer(3), installments: [installment_row(10, message: "<p><br></p>")], installment_rules: [rule_row(10)])
call.call("publish!: an email that was published once already", "publish!", es_body: es_answer(3),
          installments: [installment_row(10, flags: SEND_EMAILS | (1 << 6))], installment_rules: [rule_row(10)])
call.call("publish!: a product workflow", "publish!", es_body: es_answer(3), workflows: [workflow_row(workflow_type: "product", link_id: 1)],
          installments: [installment_row(10, installment_type: "product", link_id: 1)], installment_rules: [rule_row(10)])

# --- unpublish! ---------------------------------------------------------------------------------------------------------
call.call("unpublish!: a workflow that is not published", "unpublish!", **two_emails)
call.call("unpublish!: a published workflow without emails", "unpublish!", **published)
call.call("unpublish!: a published workflow with two emails", "unpublish!", es_body: es_answer(3), **published, **published_emails)
call.call("unpublish!: deleted emails stay out", "unpublish!", es_body: es_answer(3), **published,
          installments: [installment_row(10, published_at: SEEDED_AT), installment_row(11, published_at: SEEDED_AT, deleted_at: SEEDED_AT)], installment_rules: two_emails[:installment_rules])
call.call("unpublish!: an email without a rule", "unpublish!", es_body: es_answer(3), **published, installments: [installment_row(10, published_at: SEEDED_AT)])
call.call("unpublish!: an email with an empty message", "unpublish!", es_body: es_answer(3), **published, installments: [installment_row(10, published_at: SEEDED_AT, message: "<p><br></p>")], installment_rules: [rule_row(10)])

# --- mark_deleted! ------------------------------------------------------------------------------------------------------
call.call("mark_deleted!: a workflow without emails", "mark_deleted!")
call.call("mark_deleted!: a workflow with two emails", "mark_deleted!", es_body: es_answer(3), **published, **published_emails)
call.call("mark_deleted!: emails that were deleted already are visited again", "mark_deleted!", es_body: es_answer(3), **published,
          installments: [installment_row(10, published_at: SEEDED_AT), installment_row(11, published_at: SEEDED_AT, deleted_at: SEEDED_AT)], installment_rules: two_emails[:installment_rules])
call.call("mark_deleted!: an email without a rule", "mark_deleted!", es_body: es_answer(3), installments: [installment_row(10)])
call.call("mark_deleted!: a rule that was deleted", "mark_deleted!", es_body: es_answer(3), installments: [installment_row(10)], installment_rules: [rule_row(10, deleted_at: SEEDED_AT)])
call.call("mark_deleted!: a rule whose delivery date passed", "mark_deleted!", es_body: es_answer(3),
          installments: [installment_row(10, workflow_id: 1)], installment_rules: [rule_row(10, to_be_published_at: "2025-01-02 00:00:00")])
call.call("mark_deleted!: an email without a message", "mark_deleted!", installments: [installment_row(10, message: nil)], installment_rules: [rule_row(10)])
call.call("mark_deleted!: a workflow that is deleted already", "mark_deleted!", workflows: [workflow_row(deleted_at: SEEDED_AT)], **two_emails, es_body: es_answer(3))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
