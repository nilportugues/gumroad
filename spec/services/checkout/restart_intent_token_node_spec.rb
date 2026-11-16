# frozen_string_literal: true

require "spec_helper"

# Tokens the Next.js port issued (nextjs/src/server/services/checkout-restart-intent-token.ts, pinned by its test) must verify under Rails'
# own message verifier, signed with the secret the golden names. The clock is far in the future so the one-hour expiry has not passed.
describe Checkout::RestartIntentToken do
  let(:golden) { JSON.parse(Rails.root.join("spec/support/fixtures/restart_intent_token_node.json").read) }
  let(:verifiers) do
    secret = golden.fetch("secret_key_base")
    ActiveSupport::MessageVerifiers.new { |salt, **| Rails.application.key_generator(secret).generate_key(salt) }.rotate_defaults
  end
  let(:verifier) { verifiers[described_class::PURPOSE] }

  before { allow(Rails.application).to receive(:message_verifier).with(described_class::PURPOSE).and_return(verifier) }

  it "verifies every token Node issued, with the payload Node signed" do
    golden.fetch("tokens").each do |entry|
      payload = verifier.verified(entry.fetch("token"), purpose: described_class::PURPOSE)

      expect(payload).to eq("product_id" => entry["product_id"], "buyer_id" => entry["buyer_id"], "issued_at" => entry["issued_at"])
    end
  end

  it "reads a Node token as intent for the product and buyer it names" do
    golden.fetch("tokens").each do |entry|
      product = instance_double(Link, id: entry["product_id"])
      buyer = entry["buyer_id"] && instance_double(User, id: entry["buyer_id"])

      expect(described_class.restart_intended?(entry["token"], product:, buyer:, lapsed_at: Time.at(entry["issued_at"]))).to eq(true)
      expect(described_class.restart_intended?(entry["token"], product:, buyer:, lapsed_at: Time.at(entry["issued_at"] + 1))).to eq(false)
    end
  end

  it "does not read a Node token as intent for another product" do
    entry = golden.fetch("tokens").first

    expect(described_class.restart_intended?(entry["token"], product: instance_double(Link, id: entry["product_id"] + 1), buyer: nil, lapsed_at: Time.at(0))).to eq(false)
  end
end
