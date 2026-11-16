# frozen_string_literal: true

# Writes the constant data the Discover pages render, for
# src/server/presenters/discover/discover-data.generated.json:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-discover-data.rb
#
# Re-run it when Discover::TaxonomyPresenter::TAXONOMY_LABELS, config/discover_meta_tags.yml or the
# single-unit currencies change.
require "json"

data = {
  "generated_by" => "nextjs/scripts/dump-discover-data.rb",
  "taxonomy_labels" => Discover::TaxonomyPresenter::TAXONOMY_LABELS,
  "meta_tags" => DISCOVER_META_TAGS,
  "bot_user_agents" => BOT_MAP.keys,
  "single_unit_currencies" => CURRENCY_CHOICES.select { |_, currency| currency.key?("single_unit") }.keys,
}

path = File.expand_path("../src/server/presenters/discover/discover-data.generated.json", __dir__)
FileUtils.mkdir_p(File.dirname(path))
File.write(path, "#{JSON.pretty_generate(data)}\n")
puts "wrote #{path}"
