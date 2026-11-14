# frozen_string_literal: true

require "spec_helper"

# Writes nextjs/src/server/page-props/seller-products/__fixtures__/editor-revision.golden.json (PARITY_GOLDEN=1): the
# fingerprint Product::EditorRevision digests for a product with none of the collections it covers, or with versions
# only, and the digest under a fixed secret. edit.test.ts rebuilds both from the recorded rows (`variant_rows`,
# `category_rows`: the plucked non-timestamp columns the digests are taken over). Without PARITY_GOLDEN the example
# only checks the digest's shape.
describe Product::EditorRevision, "golden" do
  SECRET = "golden-secret-key-base"

  it "records the fingerprint and digest of products without collections" do
    seller = create(:user)
    cases = {
      "plain" => {},
      "same_rich_content_flag" => { has_same_rich_content_for_all_variants: true },
    }.to_h do |name, attributes|
      product = create(:product, user: seller, **attributes)
      json = described_class.send(:fingerprint, product).to_json
      [name, { "id" => product.id, "flags" => product.flags, "fingerprint" => json, "digest" => OpenSSL::HMAC.hexdigest("SHA256", SECRET, json).first(32) }]
    end

    versioned = create(:product, user: seller)
    category = create(:variant_category, link: versioned, title: "Edition")
    create(:variant, variant_category: category, name: "Standard", price_difference_cents: 0)
    create(:variant, variant_category: category, name: "Deluxe", description: "With extras", price_difference_cents: 500, max_purchase_count: 10)
    create(:variant_category, link: versioned, title: "Gone").mark_deleted!
    json = described_class.send(:fingerprint, versioned).to_json
    variant_columns = BaseVariant.column_names - %w[updated_at created_at]
    category_columns = VariantCategory.column_names - %w[updated_at created_at]
    cases["versions"] = {
      "id" => versioned.id, "flags" => versioned.flags, "fingerprint" => json, "digest" => OpenSSL::HMAC.hexdigest("SHA256", SECRET, json).first(32),
      "variant_rows" => BaseVariant.alive.where(variant_category_id: versioned.variant_categories.alive.select(:id)).order(:id).map { |row| variant_columns.index_with { row[_1] } },
      "category_rows" => versioned.variant_categories.alive.order(:id).map { |row| category_columns.index_with { row[_1] } },
    }

    expect(cases.values.map { _1["digest"] }).to all(match(/\A\h{32}\z/))
    next unless ENV["PARITY_GOLDEN"]

    path = Rails.root.join("nextjs/src/server/page-props/seller-products/__fixtures__/editor-revision.golden.json")
    FileUtils.mkdir_p(path.dirname)
    File.write(path, JSON.pretty_generate({ "secret" => SECRET, "cases" => cases }) + "\n")
  end
end
