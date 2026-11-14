# frozen_string_literal: true

require "spec_helper"

# Records every request the Elasticsearch transport performs while a log is set, with its answer.
module InstallmentSearchExchangeLog
  def perform_request(method, path, params = {}, body = nil, *rest)
    response = super
    Thread.current[:installment_search_exchange_log]&.push(
      "method" => method, "path" => path, "query" => params.to_h.sort.to_h.transform_keys(&:to_s).transform_values(&:to_s),
      "body" => body.is_a?(String) ? body : body.to_json, "status" => response.status, "response" => response.body
    )
    response
  end
end
Elasticsearch::Transport::Transport::Base.prepend(InstallmentSearchExchangeLog)

# The searches PaginatedInstallmentsPresenter makes, recorded against the real Elasticsearch for the
# Next.js port: nextjs/src/server/page-props/emails/installment-search.ts must send these bodies and read
# these answers (nextjs/src/server/page-props/emails/__fixtures__/installment-search.golden.json).
#
#   INSTALLMENT_SEARCH_GOLDEN=1 bundle exec rspec spec/services/installment_search_service_golden_spec.rb
describe "InstallmentSearchService golden", :elasticsearch_wait_for_refresh do
  golden_path = Rails.root.join("nextjs/src/server/page-props/emails/__fixtures__/installment-search.golden.json")
  recorded = []

  after(:all) do
    File.write(golden_path, JSON.pretty_generate("cases" => recorded) + "\n") if ENV["INSTALLMENT_SEARCH_GOLDEN"] && recorded.any?
  end

  let(:seller) { create(:user) }

  define_method(:search) do |name, type:, query:, page: 1|
    offset = (page - 1) * 25
    options = { exclude_deleted: true, type:, exclude_workflow_installments: true, seller:, q: query, fields: %w[name message], from: offset, size: 25, sort: [:_score, { created_at: :desc }, { id: :desc }] }
    log = Thread.current[:installment_search_exchange_log] = []
    result = InstallmentSearchService.search(options)
    ids = result.records.map(&:id)
    recorded << { "name" => name, "seller_id" => seller.id, "type" => type, "query" => query, "page" => page, "ids" => ids, "total" => result.results.total, "exchanges" => log }
    ids
  ensure
    Thread.current[:installment_search_exchange_log] = nil
  end

  it "finds published, scheduled and draft posts by name and message and leaves out workflow and deleted ones" do
    launch = create(:audience_installment, seller:, name: "Launch week", message: "<p>Big news</p>", published_at: Time.utc(2025, 1, 5), created_at: Time.utc(2025, 1, 1))
    news = create(:audience_installment, seller:, name: "Weekly digest", message: "<p>Launch notes</p>", published_at: Time.utc(2025, 1, 6), created_at: Time.utc(2025, 1, 2))
    create(:audience_installment, seller:, name: "Launch hidden", published_at: Time.utc(2025, 1, 7), deleted_at: Time.utc(2025, 1, 8))
    create(:audience_installment, seller: create(:user), name: "Launch elsewhere", published_at: Time.utc(2025, 1, 7))
    scheduled = create(:audience_installment, seller:, name: "Launch scheduled", ready_to_publish: true)
    create(:installment_rule, installment: scheduled, to_be_published_at: 2.days.from_now)
    draft = create(:audience_installment, seller:, name: "Launch draft")
    index_model_records(Installment)

    expect(search("published by name and message", type: "published", query: "launch")).to match_array([launch.id, news.id])
    expect(search("scheduled", type: "scheduled", query: "  Launch ")).to eq([scheduled.id])
    expect(search("draft", type: "draft", query: "launch")).to eq([draft.id])
    expect(search("no match", type: "published", query: "zzz")).to eq([])
    expect(search("past the last page", type: "published", query: "launch", page: 2)).to eq([])
  end
end
