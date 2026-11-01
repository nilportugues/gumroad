# frozen_string_literal: true

require "spec_helper"

# Writes nextjs/src/server/page-props/seller-products/__fixtures__/editor-revision.golden.json (PARITY_GOLDEN=1): the
# fingerprint Product::EditorRevision digests for a product with none of the five collections it covers, and the digest
# under a fixed secret. edit.test.ts rebuilds both. Without PARITY_GOLDEN the example only checks the digest's shape.
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

    expect(cases.values.map { _1["digest"] }).to all(match(/\A\h{32}\z/))
    next unless ENV["PARITY_GOLDEN"]

    path = Rails.root.join("nextjs/src/server/page-props/seller-products/__fixtures__/editor-revision.golden.json")
    FileUtils.mkdir_p(path.dirname)
    File.write(path, JSON.pretty_generate({ "secret" => SECRET, "cases" => cases }) + "\n")
  end
end
