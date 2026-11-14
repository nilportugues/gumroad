# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/mass-refund-for-fraud-job.golden.json: MassRefundForFraudJob run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). A purchase of the product reaches
# Purchase#refund_for_fraud_and_block_buyer! (a Stripe or PayPal refund), which Node hands back to Rails; those cases are recorded up to
# it, which a marker exception stands in for. Run it like pdf-unstampable-notifier-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/mass-refund-for-fraud-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

Purchase.prepend(Module.new do
  def refund_for_fraud_and_block_buyer!(*, **) = raise(HandBackMarker)
end)

def purchase_row(id, link_id: 1, **overrides)
  { id:, link_id:, seller_id: 1, email: "buyer#{id}@example.com", purchase_state: "successful", price_cents: 100, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def ext(id) = ObfuscateIds.encrypt(id)

def run(name, args, *purchases)
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { purchases: }, sidekiq: true, job: "MassRefundForFraudJob", args:) do
    MassRefundForFraudJob.new.perform(*args)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

cases = []
cases << run("no external ids", [1, [], 7])
cases << run("an external id of a purchase that does not exist", [1, [ext(9)], 7])
cases << run("several external ids of purchases that do not exist", [1, [ext(8), ext(9), ext(10)], 7], purchase_row(1))
cases << run("the same missing external id twice", [1, [ext(9), ext(9)], 7])
cases << run("an external id that is not valid base64", [1, ["not base64!"], 7], purchase_row(1))
cases << run("an empty external id", [1, [""], 7], purchase_row(1))
cases << run("an external id that decrypts to a word", [1, [ObfuscateIds.encrypt("abc")], 7], purchase_row(1))
cases << run("an external id that was not issued by this app", [1, ["YWJjZGVmZ2hpamtsbW5vcA=="], 7], purchase_row(1))
cases << run("a purchase of another product", [1, [ext(1)], 7], purchase_row(1, link_id: 2))
cases << run("purchases of other products", [1, [ext(1), ext(2)], 7], purchase_row(1, link_id: 2), purchase_row(2, link_id: 3))
cases << run("a purchase of the product", [1, [ext(1)], 7], purchase_row(1))
cases << run("a purchase of the product among others", [1, [ext(2)], 7], purchase_row(1, link_id: 2), purchase_row(2), purchase_row(3))
cases << run("a missing purchase, one of another product, then one of the product", [1, [ext(9), ext(1), ext(2)], 7], purchase_row(1, link_id: 2), purchase_row(2))
cases << run("a purchase of the product listed twice", [1, [ext(1), ext(1)], 7], purchase_row(1))
cases << run("a purchase of another product listed twice", [1, [ext(1), ext(1)], 7], purchase_row(1, link_id: 2))
cases << run("a failed purchase of the product", [1, [ext(1)], 7], purchase_row(1, purchase_state: "failed"))
cases << run("a purchase of the product when the product id is a string", ["1", [ext(1)], 7], purchase_row(1))
cases << run("a purchase of the product when the product id is a float", [1.0, [ext(1)], 7], purchase_row(1))
cases << run("a purchase of the product when the product id is nil", [nil, [ext(1)], 7], purchase_row(1))
cases << run("a missing purchase when the product id is a string", ["1", [ext(9)], 7])
cases << run("an external id of nil", [1, [nil], 7], purchase_row(1))
cases << run("an external id that is a number", [1, [5], 7], purchase_row(1, id: 5))
cases << run("external ids are not a list", [1, nil, 7], purchase_row(1))
cases << run("external ids are a string", [1, ext(1), 7], purchase_row(1))
cases << run("one argument too few", [1, [ext(1)]], purchase_row(1))
cases << run("one argument too many", [1, [ext(1)], 7, 8], purchase_row(1))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
