# frozen_string_literal: true

# Produces nextjs/src/server/search/__fixtures__/audience-member-filter-query.golden.json: the Elasticsearch query
# AudienceMember.filter_query builds (the body of AudienceMember.filter_count's `_count` request) for every param set
# audience-member-filter.rb pins the SQL of, plus the params it rejects. Pure: no database rows are read.
#
#   bundle exec rails runner nextjs/scripts/golden/audience-member-filter-query.rb   (env as in publish-scheduled-post.rb)
require "json"

SOURCE = Rails.root.join("nextjs/src/server/models/__fixtures__/audience-member-filter.golden.json")
OUT = Rails.root.join("nextjs/src/server/search/__fixtures__/audience-member-filter-query.golden.json")

all_params = JSON.parse(File.read(SOURCE)).fetch("cases").filter_map { _1["params"] }.uniq
cases = all_params.map do |params|
  symbolized = params.deep_symbolize_keys
  begin
    { "params" => params, "query" => AudienceMember.filter_query(seller_id: 1, params: symbolized).as_json, "error" => nil }
  rescue StandardError => e
    { "params" => params, "query" => nil, "error" => { "class" => e.class.name, "message" => e.message } }
  end
end

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
