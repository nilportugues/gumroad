# frozen_string_literal: true

# Produces nextjs/src/worker/jobs/__fixtures__/backfill-orphaned-shown-products-in-profile-sections-job.golden.json:
# BackfillOrphanedShownProductsInProfileSectionsJob run by the real app against a scratch database as a Sidekiq job
# (support/sidekiq_executor.rb). Run it like delete-expired-oauth-device-authorizations-job.rb (env as in publish-scheduled-post.rb).
require_relative "support/rails_cases"
include RailsCases

OUT = Rails.root.join("nextjs/src/worker/jobs/__fixtures__/backfill-orphaned-shown-products-in-profile-sections-job.golden.json")
NOW = Time.utc(2026, 11, 4, 12, 30, 45, 123_000)
SEEDED_AT = "2026-01-01 00:00:00"
TABLES = %w[seller_profile_sections seller_profiles users links versions].freeze
BATCH_SIZE = Onetime::BackfillOrphanedShownProductsInProfileSections::BATCH_SIZE
PRODUCTS = "SellerProfileProductsSection"

Rails.logger = ActiveSupport::Logger.new(nil)

def user_row(id) = { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def profile_row(seller_id) = { id: seller_id, seller_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def link_row(id, user_id: 1, **overrides)
  { id:, name: "Product #{id}", user_id:, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def dead_link_row(id, **overrides) = link_row(id, deleted_at: SEEDED_AT, **overrides)

def data(shown, **overrides)
  { default_product_sort: "page_layout", shown_products: shown, show_filters: false, add_new_products: true }.merge(overrides)
end

def section_row(id, shown = [], seller_id: 1, type: PRODUCTS, json_data: nil, **overrides)
  { id:, seller_id:, type:, header: "Section #{id}", json_data: (json_data.nil? ? data(shown) : json_data).to_json, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def run(name, sections, links: [], users: [user_row(1)], profiles: [profile_row(1)])
  capture(name, now: NOW, tables: TABLES, seed: { seller_profile_sections: sections, seller_profiles: profiles, users:, links: }, sidekiq: true,
                job: "BackfillOrphanedShownProductsInProfileSectionsJob", args: []) do
    BackfillOrphanedShownProductsInProfileSectionsJob.new.perform
  end
end

cases = []
cases << run("no sections", [])
cases << run("a section with no shown products", [section_row(1)])
cases << run("a section whose products are all alive", [section_row(1, [10, 11])], links: [link_row(10), link_row(11)])
cases << run("a section with one deleted product", [section_row(1, [10, 11, 12])], links: [link_row(10), dead_link_row(11), link_row(12)])
cases << run("a section whose products are all deleted", [section_row(1, [10, 11])], links: [dead_link_row(10), dead_link_row(11)])
cases << run("a shown product that does not exist", [section_row(1, [10, 99])], links: [link_row(10)])
cases << run("a seller without a profile row", [section_row(1, [10, 11])], links: [link_row(10), dead_link_row(11)], profiles: [])
cases << run("a section whose seller no longer exists", [section_row(1, [10, 11], seller_id: 7)], links: [link_row(10), dead_link_row(11)], users: [user_row(1)])
cases << run("sections of two sellers", [section_row(1, [10, 11]), section_row(2, [20, 21], seller_id: 2)], links: [link_row(10), dead_link_row(11), dead_link_row(20, user_id: 2), link_row(21, user_id: 2)],
                                           users: [user_row(1), user_row(2)], profiles: [profile_row(1), profile_row(2)])
cases << run("several sections of one seller", [section_row(1, [10, 11]), section_row(2, [11, 12]), section_row(3, [12])], links: [link_row(10), dead_link_row(11), link_row(12)])
cases << run("other section types are skipped", [section_row(1, [10, 11], type: "SellerProfileFeaturedProductSection", json_data: { featured_product_id: 11 }),
                                                 section_row(2, [10, 11], type: "SellerProfilePostsSection", json_data: { shown_posts: [11] })], links: [dead_link_row(11)])
cases << run("a section of another product listing", [section_row(1, [10, 11], product_id: 10)], links: [link_row(10), dead_link_row(11)])
cases << run("a section with null json_data", [section_row(1).merge(json_data: nil)])
cases << run("a section whose json_data is an array", [section_row(1).merge(json_data: [10].to_json)], links: [dead_link_row(10)])
cases << run("a section whose json_data is a string", [section_row(1).merge(json_data: "text".to_json)])
cases << run("a section whose shown_products is not a list", [section_row(1, json_data: data(nil).merge(shown_products: "10"))], links: [dead_link_row(10)])
cases << run("a section with no shown_products key", [section_row(1, json_data: { default_product_sort: "newest" })], links: [dead_link_row(10)])
cases << run("a section left invalid by the cleanup", [section_row(1, [10, 10, 11])], links: [link_row(10), dead_link_row(11)])
cases << run("a section with a bad sort that cannot be saved", [section_row(1, json_data: data([10, 11], default_product_sort: "oldest")), section_row(2, [10, 11])], links: [link_row(10), dead_link_row(11)])
cases << run("a section with an extra key that cannot be saved", [section_row(1, json_data: data([10, 11], extra: 1)), section_row(2, [10, 11])], links: [link_row(10), dead_link_row(11)])
cases << run("a section holding a string id", [section_row(1, json_data: data(["10", 11]))], links: [link_row(10), dead_link_row(11)])
cases << run("a repeated shown product that is alive", [section_row(1, [10, 10])], links: [link_row(10)])
cases << run("a section left invalid by the cleanup and no profile row", [section_row(1, [10, 10, 11]), section_row(2, [10, 11])], links: [link_row(10), dead_link_row(11)], profiles: [])
cases << run("a section holding a float id", [section_row(1, json_data: data([10.0, 11]))], links: [link_row(10), dead_link_row(11)])
cases << run("a section holding a null id", [section_row(1, json_data: data([nil, 11]))], links: [dead_link_row(11)])
cases << run("a section holding an id past 2**53", [section_row(1, json_data: data([2**53 + 1, 11]))], links: [dead_link_row(11)])
cases << run("one batch of sections", (1..BATCH_SIZE).map { section_row(_1) })
cases << run("one section past a batch", (1..(BATCH_SIZE + 1)).map { section_row(_1) } + [], links: [])
cases << run("a dead product in the section past a batch", (1..BATCH_SIZE).map { section_row(_1) } + [section_row(BATCH_SIZE + 1, [10, 11])], links: [link_row(10), dead_link_row(11)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases.each { _1.delete("rows"); _1.delete("seed") } }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
