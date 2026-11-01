# frozen_string_literal: true

# Static data the product editor's props read from Ruby constants: the Discover taxonomy labels and the
# shipping countries. Regenerate edit-data.generated.json with
#   bundle exec rails runner nextjs/src/server/page-props/seller-products/dump-edit-data.rb
out = {
  "taxonomy_labels" => Discover::TaxonomyPresenter::TAXONOMY_LABELS,
  "shipping_countries" => ShippingDestination::Destinations.shipping_countries.map { |code, name| { "code" => code, "name" => name } },
}
File.write(Rails.root.join("nextjs/src/server/page-props/seller-products/edit-data.generated.json"), JSON.pretty_generate(out) + "\n")
