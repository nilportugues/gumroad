# frozen_string_literal: true

require "spec_helper"

# The create_draft_product and update_product tools of Mcp::Server through the full Rack stack, recorded for the Next.js port and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node saves a plain digital draft (a USD price above zero and a description with no markup)
# and updates the name, description, price and permalink of a product with one buy price; every other call goes to Rails whole, in an example named
# "hands ... back". `parity_timeline` records the order of the statements and jobs.
describe "API v2 MCP product writes", type: :request, parity_timeline: true do
  let(:seller) { create(:user, username: "dude", name: "Dude") }
  let(:application) { create(:oauth_application, owner: create(:user)) }
  let(:rpc) { { "Content-Type" => "application/json" } }
  let(:created) { Link.order(:id).last }

  before { host! DOMAIN }

  def auth(scopes) = { "Authorization" => "Bearer #{create("doorkeeper/access_token", application:, resource_owner_id: seller.id, scopes:).token}" }

  def call_tool(name, arguments = {}, scopes: "edit_products")
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name:, arguments: } }
    post "/muse/v1/mcp", params: body.to_json, headers: rpc.merge(auth(scopes))
  end

  def create_draft(arguments, **options) = call_tool("create_draft_product", arguments, **options)

  describe "create_draft_product" do
    it "saves a draft with a name, a description and a price", parity: true do
      create_draft({ name: "Notebook", description: "Dotted pages", price_cents: 500 })

      expect(created.draft).to be true
      expect(created.purchase_disabled_at).to be_present
      expect(created.price_cents).to eq(500)
    end

    it "saves a draft with no description", parity: true do
      create_draft({ name: "Notebook", price_cents: 1200 })

      expect(created.description).to eq("")
    end

    it "strips the name", parity: true do
      create_draft({ name: "  Notebook \n", price_cents: 500 })

      expect(created.name).to eq("Notebook")
    end

    it "accepts the account scope", parity: true do
      create_draft({ name: "Notebook", price_cents: 500 }, scopes: "account")
    end

    it "reports a name over 255 characters as a tool error", parity: true do
      create_draft({ name: "a" * 256, price_cents: 500 })

      expect(Link.count).to eq(0)
    end

    it "reports a price over the maximum as a tool error", parity: true do
      create_draft({ name: "Notebook", price_cents: 2_147_483_648 })
    end

    it "refuses a blank name", parity: true do
      create_draft({ name: "   ", price_cents: 500 })

      expect(Link.count).to eq(0)
    end

    it "refuses a negative price", parity: true do
      create_draft({ name: "Notebook", price_cents: -1 })
    end

    it "requires the price of a product", parity: true do
      create_draft({ name: "Notebook" })
    end

    it "refuses tiers on a digital product", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, tiers: [] })
    end

    it "refuses a price on a membership", parity: true do
      create_draft({ name: "Club", product_type: "membership", price_cents: 500 })
    end

    it "refuses a membership with a malformed tier", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold" }] })
    end

    it "refuses a membership with no tiers", parity: true do
      create_draft({ name: "Club", product_type: "membership" })
    end

    it "refuses a tier with an unknown key", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly", color: "gold" }] })
    end

    it "refuses a tier that is not an object", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: ["Gold"] })
    end

    it "refuses a tier with a blank name", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: " ", price_cents: 500, recurrence: "monthly" }] })
    end

    it "refuses a tier with a negative price", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: -5, recurrence: "monthly" }] })
    end

    it "refuses a tier priced over the maximum", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 2_147_483_648, recurrence: "monthly" }] })
    end

    it "refuses a tier with an unknown recurrence", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "weekly" }] })
    end

    it "refuses tiers that bill at different intervals", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly" }, { name: "Silver", price_cents: 100, recurrence: "yearly" }] })
    end

    it "hands a free product back to Rails", parity: true do
      create_draft({ name: "Freebie", price_cents: 0 })
    end

    it "hands a description with markup back to Rails", parity: true do
      create_draft({ name: "Notebook", description: "<p>Dotted pages</p>", price_cents: 500 })
    end

    it "hands a membership back to Rails", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly" }] })
    end

    it "hands a seller who prices in another currency back to Rails", parity: true do
      seller.update_columns(currency_type: "eur")
      create_draft({ name: "Notebook", price_cents: 500 })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      create_draft({ name: "Notebook", price_cents: 500 }, scopes: "view_sales")
    end
  end

  describe "update_product" do
    let!(:product) { create(:product, user: seller, name: "Pencil", unique_permalink: "pencilpk", description: "Writes", price_cents: 300, created_at: 2.days.ago, purchase_disabled_at: 1.day.ago) }

    before { product.prices.update_all(created_at: 2.days.ago, updated_at: 2.days.ago) }

    def update(arguments, **options) = call_tool("update_product", { id: "pencilpk" }.merge(arguments), **options)

    it "renames a product", parity: true do
      update({ name: "Pen" })

      expect(product.reload.name).to eq("Pen")
    end

    it "strips the new name", parity: true do
      update({ name: "  Pen \n" })

      expect(product.reload.name).to eq("Pen")
    end

    it "changes the description", parity: true do
      update({ description: "Writes well" })

      expect(product.reload.description).to eq("Writes well")
    end

    it "saves a description with markup as the product editor would", parity: true do
      update({ description: "<p>Writes <b>well</b></p>" })
    end

    it "changes the price", parity: true do
      update({ price_cents: 450 })

      expect(product.reload.price_cents).to eq(450)
    end

    it "keeps a price that does not change", parity: true do
      update({ price_cents: 300 })
    end

    it "changes the name, the description and the price together", parity: true do
      update({ name: "Pen", description: "Writes well", price_cents: 450 })
    end

    it "sets a price of zero", parity: true do
      update({ price_cents: 0 })

      expect(product.reload.price_cents).to eq(0)
    end

    it "finds the product by external id with the account scope", parity: true do
      call_tool("update_product", { id: product.external_id, name: "Pen" }, scopes: "account")
    end

    it "renames a draft", parity: true do
      product.update_columns(draft: true, purchase_disabled_at: Time.current)
      update({ name: "Pen" })
    end

    it "reports a price over the maximum as a tool error", parity: true do
      update({ price_cents: 2_147_483_648 })

      expect(product.reload.price_cents).to eq(300)
    end

    it "reports a name over 255 characters as a tool error", parity: true do
      update({ name: "a" * 256 })

      expect(product.reload.name).to eq("Pencil")
    end

    it "refuses a blank name", parity: true do
      update({ name: "  " })
    end

    it "refuses a negative price", parity: true do
      update({ price_cents: -1 })
    end

    it "refuses a call that changes nothing", parity: true do
      update({})
    end

    it "requires the id", parity: true do
      call_tool("update_product", { name: "Pen" })
    end

    it "does not find the product of another seller", parity: true do
      other = create(:product, user: create(:user), unique_permalink: "otherpk")
      call_tool("update_product", { id: other.external_id, name: "Pen" })

      expect(other.reload.name).not_to eq("Pen")
    end

    describe "permalink" do
      def redirects = ProductPermalinkRedirect.order(:id).pluck(:permalink, :product_id, :seller_id)

      it "sets a custom permalink", parity: true do
        update({ permalink: "pen" })

        expect(product.reload.custom_permalink).to eq("pen")
        expect(redirects).to eq([])
      end

      it "sets a custom permalink with letters, digits, dashes and underscores", parity: true do
        update({ permalink: "My_Pen-2" })

        expect(product.reload.custom_permalink).to eq("My_Pen-2")
      end

      it "redirects the outgoing permalink when it is replaced", parity: true do
        product.update_columns(custom_permalink: "oldpen")
        update({ permalink: "pen" })

        expect(redirects).to eq([["oldpen", product.id, seller.id]])
        expect(LegacyPermalink.pluck(:permalink, :product_id)).to eq([["oldpen", product.id]])
      end

      it "redirects the outgoing permalink when it is cleared with an empty string", parity: true do
        product.update_columns(custom_permalink: "oldpen")
        update({ permalink: "" })

        expect(product.reload.custom_permalink).to be_nil
        expect(redirects).to eq([["oldpen", product.id, seller.id]])
      end

      it "clears nothing when there is no custom permalink", parity: true do
        update({ permalink: "" })

        expect(product.reload.custom_permalink).to be_nil
      end

      it "keeps a permalink that does not change", parity: true do
        product.update_columns(custom_permalink: "pen")
        update({ permalink: "pen" })

        expect(redirects).to eq([])
      end

      it "redirects the old spelling when only the case changes", parity: true do
        product.update_columns(custom_permalink: "pen")
        update({ permalink: "PEN" })

        expect(product.reload.custom_permalink).to eq("PEN")
        expect(redirects).to eq([["pen", product.id, seller.id]])
        expect(LegacyPermalink.count).to eq(0)
      end

      it "repoints a redirect the seller already had for the outgoing permalink", parity: true do
        other = create(:product, user: seller, unique_permalink: "otherpk")
        product.update_columns(custom_permalink: "oldpen")
        ProductPermalinkRedirect.create!(permalink: "oldpen", product_id: other.id, seller_id: seller.id)
        update({ permalink: "pen" })

        expect(redirects).to eq([["oldpen", product.id, seller.id]])
      end

      it "keeps a redirect that already points at the product", parity: true do
        product.update_columns(custom_permalink: "oldpen")
        ProductPermalinkRedirect.create!(permalink: "oldpen", product_id: product.id, seller_id: seller.id)
        update({ permalink: "pen" })

        expect(redirects.size).to eq(1)
      end

      it "records no legacy permalink when one already exists for the outgoing permalink", parity: true do
        other = create(:product, user: create(:user), unique_permalink: "otherpk")
        product.update_columns(custom_permalink: "oldpen")
        LegacyPermalink.create!(permalink: "oldpen", product_id: other.id)
        update({ permalink: "pen" })

        expect(LegacyPermalink.pluck(:permalink, :product_id)).to eq([["oldpen", other.id]])
      end

      it "records no legacy permalink when another seller's live product answers on the outgoing permalink", parity: true do
        create(:product, user: create(:user), unique_permalink: "otherpk", custom_permalink: "oldpen")
        product.update_columns(custom_permalink: "oldpen")
        update({ permalink: "pen" })

        expect(redirects).to eq([["oldpen", product.id, seller.id]])
        expect(LegacyPermalink.count).to eq(0)
      end

      it "records no redirect when a legacy permalink of the seller's own products maps the outgoing permalink", parity: true do
        other = create(:product, user: seller, unique_permalink: "otherpk")
        product.update_columns(custom_permalink: "oldpen")
        LegacyPermalink.create!(permalink: "oldpen", product_id: other.id)
        update({ permalink: "pen" })

        expect(redirects).to eq([])
      end

      it "queues an IndexNow submission for a published product", parity: true do
        product.update_columns(purchase_disabled_at: nil)
        update({ permalink: "pen" })

        expect(SubmitToIndexnowJob.jobs.size).to eq(1)
      end

      it "sets the permalink, the name and the price together", parity: true do
        update({ permalink: "pen", name: "Pen", price_cents: 450 })
      end

      it "accepts the permalink of another seller's product", parity: true do
        create(:product, user: create(:user), unique_permalink: "otherpk", custom_permalink: "pen")
        update({ permalink: "pen" })

        expect(product.reload.custom_permalink).to eq("pen")
      end

      it "accepts the unique permalink of another seller's product", parity: true do
        create(:product, user: create(:user), unique_permalink: "pen")
        update({ permalink: "pen" })

        expect(product.reload.custom_permalink).to eq("pen")
      end

      it "accepts the permalink of a licensed product when no cutover is set", parity: true do
        product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:is_licensed])
        update({ permalink: "pen" })

        expect(product.reload.custom_permalink).to eq("pen")
      end

      it "refuses a permalink with a space", parity: true do
        update({ permalink: "my pen" })

        expect(product.reload.custom_permalink).to be_nil
      end

      it "refuses a permalink with a trailing newline", parity: true do
        update({ permalink: "pen\n" })

        expect(product.reload.custom_permalink).to be_nil
      end

      it "refuses a permalink with a character outside the allowed ones", parity: true do
        update({ permalink: "pén" })
      end

      it "refuses a permalink over 255 characters", parity: true do
        update({ permalink: "a" * 256 })
      end

      it "accepts a permalink of 255 characters", parity: true do
        update({ permalink: "a" * 255 })
      end

      it "refuses a permalink another product of the seller already uses", parity: true do
        create(:product, user: seller, unique_permalink: "otherpk", custom_permalink: "pen")
        update({ permalink: "pen" })

        expect(product.reload.custom_permalink).to be_nil
      end

      it "refuses the same permalink in another case", parity: true do
        create(:product, user: seller, unique_permalink: "otherpk", custom_permalink: "pen")
        update({ permalink: "PEN" })
      end

      it "refuses the unique permalink of another product of the seller", parity: true do
        create(:product, user: seller, unique_permalink: "pen")
        update({ permalink: "pen" })
      end

      it "refuses a permalink with the other errors of the same call", parity: true do
        create(:product, user: seller, unique_permalink: "otherpk", custom_permalink: "pen")
        update({ permalink: "pen", name: "x" * 256 })
      end

      it "refuses a blank permalink", parity: true do
        update({ permalink: "   " })
      end

      it "hands a permalink another product of the seller deleted back to Rails", parity: true do
        create(:product, user: seller, unique_permalink: "otherpk", custom_permalink: "pen", deleted_at: 1.day.ago)
        update({ permalink: "pen" })
      end

      it "clears the permalink while a deleted product has none", parity: true do
        create(:product, user: seller, unique_permalink: "otherpk", deleted_at: 1.day.ago)
        product.update_columns(custom_permalink: "oldpen")
        update({ permalink: "" })
      end

      it "refuses a permalink that is not text", parity: true do
        update({ permalink: 5 })
      end

      it "hands a licensed product back to Rails when a cutover is set", parity: true do
        $redis.set(RedisKey.force_product_id_timestamp, 1.day.ago.iso8601)
        product.update_columns(flags: product.flags | Link.flag_mapping["flags"][:is_licensed])
        update({ permalink: "pen" })
      ensure
        $redis.del(RedisKey.force_product_id_timestamp)
      end
    end

    it "hands a rename of a published product back to Rails", parity: true do
      product.update_columns(purchase_disabled_at: nil)
      update({ name: "Pen" })
    end

    it "hands a description that replaces upsell cards back to Rails", parity: true do
      product.update_columns(description: '<upsell-card id="x"></upsell-card>')
      update({ description: "Writes" })
    end

    it "hands a product beside a discount code back to Rails", parity: true do
      create(:offer_code, user: seller, products: [product], code: "tenoff", amount_cents: 10)
      update({ price_cents: 50 })
    end

    it "hands a tiered membership back to Rails", parity: true do
      membership = create(:membership_product, user: seller, unique_permalink: "clubpk")
      call_tool("update_product", { id: membership.external_id, price_cents: 50 })
    end

    it "hands a call without the edit scope back to Rails", parity: true do
      update({ name: "Pen" }, scopes: "view_sales")
    end
  end

  # Tools whose write or call order the recordings do not prove: the cover and file tools fetch a URL and run Active Storage analysis, and
  # the bundle tools save a product, its taxonomy and its members across several tables. Each goes to Rails whole.
  describe "tools that stay in Rails" do
    let!(:pencil) { create(:product, user: seller, name: "Pencil", unique_permalink: "pencilpk") }

    it "hands a cover from a URL back to Rails", parity: true do
      stub_request(:get, "https://images.example.com/cover.png").to_return(status: 404)
      call_tool("add_cover", { id: "pencilpk", url: "https://images.example.com/cover.png" })
    end

    it "hands a file from a URL back to Rails", parity: true do
      stub_request(:get, "https://files.example.com/guide.pdf").to_return(status: 404)
      call_tool("add_file", { id: "pencilpk", url: "https://files.example.com/guide.pdf" })
    end

    it "hands a new bundle back to Rails", parity: true do
      call_tool("create_bundle", { name: "Desk set", price_cents: 900, product_ids: ["pencilpk"] })
    end

    it "hands a change to the products of a bundle back to Rails", parity: true do
      bundle = create(:product, :bundle, user: seller, name: "Desk set", unique_permalink: "deskset")
      call_tool("update_bundle", { id: bundle.external_id, product_ids: ["pencilpk"] })
    end
  end
end
