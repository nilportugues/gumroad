# frozen_string_literal: true

require "spec_helper"

# Api::V2::LicensesController through the full Rack stack, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. A purchase the port cannot serialize (several variants, a SKU, a gift, a file
# custom field, a recurring charge) is recorded as what Node hands back.
describe "API v2 licenses", type: :request do
  include Parity::ApiV2Requests
  include Parity::MobileApi

  let(:seller) { create(:user, name: "License Seller", email: "license-seller@example.com") }
  let(:product) { create(:product, user: seller, name: "Licensed", unique_permalink: "licensed", custom_permalink: "maxlicense", is_licensed: true) }
  let(:sale) { purchase_row(link: product, seller:, email: "buyer@example.com", purchase_state: "successful", quantity: 1) }
  let!(:license) { create(:license, link: product, purchase: sale, serial: "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD", uses: 0) }
  let(:key) { license.serial }

  def verify(params = {}, options = {}) = api_call(:post, "/licenses/verify", params:, **options)

  def write(action, params = {}, options = {})
    api_call(:put, "/licenses/#{action}", params:, token: options.fetch(:token) { api_token(seller) })
  end

  # Creating the customer of a licensed product mints its license.
  def imported_license(uses: 0)
    customer = create(:imported_customer, link_id: product.id, importing_user: seller, email: "imported@example.com", purchase_date: 3.days.ago)
    customer.license.tap { |imported| imported.update_columns(serial: "55555555-66666666-77777777-88888888", uses:) }
  end

  describe "POST /licenses/verify" do
    it "verifies a license by product id and counts the use", parity: true do
      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "uses" => 1)
      expect(response.parsed_body["purchase"]).to include("license_key" => key, "refunded" => false, "chargebacked" => false)
      expect(license.reload.uses).to eq(1)
    end

    it "verifies a license by unique permalink", parity: true do
      verify(product_permalink: product.unique_permalink, license_key: key)

      expect(response.parsed_body["uses"]).to eq(1)
    end

    it "verifies a license by custom permalink in another case", parity: true do
      verify(product_permalink: "MaxLicense", license_key: key)

      expect(response.parsed_body["uses"]).to eq(1)
    end

    it "verifies a license by the legacy id parameter", parity: true do
      verify(id: product.unique_permalink, license_key: key)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "verifies a license by the legacy link_id parameter", parity: true do
      verify(link_id: product.custom_permalink, license_key: key)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "verifies a license through the /api prefix on the Gumroad domain", parity: true do
      verify({ product_id: product.external_id, license_key: key }, api_host: false)

      expect(response.parsed_body["uses"]).to eq(1)
    end

    it "does not count the use when increment_uses_count is the string false", parity: true do
      verify(product_id: product.external_id, license_key: key, increment_uses_count: "false")

      expect(response.parsed_body["uses"]).to eq(0)
      expect(license.reload.uses).to eq(0)
    end

    it "does not count the use when increment_uses_count is a JSON false", parity: true do
      verify({ product_id: product.external_id, license_key: key, increment_uses_count: false }, as: :json)

      expect(response.parsed_body["uses"]).to eq(0)
    end

    it "counts the use when increment_uses_count is anything else", parity: true do
      license.update_column(:uses, 4)

      verify(product_id: product.external_id, license_key: key, increment_uses_count: "0")

      expect(response.parsed_body["uses"]).to eq(5)
    end

    it "serializes the quantity of the purchase", parity: true do
      sale.update_column(:quantity, 3)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["quantity"]).to eq(3)
    end

    it "serializes the buyer and the card of the purchase", parity: true do
      sale.update_columns(full_name: "Ada Buyer", referrer: "twitter.com", card_type: "visa", card_visual: "**** **** **** 4242", ip_country: "United States", can_contact: false)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("full_name" => "Ada Buyer", "referrer" => "twitter.com", "ip_country" => "United States", "can_contact" => false)
    end

    it "serializes a test purchase by the seller", parity: true do
      sale.update_column(:purchaser_id, seller.id)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("test" => true, "purchaser_id" => seller.external_id)
    end

    it "serializes a multiseat license", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_multiseat_license])

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["is_multiseat_license"]).to eq(true)
    end

    it "serializes a discover fee and a dispute that was won", parity: true do
      sale.update_columns(chargeback_date: 1.day.ago, flags: sale.flags | Purchase.flag_mapping["flags"][:chargeback_reversed] | Purchase.flag_mapping["flags"][:was_discover_fee_charged])

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("chargebacked" => false, "disputed" => true, "dispute_won" => true, "discover_fee_charged" => true)
    end

    it "serializes a refunded purchase", parity: true do
      sale.update_column(:stripe_refunded, true)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["refunded"]).to eq(true)
    end

    it "serializes a chargebacked purchase", parity: true do
      sale.update_column(:chargeback_date, 1.day.ago)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("chargebacked" => true, "disputed" => true)
    end

    it "serializes a purchase of a product that is not licensed, with no key", parity: true do
      product.update_column(:flags, product.flags & ~Link.flag_mapping["flags"][:is_licensed])

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).not_to include("license_key")
    end

    it "serializes a membership with its subscription dates", parity: true do
      membership = create(:membership_product, user: seller, subscription_duration: :monthly)
      subscription = create(:subscription, link: membership, user: nil)
      original = purchase_row(link: membership, seller:, subscription:, is_original_subscription_purchase: true, purchase_state: "successful")
      member_license = create(:license, link: membership, purchase: original, serial: "11111111-22222222-33333333-44444444")
      subscription.update_columns(ended_at: Time.utc(2026, 10, 1, 12), cancelled_at: Time.utc(2026, 10, 2, 12), failed_at: Time.utc(2026, 10, 3, 12))

      verify(product_id: membership.external_id, license_key: member_license.serial)

      expect(response.parsed_body["purchase"]).to include("subscription_ended_at", "subscription_cancelled_at", "subscription_failed_at", "recurrence" => "monthly")
    end

    it "serializes a membership whose subscription is alive", parity: true do
      membership = create(:membership_product, user: seller, subscription_duration: :monthly)
      subscription = create(:subscription, link: membership, user: nil)
      original = purchase_row(link: membership, seller:, subscription:, is_original_subscription_purchase: true, purchase_state: "successful")
      member_license = create(:license, link: membership, purchase: original, serial: "11111111-22222222-33333333-44444444")

      verify(product_id: membership.external_id, license_key: member_license.serial)

      expect(response.parsed_body["purchase"]).to include("subscription_id" => subscription.external_id, "subscription_ended_at" => nil)
    end

    describe "a membership's later charges" do
      let(:membership) { create(:membership_product, user: seller, subscription_duration: :monthly) }
      let(:subscription) { create(:subscription, link: membership, user: nil) }
      let!(:original) { purchase_row(link: membership, seller:, subscription:, is_original_subscription_purchase: true, purchase_state: "successful") }

      it "serializes a license held by a recurring charge", parity: true do
        charge = purchase_row(link: membership, seller:, subscription:, email: "member@example.com", purchase_state: "successful")
        charge_license = create(:license, link: membership, purchase: charge, serial: "11111111-22222222-33333333-44444444")

        verify(product_id: membership.external_id, license_key: charge_license.serial)

        expect(response.parsed_body["purchase"]).to include("subscription_id" => subscription.external_id, "recurrence" => "monthly", "is_recurring_charge" => true)
        expect(response.parsed_body["purchase"]["id"]).to eq(ObfuscateIds.encrypt(charge.id))
      end

      it "lists no custom fields for a recurring charge whose original purchase has some, but keeps their place in the payload", parity: true do
        PurchaseCustomField.create!(purchase: original, field_type: "text", name: "Company", value: "Example Inc")
        PurchaseCustomField.create!(purchase: original, field_type: "checkbox", name: "Newsletter", value: true)
        PurchaseCustomField.create!(purchase: original, field_type: "file", name: "Upload", value: nil)
        charge = purchase_row(link: membership, seller:, subscription:, email: "member@example.com", purchase_state: "successful")
        charge_license = create(:license, link: membership, purchase: charge, serial: "11111111-22222222-33333333-44444444")

        verify(product_id: membership.external_id, license_key: charge_license.serial)

        expect(response.parsed_body["purchase"]).to include("custom_fields" => [])
        expect(response.parsed_body["purchase"]).not_to include("Company")
        expect(response.parsed_body["purchase"].keys.index("custom_fields")).to be < response.parsed_body["purchase"].keys.index("recurrence")
      end

      it "leaves out the custom fields of an archived original purchase", parity: true do
        PurchaseCustomField.create!(purchase: original, field_type: "text", name: "Company", value: "Example Inc")
        original.update_column(:flags, original.flags | Purchase.flag_mapping["flags"][:is_archived_original_subscription_purchase])
        charge = purchase_row(link: membership, seller:, subscription:, email: "member@example.com", purchase_state: "successful")
        charge_license = create(:license, link: membership, purchase: charge, serial: "11111111-22222222-33333333-44444444")

        verify(product_id: membership.external_id, license_key: charge_license.serial)

        expect(response.parsed_body["purchase"]).to include("custom_fields" => [])
        expect(response.parsed_body["purchase"].keys.index("custom_fields")).to be > response.parsed_body["purchase"].keys.index("recurrence")
      end

      it "serializes the custom fields of a charge ahead of the original purchase's", parity: true do
        PurchaseCustomField.create!(purchase: original, field_type: "text", name: "Company", value: "Example Inc")
        charge = purchase_row(link: membership, seller:, subscription:, email: "member@example.com", purchase_state: "successful")
        PurchaseCustomField.create!(purchase: charge, field_type: "text", name: "Seat", value: "12")
        charge_license = create(:license, link: membership, purchase: charge, serial: "11111111-22222222-33333333-44444444")

        verify(product_id: membership.external_id, license_key: charge_license.serial)

        expect(response.parsed_body["purchase"]).to include("Seat" => "12", "custom_fields" => ["Seat: 12"])
      end
    end

    it "serializes a license of an imported customer", parity: true do
      imported = imported_license

      verify(product_id: product.external_id, license_key: imported.serial)

      expect(response.parsed_body["imported_customer"]).to include("email" => "imported@example.com", "is_imported_customer" => true)
      expect(response.parsed_body["imported_customer"]).not_to include("license_key")
    end

    it "serializes a license that has neither a purchase nor an imported customer", parity: true do
      orphan = License.create!(link: product, serial: "99999999-AAAAAAAA-BBBBBBBB-CCCCCCCC", uses: 2)

      verify(product_id: product.external_id, license_key: orphan.serial)

      expect(response.parsed_body).to eq("success" => true, "uses" => 3)
    end

    it "refuses a disabled license", parity: true do
      license.update_column(:disabled_at, 1.day.ago)

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "This license key has been disabled.")
      expect(license.reload.uses).to eq(0)
    end

    it "refuses a purchase whose access was revoked", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_access_revoked])

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Access to the purchase associated with this license has expired.")
    end

    it "does not find an unknown license key", parity: true do
      verify(product_id: product.external_id, license_key: "does-not-exist")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "message" => "That license does not exist for the provided product.")
    end

    it "does not find a request without a license key", parity: true do
      verify(product_id: product.external_id)

      expect(response).to have_http_status(:not_found)
    end

    it "does not find a license through another product's id", parity: true do
      other = create(:product, user: seller, is_licensed: true)

      verify(product_id: other.external_id, license_key: key)

      expect(response).to have_http_status(:not_found)
    end

    it "does not find a license through an id that is not a product", parity: true do
      verify(product_id: "not-an-id", license_key: key)

      expect(response).to have_http_status(:not_found)
    end

    it "does not find a license through a permalink of another product", parity: true do
      other = create(:product, user: seller, unique_permalink: "elsewhere")

      verify(product_permalink: other.unique_permalink, license_key: key)

      expect(response).to have_http_status(:not_found)
      expect(license.reload.uses).to eq(0)
    end

    it "does not find a license without a product id or permalink", parity: true do
      verify(license_key: key)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a license key that is not a string", parity: true do
      verify("product_id" => product.external_id, "license_key" => [key])

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body).to eq("success" => false, "message" => "The 'license_key' parameter must be a string.")
    end

    it "refuses a product id that is not a string", parity: true do
      verify("product_id" => { "a" => "b" }, "license_key" => key)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("The 'product_id' parameter must be a string.")
    end

    it "refuses a legacy link id that is not a string", parity: true do
      verify("link_id" => ["x"], "license_key" => key)

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body["message"]).to eq("The 'link_id' parameter must be a string.")
    end

    context "when the product id is required" do
      before { create(:product, custom_permalink: product.unique_permalink) }

      it "answers 500 for a product created after the cutoff", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, "2000-01-01 00:00:00 UTC")

        verify(product_permalink: product.unique_permalink, license_key: key)

        expect(response).to have_http_status(:internal_server_error)
        expect(response.parsed_body["message"]).to eq("The 'product_id' parameter is required to verify the license for this product. Please set 'product_id' to '#{product.external_id}' in the request.")
        expect(license.reload.uses).to eq(0)
      end

      it "answers 500 when the permalink does not match the product", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, "2000-01-01 00:00:00 UTC")

        verify(product_permalink: "nothing-like-it", license_key: key)

        expect(response).to have_http_status(:internal_server_error)
      end

      it "verifies a product created before the cutoff", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, "2099-01-01 00:00:00 UTC")

        verify(product_permalink: product.unique_permalink, license_key: key)

        expect(response.parsed_body["success"]).to eq(true)
      end

      it "verifies when the product skips the check", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, "2000-01-01 00:00:00 UTC")
        Redis::Namespace.new(:license_verifications, redis: $redis).set("skip_product_id_check_#{product.id}", true)

        verify(product_permalink: product.unique_permalink, license_key: key)

        expect(response.parsed_body["success"]).to eq(true)
      end

      it "verifies when no cutoff is set", parity: true do
        verify(product_permalink: product.unique_permalink, license_key: key)

        expect(response.parsed_body["success"]).to eq(true)
      end

      it "verifies with a product id whatever the cutoff", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, "2000-01-01 00:00:00 UTC")

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["success"]).to eq(true)
      end
    end

    describe "a request that carries a token" do
      def expect_verified(uses: 1)
        expect(response).to have_http_status(:ok)
        expect(response.parsed_body).to include("success" => true, "uses" => uses)
      end

      it "verifies a license for a bearer token and does not mark the seller as a CLI user", parity: true do
        verify({ product_id: product.external_id, license_key: key }, token: api_token(seller))

        expect_verified
        expect(license.reload.uses).to eq(1)
        expect(seller.reload.has_used_cli?).to eq(false)
      end

      it "verifies a license for an access_token parameter", parity: true do
        verify({ product_id: product.external_id, license_key: key, access_token: api_token(seller).token })

        expect_verified
      end

      it "verifies a license for a token that is revoked", parity: true do
        verify({ product_id: product.external_id, license_key: key }, token: api_token(seller, revoked_at: 1.day.ago))

        expect_verified
      end

      it "verifies a license for a bearer value that is no token", parity: true do
        verify({ product_id: product.external_id, license_key: key }, headers: { "Authorization" => "Bearer unknown-token" })

        expect_verified
      end

      it "verifies a license for the token of another seller", parity: true do
        verify({ product_id: product.external_id, license_key: key }, token: api_token(create(:user)))

        expect_verified
      end

      it "verifies a license for the CLI when the request carries no token", parity: true do
        verify({ product_id: product.external_id, license_key: key }, headers: { "User-Agent" => "gumroad-cli/1.2.3" })

        expect_verified
      end

      it "hands a verification from the CLI that carries a token to Rails", parity: true do
        verify({ product_id: product.external_id, license_key: key }, token: api_token(seller), headers: { "User-Agent" => "gumroad-cli/1.2.3" })

        expect_verified
        expect(seller.reload.has_used_cli?).to eq(true)
      end

      it "hands a verification that carries a token without an owner to Rails", parity: true do
        ownerless = create("doorkeeper/access_token", application: api_application, resource_owner_id: nil, scopes: "edit_products")

        verify({ product_id: product.external_id, license_key: key }, token: ownerless)

        expect(response).to have_http_status(:not_found)
      end
    end

    it "serializes a license of a purchase with a variant", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      sale.variant_attributes << create(:variant, variant_category: category, name: "Gold")

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]).to include("variants" => "(Gold)")
    end

    it "serializes a license of a purchase with the untitled variant", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      sale.variant_attributes << create(:variant, variant_category: category, name: "Untitled")

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "")
    end

    it "serializes a license of a purchase with a deleted variant", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      sale.variant_attributes << create(:variant, variant_category: category, name: "Retired", deleted_at: 1.day.ago)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Retired)")
    end

    it "hands a license of a purchase with several variants to Rails", parity: true do
      category = create(:variant_category, link: product, title: "Edition")
      other = create(:variant_category, link: product, title: "Format")
      sale.variant_attributes << create(:variant, variant_category: category, name: "Gold")
      sale.variant_attributes << create(:variant, variant_category: other, name: "PDF")

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]["variants"]).to eq("(Gold, PDF)")
    end

    it "serializes a license of a purchase with a SKU of a SKU-enabled product", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      sale.variant_attributes << Sku.create!(link: product, name: "Large", price_difference_cents: 0)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Large)")
    end

    it "serializes a license of a purchase with a SKU of a product with a version category", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      create(:variant_category, link: product, title: "Edition")
      sale.variant_attributes << Sku.create!(link: product, name: "Large", price_difference_cents: 0)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Large)")
    end

    it "serializes a license of a purchase with a SKU that has a custom name", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      sale.variant_attributes << Sku.create!(link: product, name: "Large", custom_sku: "LRG-1", price_difference_cents: 0)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Large)", "sku_id" => "LRG-1")
    end

    it "serializes a license of a purchase with a version of a SKU-enabled product", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      sale.variant_attributes << create(:variant, variant_category: create(:variant_category, link: product, title: "Edition"), name: "Gold")

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Gold)", "sku_id" => "pid_#{product.external_id}")
    end

    it "serializes a license of a purchase with a SKU of a product that is not SKU-enabled", parity: true do
      sale.variant_attributes << Sku.create!(link: product, name: "Large", custom_sku: "LRG-2", price_difference_cents: 0)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "(Large)")
      expect(response.parsed_body["purchase"]).not_to have_key("sku_id")
    end

    it "serializes a license of a purchase with the default SKU", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      default = Sku.create!(link: product, name: "Default", price_difference_cents: 0)
      default.update_columns(flags: default.flags | BaseVariant.flag_mapping["flags"][:is_default_sku])
      sale.variant_attributes << default

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "")
    end

    it "serializes a license of a purchase of a SKU-enabled product with no variant", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("variants" => "")
    end

    it "serializes a license of a purchase with a fixed offer code", parity: true do
      offer_code = create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100)
      sale.update_column(:offer_code_id, offer_code.id)

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]).to include("offer_code" => { "code" => "SAVE10", "displayed_amount_off" => "$1", "name" => "SAVE10" })
    end

    it "serializes a license of a purchase with a percentage offer code", parity: true do
      product.update!(price_cents: 1000)
      offer_code = create(:percentage_offer_code, user: seller, products: [product], code: "HALF", amount_percentage: 50)
      sale.update_column(:offer_code_id, offer_code.id)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("offer_code" => { "code" => "HALF", "displayed_amount_off" => "50%", "name" => "HALF" })
    end

    it "serializes a license of a purchase with a fixed offer code in cents", parity: true do
      offer_code = create(:offer_code, user: seller, products: [product], code: "SAVE1050", amount_cents: 1050)
      sale.update_column(:offer_code_id, offer_code.id)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["offer_code"]).to include("displayed_amount_off" => "$10.50")
    end

    it "serializes a license of a purchase with a deleted offer code", parity: true do
      offer_code = create(:offer_code, user: seller, products: [product], code: "OLD", amount_cents: 100)
      sale.update_column(:offer_code_id, offer_code.id)
      offer_code.update_column(:deleted_at, 1.day.ago)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["offer_code"]).to include("code" => "OLD")
    end

    it "serializes the discount the buyer got instead of the offer code as it is now", parity: true do
      offer_code = create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100)
      sale.update_column(:offer_code_id, offer_code.id)
      PurchaseOfferCodeDiscount.create!(purchase: sale, offer_code:, offer_code_amount: 25, offer_code_is_percent: true, pre_discount_minimum_price_cents: 100)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["offer_code"]).to include("code" => "SAVE10", "displayed_amount_off" => "25%")
    end

    it "serializes a license of a purchase with an offer code on a product priced in another currency", parity: true do
      product.update_columns(price_currency_type: "eur", price_cents: 1000)
      offer_code = create(:offer_code, user: seller, products: [product], code: "EUROS", amount_cents: 250, currency_type: "eur")
      sale.update_column(:offer_code_id, offer_code.id)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]["offer_code"]).to include("code" => "EUROS")
    end

    describe "gifts" do
      let(:gifter) { purchase_row(link: product, seller:, email: "gifter@example.com", price_cents: 700, purchase_state: "successful") }

      def gift!(**attributes)
        Gift.new(link: product, gifter_purchase: gifter, giftee_purchase: sale, gifter_email: "gifter@example.com", giftee_email: "buyer@example.com", **attributes).save!(validate: false)
      end

      it "serializes a license of a gifted purchase with the price the gifter paid", parity: true do
        gift!
        sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_gift_receiver_purchase])

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("is_gift_receiver_purchase" => true, "gift_price" => 700, "gifter_email" => "gifter@example.com")
      end

      it "serializes the email of the gifter's purchase, not the one the gift names", parity: true do
        gift!(gifter_email: "named@example.com")
        sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_gift_receiver_purchase])

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("gift_price" => 700, "gifter_email" => "gifter@example.com")
      end

      it "serializes a license of the purchase that was sent as a gift", parity: true do
        gift!
        sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_gift_sender_purchase])

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("is_gift_receiver_purchase" => false)
        expect(response.parsed_body["purchase"]).not_to include("gift_price")
      end
    end

    it "serializes a license of a purchase with custom fields", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "text", name: "Company", value: "Example Inc")
      PurchaseCustomField.create!(purchase: sale, field_type: "long_text", name: "Notes", value: "  two   words  ")
      PurchaseCustomField.create!(purchase: sale, field_type: "checkbox", name: "Newsletter", value: true)
      PurchaseCustomField.create!(purchase: sale, field_type: "terms", name: "Terms", value: false)

      verify(product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body["purchase"]).to include("Company" => "Example Inc", "custom_fields" => ["Company: Example Inc", "Notes: two words", "Newsletter: true", "Terms: false"])
    end

    it "serializes a custom field named like a key of the license response", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "text", name: "email", value: "other@example.com")

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("email" => "other@example.com")
    end

    it "serializes a custom field with no value", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "text", name: "Optional", value: nil)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("Optional" => "", "custom_fields" => ["Optional: "])
    end

    it "serializes a license of a purchase with a numeric custom field name", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "text", name: "42", value: "answer")

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("42" => "answer", "custom_fields" => ["42: answer"])
    end

    it "serializes a license of a purchase with a file custom field", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "file", name: "Upload", value: nil)

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("Upload" => "", "custom_fields" => ["Upload: "])
    end

    it "serializes a file custom field that carries a value next to a text one", parity: true do
      PurchaseCustomField.create!(purchase: sale, field_type: "text", name: "Company", value: "Example Inc")
      PurchaseCustomField.create!(purchase: sale, field_type: "file", name: "Upload", value: "  logo.png ")

      verify(product_id: product.external_id, license_key: key)

      expect(response.parsed_body["purchase"]).to include("Upload" => "logo.png", "custom_fields" => ["Company: Example Inc", "Upload: logo.png"])
    end

    describe "preorders" do
      let(:preorder) { create(:preorder, preorder_link: create(:preorder_link, link: product, release_at: Time.utc(2030, 1, 15, 12)), seller:, state: "authorization_successful") }

      it "serializes a license of a preorder authorization", parity: true do
        sale.update_columns(preorder_id: preorder.id, flags: sale.flags | Purchase.flag_mapping["flags"][:is_preorder_authorization])

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("is_preorder_authorization" => true)
      end

      it "serializes a license of the charge of a preorder", parity: true do
        sale.update_columns(preorder_id: preorder.id)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).not_to include("is_preorder_authorization")
      end
    end

    describe "affiliates" do
      let(:affiliate_user) { create(:user, email: "affiliate@example.com") }
      let(:affiliate) { create(:direct_affiliate, seller:, affiliate_user:, products: [product]) }

      def credit(purchase, amount_cents, **attributes)
        AffiliateCredit.new(purchase:, affiliate:, affiliate_user:, seller:, link: product, amount_cents:, fee_cents: 0, basis_points: 1000, **attributes).save!(validate: false)
      end

      it "serializes a license of an affiliate purchase with the credit it earned", parity: true do
        sale.update_columns(affiliate_id: affiliate.id, affiliate_credit_cents: 150)
        credit(sale, 150)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate" => "affiliate@example.com", "affiliate_credit_amount_cents" => 150)
      end

      it "serializes the unconfirmed email of the affiliate", parity: true do
        affiliate_user.update_column(:unconfirmed_email, "new-affiliate@example.com")
        sale.update_columns(affiliate_id: affiliate.id, affiliate_credit_cents: 200)
        credit(sale, 200)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate" => "new-affiliate@example.com", "affiliate_credit_amount_cents" => 200)
      end

      it "serializes an affiliate purchase that has no credit row", parity: true do
        sale.update_columns(affiliate_id: affiliate.id)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate" => "affiliate@example.com")
        expect(response.parsed_body["purchase"]).not_to include("affiliate_credit_amount_cents")
      end

      it "serializes a credit row of a purchase that names no affiliate", parity: true do
        credit(sale, 75)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate_credit_amount_cents" => 0)
        expect(response.parsed_body["purchase"]).not_to include("affiliate")
      end

      it "leaves the direct affiliate's credit out of a collaborator's amount", parity: true do
        collaborator = create(:collaborator, seller:, affiliate_user: create(:user, email: "collaborator@example.com"), products: [product])
        sale.update_columns(affiliate_id: collaborator.id, affiliate_credit_cents: 100, json_data: { "direct_affiliate_id" => affiliate.id, "direct_affiliate_credit_cents" => 40 })
        credit(sale, 60, affiliate: collaborator, affiliate_user: collaborator.affiliate_user)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate" => "collaborator@example.com", "affiliate_credit_amount_cents" => 60)
      end

      it "counts the whole credit when the direct affiliate of a collaborator sale is gone", parity: true do
        collaborator = create(:collaborator, seller:, affiliate_user: create(:user, email: "collaborator@example.com"), products: [product])
        sale.update_columns(affiliate_id: collaborator.id, affiliate_credit_cents: 100, json_data: { "direct_affiliate_id" => 0, "direct_affiliate_credit_cents" => 40 })
        credit(sale, 100, affiliate: collaborator, affiliate_user: collaborator.affiliate_user)

        verify(product_id: product.external_id, license_key: key)

        expect(response.parsed_body["purchase"]).to include("affiliate_credit_amount_cents" => 100)
      end
    end

    it "serializes a license of a membership purchase with custom fields", parity: true do
      membership = create(:membership_product, user: seller, name: "Membership", unique_permalink: "member", is_licensed: true)
      subscription = create(:subscription, link: membership, user: nil)
      member_sale = purchase_row(link: membership, seller:, email: "member@example.com", purchase_state: "successful", subscription:, is_original_subscription_purchase: true)
      member_license = create(:license, link: membership, purchase: member_sale, serial: "11111111-22222222-33333333-44444444")
      PurchaseCustomField.create!(purchase: member_sale, field_type: "text", name: "Company", value: "Example Inc")

      verify(product_id: membership.external_id, license_key: member_license.serial)

      expect(response.parsed_body["purchase"]).to include("Company" => "Example Inc", "custom_fields" => ["Company: Example Inc"])
    end
  end

  describe "PUT /licenses/enable" do
    it "enables a disabled license", parity: true do
      license.update_column(:disabled_at, 1.day.ago)

      write(:enable, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to include("success" => true, "uses" => 0)
      expect(license.reload.disabled?).to eq(false)
    end

    it "enables a license that is already enabled", parity: true do
      write(:enable, product_permalink: product.unique_permalink, license_key: key)

      expect(response.parsed_body["success"]).to eq(true)
    end

    it "enables a license through the /api prefix on the Gumroad domain", parity: true do
      license.update_column(:disabled_at, 1.day.ago)

      api_call(:put, "/licenses/enable", token: api_token(seller), params: { product_id: product.external_id, license_key: key }, api_host: false)

      expect(license.reload.disabled?).to eq(false)
    end

    it "enables a license for a token with the account scope", parity: true do
      license.update_column(:disabled_at, 1.day.ago)

      write(:enable, { product_id: product.external_id, license_key: key }, token: api_token(seller, scopes: "account"))

      expect(license.reload.disabled?).to eq(false)
    end

    it "refuses a token that lacks the edit_products scope", parity: true do
      write(:enable, { product_id: product.external_id, license_key: key }, token: api_token(seller, scopes: "view_sales"))

      expect(response).to have_http_status(:forbidden)
    end

    it "refuses a request without a token", parity: true do
      write(:enable, { product_id: product.external_id, license_key: key }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "answers 404 for another seller's license", parity: true do
      write(:enable, { product_id: product.external_id, license_key: key }, token: api_token(create(:user)))

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body).to eq("success" => false, "error" => "Not found")
    end

    it "does not find an unknown license", parity: true do
      write(:enable, product_id: product.external_id, license_key: "does-not-exist")

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("That license does not exist for the provided product.")
    end

    it "refuses a purchase whose access was revoked", parity: true do
      sale.update_column(:flags, sale.flags | Purchase.flag_mapping["flags"][:is_access_revoked])

      write(:enable, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:not_found)
      expect(response.parsed_body["message"]).to eq("Access to the purchase associated with this license has expired.")
    end

    it "hands a license key that is a list to Rails", parity: true do
      write(:enable, "product_id" => product.external_id, "license_key" => [key])

      expect(response).to have_http_status(:ok)
    end

    it "enables a license of a purchase with a variant", parity: true do
      category = create(:variant_category, link: product)
      sale.variant_attributes << create(:variant, variant_category: category, name: "Gold")
      license.update_column(:disabled_at, 1.day.ago)

      write(:enable, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(license.reload.disabled?).to eq(false)
    end

    it "enables a license of a purchase with a SKU", parity: true do
      product.update_column(:flags, product.flags | Link.flag_mapping["flags"][:skus_enabled])
      sku = Sku.create!(link: product, name: "Large", price_difference_cents: 0)
      sale.variant_attributes << sku
      license.update_column(:disabled_at, 1.day.ago)

      write(:enable, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(license.reload.disabled?).to eq(false)
    end
  end

  describe "PUT /licenses/disable" do
    it "disables a license", parity: true do
      write(:disable, product_id: product.external_id, license_key: key)

      expect(response.parsed_body).to include("success" => true, "uses" => 0)
      expect(license.reload.disabled?).to eq(true)
    end

    it "disables a license by permalink", parity: true do
      write(:disable, product_permalink: product.custom_permalink, license_key: key)

      expect(license.reload.disabled?).to eq(true)
    end

    it "disables the license of an imported customer", parity: true do
      imported = imported_license(uses: 1)

      write(:disable, product_id: product.external_id, license_key: imported.serial)

      expect(response.parsed_body).to include("success" => true, "uses" => 1)
      expect(response.parsed_body["imported_customer"]).to include("email" => "imported@example.com")
      expect(imported.reload.disabled?).to eq(true)
    end

    it "answers 404 for another seller's license", parity: true do
      write(:disable, { product_id: product.external_id, license_key: key }, token: api_token(create(:user)))

      expect(response).to have_http_status(:not_found)
      expect(license.reload.disabled?).to eq(false)
    end

    it "refuses a request without a token", parity: true do
      write(:disable, { product_id: product.external_id, license_key: key }, token: nil)

      expect(response).to have_http_status(:unauthorized)
      expect(license.reload.disabled?).to eq(false)
    end
  end

  describe "PUT /licenses/decrement_uses_count" do
    it "decrements the uses", parity: true do
      license.update_column(:uses, 3)

      write(:decrement_uses_count, product_id: product.external_id, license_key: key)

      expect(response.parsed_body).to include("success" => true, "uses" => 2)
      expect(license.reload.uses).to eq(2)
    end

    it "keeps the uses at zero", parity: true do
      write(:decrement_uses_count, product_id: product.external_id, license_key: key)

      expect(response.parsed_body["uses"]).to eq(0)
      expect(license.reload.uses).to eq(0)
    end

    it "decrements by permalink", parity: true do
      license.update_column(:uses, 1)

      write(:decrement_uses_count, product_permalink: product.unique_permalink, license_key: key)

      expect(response.parsed_body["uses"]).to eq(0)
    end

    it "answers 404 for another seller's license", parity: true do
      license.update_column(:uses, 2)

      write(:decrement_uses_count, { product_id: product.external_id, license_key: key }, token: api_token(create(:user)))

      expect(response).to have_http_status(:not_found)
      expect(license.reload.uses).to eq(2)
    end

    it "refuses a request without a token", parity: true do
      write(:decrement_uses_count, { product_id: product.external_id, license_key: key }, token: nil)

      expect(response).to have_http_status(:unauthorized)
    end

    it "decrements the uses of a membership license", parity: true do
      membership = create(:membership_product, user: seller, subscription_duration: :monthly)
      subscription = create(:subscription, link: membership, user: nil)
      original = purchase_row(link: membership, seller:, subscription:, is_original_subscription_purchase: true, purchase_state: "successful")
      member_license = create(:license, link: membership, purchase: original, serial: "11111111-22222222-33333333-44444444", uses: 2)

      write(:decrement_uses_count, product_id: membership.external_id, license_key: member_license.serial)

      expect(response.parsed_body["uses"]).to eq(1)
    end
  end

  describe "PUT /licenses/rotate" do
    it "gives the license a new key", parity: true do
      write(:rotate, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(license.reload.serial).not_to eq(key)
      expect(response.parsed_body["purchase"]["license_key"]).to eq(license.serial)
    end

    it "gives the license of an imported customer a new key", parity: true do
      imported = imported_license(uses: 1)

      write(:rotate, product_id: product.external_id, license_key: imported.serial)

      expect(imported.reload.serial).not_to eq("55555555-66666666-77777777-88888888")
      expect(response.parsed_body["imported_customer"]).to include("email" => "imported@example.com")
    end

    it "answers 404 for another seller's license", parity: true do
      write(:rotate, { product_id: product.external_id, license_key: key }, token: api_token(create(:user)))

      expect(response).to have_http_status(:not_found)
      expect(license.reload.serial).to eq(key)
    end

    it "refuses a request without a token", parity: true do
      write(:rotate, { product_id: product.external_id, license_key: key }, token: nil)

      expect(response).to have_http_status(:unauthorized)
      expect(license.reload.serial).to eq(key)
    end

    it "gives the license of a purchase with an offer code a new key", parity: true do
      offer_code = create(:offer_code, user: seller, products: [product], code: "SAVE10", amount_cents: 100)
      sale.update_column(:offer_code_id, offer_code.id)

      write(:rotate, product_id: product.external_id, license_key: key)

      expect(response).to have_http_status(:ok)
      expect(license.reload.serial).not_to eq(key)
    end
  end
end
