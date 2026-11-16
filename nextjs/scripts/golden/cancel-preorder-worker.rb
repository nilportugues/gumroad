# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/cancel-preorder-worker.golden.json: CancelPreorderWorker run by the real app against a
# scratch database as a Sidekiq job (support/sidekiq_executor.rb). A preorder whose authorization succeeded runs the real
# Preorder#mark_cancelled! against the seeded rows, with outbound HTTP answered by WebMock (support/rails_cases.rb) and recorded
# under `http`, so nothing leaves the machine; Node hands those cases back after reading the preorder. Run it like
# charge-successful-preorders-worker.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases
capture_http!

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/cancel-preorder-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[preorders versions].freeze

Rails.logger = ActiveSupport::Logger.new(nil)
Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)

def preorder_row(id, state: "authorization_successful", **overrides) = { id:, preorder_link_id: 1, seller_id: 1, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, seed, args = [1])
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "CancelPreorderWorker", args:) do
    CancelPreorderWorker.new.perform(*args)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a preorder that does not exist", {}, [99])
cases << run("a preorder id of nil", { preorders: [preorder_row(1)] }, [nil])
Preorder.state_machine.states.map { _1.name.to_s }.each do |state|
  cases << run("a #{state} preorder", { preorders: [preorder_row(1, state:)] })
end
cases << run("a preorder in a state the machine does not know", { preorders: [preorder_row(1, state: "mystery")] })
cases << run("another preorder is authorized", { preorders: [preorder_row(1, state: "in_progress"), preorder_row(2)] })
cases << run("a preorder id given as a digit string", { preorders: [preorder_row(1, state: "cancelled")] }, ["1"])
cases << run("a preorder id given as a float", { preorders: [preorder_row(1, state: "cancelled")] }, [1.0])
cases << run("a preorder id given as a word", { preorders: [preorder_row(1, state: "cancelled")] }, ["abc"])

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
