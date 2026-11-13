# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/record-utm-link-visit-job.golden.json:
# RecordUtmLinkVisitJob run by the real app against a scratch database as a Sidekiq job (support/sidekiq_executor.rb). A visit that
# gets as far as creating the link or recording the visit is what Node hands back (both write, inside PaperTrail's request metadata);
# those cases are recorded up to that call, which a marker exception stands in for. Run it like
# send-workflow-email-to-opened-non-clicker-job.rb (USE_DB_WORKER_REPLICAS=true).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/record-utm-link-visit-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[users utm_links].freeze

Rails.logger = ActiveSupport::Logger.new(nil)

class HandBackMarker < Exception; end # rubocop:disable Lint/InheritException

UtmLinkVisitRecorder.prepend(Module.new do
  private
    def track_visit(*) = raise(HandBackMarker)
    def auto_create_utm_link(*) = raise(HandBackMarker)
end)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products", user_risk_state: "compliant", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def link_row(id, **overrides)
  { id:, seller_id: 1, title: "Link #{id}", target_resource_type: "product_page", target_resource_id: 7, permalink: format("%08d", id), utm_campaign: "z", utm_medium: "y", utm_source: "x",
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

PARAMS = { "utm_source" => "x", "utm_medium" => "y", "utm_campaign" => "z", "utm_term" => nil, "utm_content" => nil }.freeze

def visit(**overrides)
  { "seller_id" => 1, "target_resource_type" => "product_page", "target_resource_id" => 7, "utm_params" => PARAMS, "user_id" => 2, "referrer" => "https://example.com/r",
    "ip_address" => "54.234.242.13", "user_agent" => "UA", "browser_guid" => "guid-1", "visited_at_us" => 1_793_795_445_123_456,
    "paper_trail" => { "remote_ip" => "54.234.242.13", "request_path" => "/l/abc", "request_uuid" => "uuid-1" } }.merge(overrides.transform_keys(&:to_s))
end

def run(name, visit = visit(), links: [], users: [1, 2])
  hands_back = false
  result = capture(name, now: NOW, tables: TABLES, seed: { users: users.map { user_row(_1) }, utm_links: links }, sidekiq: true, job: "RecordUtmLinkVisitJob", args: [visit]) do
    RecordUtmLinkVisitJob.new.perform(visit)
  rescue HandBackMarker
    hands_back = true
  end
  result.delete("rows")
  result.delete("seed")
  result.merge("hands_back" => hands_back)
end

def params(**overrides) = PARAMS.merge(overrides.transform_keys(&:to_s))

cases = []
cases << run("a visit to a link that does not exist yet")
cases << run("a visit to a link that exists", links: [link_row(1)])
cases << run("a visit to a link the seller paused", links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit to a link that was deleted", links: [link_row(1, deleted_at: SEEDED_AT)])
cases << run("a visit to a link that was deleted and paused", links: [link_row(1, deleted_at: SEEDED_AT, disabled_at: SEEDED_AT)])
cases << run("a visit to a link of another seller that is paused", links: [link_row(1, seller_id: 2, disabled_at: SEEDED_AT)])
cases << run("a visit to a link of another seller that is live", links: [link_row(1, seller_id: 2)])
cases << run("a visit to two links, the older paused", links: [link_row(1, disabled_at: SEEDED_AT), link_row(2)])
cases << run("a visit to two links, the older live", links: [link_row(1), link_row(2, disabled_at: SEEDED_AT)])
cases << run("a visit to a link with other parameters", links: [link_row(1, utm_source: "other", disabled_at: SEEDED_AT)])
cases << run("a visit to a link of another product", links: [link_row(1, target_resource_id: 8, disabled_at: SEEDED_AT)])
cases << run("a visit to a link of another page type", links: [link_row(1, target_resource_type: "post_page", disabled_at: SEEDED_AT)])
cases << run("a seller that does not exist", visit("seller_id" => 99), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a seller of zero", visit("seller_id" => 0))
cases << run("a nil seller", visit("seller_id" => nil))
cases << run("a seller given as a String", visit("seller_id" => "1"), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a user that does not exist", visit("user_id" => 99), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a nil user", visit("user_id" => nil), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a false user", visit("user_id" => false), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a user of zero", visit("user_id" => 0), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a user given as a String", visit("user_id" => "2"), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with no user key", visit.except("user_id"), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a profile page visit with no resource", visit("target_resource_type" => "profile_page", "target_resource_id" => nil), links: [link_row(1, target_resource_type: "profile_page", target_resource_id: nil, disabled_at: SEEDED_AT)])
cases << run("a profile page visit to a new link", visit("target_resource_type" => "profile_page", "target_resource_id" => nil))
cases << run("a subscribe page visit", visit("target_resource_type" => "subscribe_page", "target_resource_id" => nil), links: [link_row(1, target_resource_type: "subscribe_page", target_resource_id: nil, disabled_at: SEEDED_AT)])
cases << run("a post page visit", visit("target_resource_type" => "post_page", "target_resource_id" => 9), links: [link_row(1, target_resource_type: "post_page", target_resource_id: 9, disabled_at: SEEDED_AT)])
cases << run("a resource id given as a String", visit("target_resource_id" => "7"), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with a term and a content", visit("utm_params" => params(utm_term: "t", utm_content: "c")), links: [link_row(1, utm_term: "t", utm_content: "c", disabled_at: SEEDED_AT)])
cases << run("a visit with a term only", visit("utm_params" => params(utm_term: "t")), links: [link_row(1, utm_term: "t", disabled_at: SEEDED_AT)])
cases << run("a visit with the required parameters only", visit("utm_params" => { "utm_source" => "x", "utm_medium" => "y", "utm_campaign" => "z" }), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with the parameters in another order", visit("utm_params" => { "utm_campaign" => "z", "utm_source" => "x", "utm_medium" => "y", "utm_content" => nil, "utm_term" => nil }), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with no parameters", visit("utm_params" => {}), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with blank parameters", visit("utm_params" => params(utm_source: "", utm_term: "")), links: [link_row(1, utm_source: "", utm_term: "", disabled_at: SEEDED_AT)])
cases << run("a visit with a quote and a backslash in a parameter", visit("utm_params" => params(utm_source: "it's \\ a \"test\"")), links: [link_row(1, utm_source: "it's \\ a \"test\"", disabled_at: SEEDED_AT)])
cases << run("a visit with a multibyte parameter", visit("utm_params" => params(utm_campaign: "été 日本 🎉")), links: [link_row(1, utm_campaign: "été 日本 🎉", disabled_at: SEEDED_AT)])
cases << run("a visit with a parameter of another case", visit("utm_params" => params(utm_source: "X")), links: [link_row(1, disabled_at: SEEDED_AT)])
cases << run("a visit with a parameter over the length limit", visit("utm_params" => params(utm_source: "a" * 250)))
cases << run("a visit with a parameter that is not a String", visit("utm_params" => params(utm_source: 5)))
cases << run("a visit with an unknown parameter", visit("utm_params" => params(utm_foo: "bar")))
cases << run("a visit with an unknown page type", visit("target_resource_type" => "bogus"))
cases << run("a visit with no page type", visit("target_resource_type" => nil))
cases << run("a visit with no utm parameters at all", visit("utm_params" => nil))
cases << run("a visit with no paper trail", visit("paper_trail" => nil))
cases << run("a visit with no visit time", visit("visited_at_us" => nil))
cases << run("a visit with a visit time given as a String", visit("visited_at_us" => "5"))
cases << run("a visit with a visit time given as a Float", visit("visited_at_us" => 1.5e15))

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
