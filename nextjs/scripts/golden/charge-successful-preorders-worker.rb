# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/charge-successful-preorders-worker.golden.json: ChargeSuccessfulPreordersWorker run by
# the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). The pushes of ChargePreorderWorker and the
# delayed SendPreorderSellerSummaryWorker are visible in the scratch Redis. Run it like seller-update-worker.rb (env as in
# publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/charge-successful-preorders-worker.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[preorder_links preorders].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

def link_row(id, **overrides) = { id:, link_id: 1, state: "released", release_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
def preorder_row(id, link: 1, state: "authorization_successful", **overrides) = { id:, preorder_link_id: link, seller_id: 1, state:, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)

def run(name, seed, id = 1)
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, job: "ChargeSuccessfulPreordersWorker", args: [id], at: NOW.to_f) do
    ChargeSuccessfulPreordersWorker.new.perform(id)
  end
  result.delete("seed")
  result
end

cases = []
cases << run("a preorder link that does not exist", {})
cases << run("a preorder link id of nil", { preorder_links: [link_row(1)] }, nil)
cases << run("a preorder link with no preorders", { preorder_links: [link_row(1)] })
cases << run("a preorder link with one authorized preorder", { preorder_links: [link_row(1)], preorders: [preorder_row(1)] })
cases << run("a preorder link given as a digit string", { preorder_links: [link_row(1)], preorders: [preorder_row(1)] }, "1")
cases << run("a preorder link with three authorized preorders", { preorder_links: [link_row(1)], preorders: [preorder_row(7), preorder_row(3), preorder_row(5)] })
%w[in_progress test_authorization_successful charge_successful cancelled].each do |state|
  cases << run("a preorder link whose only preorder is #{state}", { preorder_links: [link_row(1)], preorders: [preorder_row(1, state:)] })
end
cases << run("a preorder link with a mix of preorder states", { preorder_links: [link_row(1)], preorders: [preorder_row(1, state: "in_progress"), preorder_row(2), preorder_row(3, state: "cancelled"), preorder_row(4)] })
cases << run("authorized preorders of another preorder link", { preorder_links: [link_row(1), link_row(2)], preorders: [preorder_row(1, link: 2)] })
cases << run("an unreleased preorder link with an authorized preorder", { preorder_links: [link_row(1, state: "unreleased")], preorders: [preorder_row(1)] })
cases << run("a preorder link of the second id", { preorder_links: [link_row(1), link_row(2)], preorders: [preorder_row(1, link: 1), preorder_row(2, link: 2)] }, 2)
cases << run("a preorder link id given as a float", { preorder_links: [link_row(1)], preorders: [preorder_row(1)] }, 1.0)
cases << run("a preorder link id given as a word", { preorder_links: [link_row(1)], preorders: [preorder_row(1)] }, "abc")

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
