# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/send-preorder-seller-summary-worker.golden.json: SendPreorderSellerSummaryWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The summary mail is a deliver_later, so the
# scratch Redis holds the ActiveJob push; the retry is a perform_in on its own queue. Run it like update-taxonomy-stats-job.rb.
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/send-preorder-seller-summary-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[preorder_links preorders purchases].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid = format("00000000-0000-4000-8000-%012x", ($uuid_seq += 1))
end)
$errors = []
ErrorNotifier.singleton_class.prepend(Module.new do
  def notify(*args, **kwargs, &block)
    $errors << [args.map { _1.respond_to?(:message) ? _1.message : _1.to_s }, kwargs.transform_values(&:to_s)]
    nil
  end
end)

def link_row(id) = { id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def preorder_row(id, state: "authorization_successful", link: 1) = { id:, preorder_link_id: link, seller_id: 1, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def purchase_row(id, preorder, state: "preorder_authorization_successful") = { id:, preorder_id: preorder, purchase_state: state, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def run(name, args, seed)
  $uuid_seq = 0
  $errors.clear
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "SendPreorderSellerSummaryWorker", args:) do
    SendPreorderSellerSummaryWorker.new.perform(*args)
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("errors" => $errors.dup)
end

BASE = { preorder_links: [link_row(1)] }.freeze
cases = []
cases << run("a link without preorders", [1], BASE)
cases << run("every authorized preorder holds its charged purchase", [1], BASE.merge(preorders: [preorder_row(1), preorder_row(2)], purchases: [purchase_row(1, 1, state: "preorder_authorization_successful"), purchase_row(2, 1, state: "successful"), purchase_row(3, 2, state: "preorder_authorization_successful"), purchase_row(4, 2, state: "successful")]))
cases << run("a preorder still holding only its authorization purchase", [1], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1)]))
cases << run("a preorder whose charge is in progress", [1], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1), purchase_row(2, 1, state: "in_progress")]))
cases << run("a preorder with one in-progress purchase only", [1], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1, state: "in_progress")]))
cases << run("a preorder whose authorization failed is ignored", [1], BASE.merge(preorders: [preorder_row(1, state: "authorization_failed")], purchases: [purchase_row(1, 1)]))
cases << run("a preorder of another link is ignored", [1], BASE.merge(preorder_links: [link_row(1), link_row(2)], preorders: [preorder_row(1, link: 2)], purchases: [purchase_row(1, 1)]))
cases << run("one waiting preorder among charged ones", [1], BASE.merge(preorders: [preorder_row(1), preorder_row(2)], purchases: [purchase_row(1, 1), purchase_row(2, 1, state: "successful"), purchase_row(3, 2)]))
cases << run("a preorder with no purchases", [1], BASE.merge(preorders: [preorder_row(1)]))
cases << run("the second attempt", [1, 1], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1)]))
cases << run("the last attempt before the limit", [1, 71], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1)]))
cases << run("the attempt that hits the limit", [1, 72], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1)]))
cases << run("past the limit", [1, 100], BASE)
cases << run("an unknown link", [99], BASE)
cases << run("an unknown link past the limit", [99, 72], BASE)
cases << run("the link id as a string", ["1"], BASE.merge(preorders: [preorder_row(1)], purchases: [purchase_row(1, 1, state: "successful"), purchase_row(2, 1)]))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
