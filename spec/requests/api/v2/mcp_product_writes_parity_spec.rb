# frozen_string_literal: true

require "spec_helper"

# The create_draft_product and update_product tools of Mcp::Server through the full Rack stack, recorded for the Next.js port and replayed by
# nextjs/parity/__tests__/api-v2-ws17c.replay.test.ts. Node saves a plain digital draft (a USD price, pay what you want and a description with no markup)
# and updates the name, description, price, permalink, summary, additional details and receipt texts of a product with one buy price; every other call goes to Rails whole, in an example named
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

    it "saves a free draft with a zero price", parity: true do
      create_draft({ name: "Freebie", price_cents: 0 })

      expect(created.price_cents).to eq(0)
      expect(created.customizable_price).to be true
    end

    it "saves a draft with a paragraph description", parity: true do
      create_draft({ name: "Notebook", description: "<p>Dotted pages</p>", price_cents: 500 })

      expect(created.description).to eq("<p>Dotted pages</p>")
    end

    it "hands a membership back to Rails", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly" }] })
    end

    it "hands a seller who prices in another currency back to Rails", parity: true do
      seller.update_columns(currency_type: "eur")
      create_draft({ name: "Notebook", price_cents: 500 })
    end

    it "hands a currency back to Rails", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, currency: "eur" })
    end

    it "hands a currency Rails does not list back to Rails", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, currency: "xyz" })
    end

    it "saves a pay what you want draft with a suggested price", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true, suggested_price_cents: 900 })

      expect(created.customizable_price).to be true
      expect(created.suggested_price_cents).to eq(900)
    end

    it "saves a pay what you want draft with no suggested price", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true })

      expect(created.customizable_price).to be true
      expect(created.suggested_price_cents).to be_nil
    end

    it "saves a draft with pay what you want turned off", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: false })

      expect(created.customizable_price).to be false
    end

    it "saves a free pay what you want draft with a suggested price", parity: true do
      create_draft({ name: "Freebie", price_cents: 0, pay_what_you_want: true, suggested_price_cents: 300 })
    end

    it "refuses a suggested price while pay what you want is off", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: false, suggested_price_cents: 900 })

      expect(Link.count).to eq(0)
    end

    it "refuses a suggested price with no pay what you want", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, suggested_price_cents: 900 })
    end

    it "reports a suggested price below the price as a tool error", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true, suggested_price_cents: 100 })

      expect(Link.count).to eq(0)
    end

    it "reports a negative suggested price as a tool error", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true, suggested_price_cents: -1 })
    end

    it "reports a suggested price over the maximum as a tool error", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true, suggested_price_cents: 2_147_483_648 })
    end

    it "answers the argument error of a suggested price ahead of the scope check", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, suggested_price_cents: 900 }, scopes: "view_sales")
    end

    it "asks a pay what you want draft without the edit scope to step up", parity: true do
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true }, scopes: "view_sales")
    end

    it "hands a pay what you want draft of a seller who prices in another currency back to Rails", parity: true do
      seller.update_columns(currency_type: "eur")
      create_draft({ name: "Notebook", price_cents: 500, pay_what_you_want: true })
    end

    it "hands a membership tier with a suggested price back to Rails", parity: true do
      create_draft({ name: "Club", product_type: "membership", tiers: [{ name: "Gold", price_cents: 500, recurrence: "monthly", pay_what_you_want: true, suggested_price_cents: 900 }] })
    end

    it "asks a call without the edit scope to step up", parity: true do
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

    it "keeps a name made of a zero width space, which is not blank", parity: true do
      update({ name: "\u200b" })
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

    describe "summary, additional details and receipt texts" do
      def json_data = product.reload.json_data

      it "sets a summary", parity: true do
        update({ summary: "Sketch every day" })

        expect(json_data).to eq("custom_summary" => "Sketch every day")
      end

      it "keeps a summary as written, markup and accents included", parity: true do
        update({ summary: "  Sketch <b>every</b> & \"day\" / é 🎨 \\ \u2028 " })
      end

      it "keeps a summary that is only a zero width space", parity: true do
        update({ summary: "\u200b" })
      end

      it "stores a summary with a NUL character", parity: true do
        update({ summary: "a\u0000b" })
      end

      it "clears a summary with an empty string", parity: true do
        product.update!(json_data: { "custom_summary" => "Sketch every day", "custom_receipt_text" => "Thanks" })
        update({ summary: "" })

        expect(json_data).to eq("custom_summary" => nil, "custom_receipt_text" => "Thanks")
      end

      it "records a cleared summary for a product that never had one", parity: true do
        update({ summary: "" })
      end

      it "reads a summary of spaces and a no-break space as none", parity: true do
        update({ summary: " \u00a0 \t" })
      end

      it "keeps a summary that does not change", parity: true do
        product.update!(json_data: { "custom_summary" => "Sketch every day" })
        update({ summary: "Sketch every day" })
      end

      it "keeps the other json_data keys and appends a new one last", parity: true do
        product.update!(json_data: { "custom_summary" => "Old", "custom_attributes" => [{ "name" => "Pages", "value" => "40" }], "sections" => [1, 2] })
        update({ summary: "New", custom_receipt_text: "Thanks" })

        expect(json_data.keys).to eq(%w[custom_summary custom_attributes sections custom_receipt_text])
      end

      it "writes the four fields in Rails' order whatever order they are sent in", parity: true do
        update({ custom_view_content_button_text: "Open", custom_receipt_text: "Thanks", additional_details: [{ name: "Pages", value: "40" }], summary: "Sketch" })

        expect(json_data.keys).to eq(%w[custom_summary custom_attributes custom_receipt_text custom_view_content_button_text])
      end

      it "changes the name, the price and the summary together", parity: true do
        update({ name: "Pen", price_cents: 450, summary: "Sketch" })
      end

      it "changes the summary of a published product", parity: true do
        product.update_columns(purchase_disabled_at: nil)
        update({ summary: "Sketch every day" })
      end

      it "changes the summary of a draft", parity: true do
        product.update_columns(draft: true, purchase_disabled_at: Time.current)
        update({ summary: "Sketch every day" })
      end

      it "replaces the additional details", parity: true do
        product.update!(json_data: { "custom_attributes" => [{ "name" => "Old", "value" => "1" }] })
        update({ additional_details: [{ name: "Pages", value: "40" }, { name: "Format", value: "PDF" }] })

        expect(json_data["custom_attributes"]).to eq([{ "name" => "Pages", "value" => "40" }, { "name" => "Format", "value" => "PDF" }])
      end

      it "removes every additional detail with an empty list", parity: true do
        product.update!(json_data: { "custom_attributes" => [{ "name" => "Old", "value" => "1" }] })
        update({ additional_details: [] })

        expect(json_data["custom_attributes"]).to eq([])
      end

      it "keeps a detail with a name and no value, and one whose value is only spaces", parity: true do
        update({ additional_details: [{ name: "Pages" }, { name: "Format", value: "   " }, { name: " ", value: "" }] })
      end

      it "drops a row with neither a name nor a value and ignores other keys", parity: true do
        update({ additional_details: [{}, { name: nil, value: nil }, { name: "", value: "  " }, { name: "Pages", value: "40", extra: 1 }] })
      end

      it "refuses a value with no name", parity: true do
        update({ additional_details: [{ name: "Pages", value: "40" }, { name: " ", value: "40" }] })

        expect(json_data).to eq({})
      end

      it "refuses a detail that is not an object", parity: true do
        update({ additional_details: ["Pages: 40"] })
      end

      it "refuses a detail name that is not text", parity: true do
        update({ additional_details: [{ name: 5, value: "40" }] })
      end

      it "refuses a detail value that is not text", parity: true do
        update({ additional_details: [{ name: "Pages", value: ["40"] }] })
      end

      it "reports the first bad detail", parity: true do
        update({ additional_details: [{ name: "A", value: 1 }, { name: "", value: "x" }, "B"] })
      end

      it "reports a blank name before a bad detail", parity: true do
        update({ name: "  ", additional_details: ["x"] })
      end

      it "reports a price over the maximum before a bad detail", parity: true do
        update({ price_cents: 2_147_483_648, additional_details: ["x"] })
      end

      it "reports a bad detail before a receipt text over the limit", parity: true do
        update({ custom_receipt_text: "a" * 501, additional_details: ["x"] })
      end

      it "sets the receipt message and the button text", parity: true do
        update({ custom_receipt_text: "Thanks for buying", custom_view_content_button_text: "Open the pack" })

        expect(json_data).to eq("custom_receipt_text" => "Thanks for buying", "custom_view_content_button_text" => "Open the pack")
      end

      it "clears the receipt message and the button text with empty strings", parity: true do
        product.update!(json_data: { "custom_receipt_text" => "Thanks", "custom_view_content_button_text" => "Open" })
        update({ custom_receipt_text: "", custom_view_content_button_text: " " })

        expect(json_data).to eq("custom_receipt_text" => nil, "custom_view_content_button_text" => nil)
      end

      it "accepts a receipt message of 500 characters and a button of 26", parity: true do
        update({ custom_receipt_text: "a" * 500, custom_view_content_button_text: "b" * 26 })
      end

      it "counts characters, not bytes, against the limits", parity: true do
        update({ custom_receipt_text: "é🎨" * 250, custom_view_content_button_text: "🎨" * 26 })
      end

      it "reports a receipt message over 500 characters as a tool error", parity: true do
        update({ custom_receipt_text: "a" * 501 })

        expect(json_data).to eq({})
      end

      it "reports a button text over 26 characters as a tool error", parity: true do
        update({ custom_view_content_button_text: "b" * 28 })

        expect(json_data).to eq({})
      end

      it "reports both texts over their limits", parity: true do
        update({ name: "Pen", custom_receipt_text: "a" * 501, custom_view_content_button_text: "b" * 27 })

        expect(product.reload.name).to eq("Pencil")
      end

      it "reads a receipt message of spaces the product already has as none", parity: true do
        product.update!(json_data: { "custom_receipt_text" => "   ", "custom_view_content_button_text" => "\u00a0" })
        update({ name: "Pen" })
      end

      it "hands a summary with a lone surrogate back to Rails", parity: true do
        body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_product","arguments":{"id":"pencilpk","summary":"a\\ud800b"}}}'
        post "/muse/v1/mcp", params: body, headers: rpc.merge(auth("edit_products"))
      end

      it "hands an additional detail with a lone surrogate back to Rails", parity: true do
        body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_product","arguments":{"id":"pencilpk","additional_details":[{"name":"Pages","value":"a\\ud800b"}]}}}'
        post "/muse/v1/mcp", params: body, headers: rpc.merge(auth("edit_products"))
      end

      it "hands a summary beside a discount code back to Rails", parity: true do
        create(:offer_code, user: seller, products: [product], code: "tenoff", amount_cents: 10)
        update({ summary: "Sketch" })
      end
    end

    it "reports the category, summary, additional details, tag and receipt texts the product already has", parity: true do
      design = create(:taxonomy, slug: "design")
      product.update!(taxonomy: create(:taxonomy, slug: "3d-assets", parent_id: design.id))
      product.json_data = { "custom_summary" => "Sketch every day", "custom_receipt_text" => "Thanks for buying", "custom_view_content_button_text" => "Open the pack",
                            "custom_attributes" => [{ "name" => "Pages", "value" => "40" }] }
      product.save!
      product.save_tags!(["field-notes"])
      update({ price_cents: 450 })
    end

    it "hands a category back to Rails", parity: true do
      update({ category: "other" })
    end

    describe "tags" do
      def tag_names = product.reload.tags.pluck(:name)

      it "saves one tag", parity: true do
        update({ tags: ["field-notes"] })

        expect(tag_names).to eq(["field-notes"])
      end

      it "hands a tag with spaces back to Rails", parity: true do
        update({ tags: ["  Field   Notes "] })

        expect(tag_names).to eq(["field notes"])
      end

      it "strips a tag", parity: true do
        update({ tags: ["\n Field-Notes\t"] })

        expect(tag_names).to eq(["field-notes"])
      end

      it "saves a tag beside a name", parity: true do
        update({ name: "Pen", tags: ["field-notes"] })

        expect(product.reload.name).to eq("Pen")
        expect(tag_names).to eq(["field-notes"])
      end

      it "keeps a tag the product already has", parity: true do
        product.save_tags!(["field-notes"])
        update({ tags: ["Field-Notes"] })

        expect(tag_names).to eq(["field-notes"])
      end

      it "swaps the tag the product has for another", parity: true do
        product.save_tags!(["field-notes"])
        update({ tags: ["sketching"] })

        expect(tag_names).to eq(["sketching"])
      end

      it "reuses a tag another product holds", parity: true do
        create(:product, user: seller, unique_permalink: "markerpk").save_tags!(["sketching"])
        update({ tags: ["sketching"] })

        expect(tag_names).to eq(["sketching"])
        expect(Tag.find_by(name: "sketching").taggings_count).to eq(2)
      end

      it "removes every tag with an empty list", parity: true do
        product.save_tags!(["field-notes"])
        update({ tags: [] })

        expect(tag_names).to eq([])
      end

      it "removes the several tags a product has with an empty list", parity: true do
        product.save_tags!(["field-notes", "sketching", "stationery"])
        update({ tags: [] })

        expect(tag_names).to eq([])
      end

      it "keeps one of the several tags a product has", parity: true do
        product.save_tags!(["field-notes", "sketching"])
        update({ tags: ["sketching"] })

        expect(tag_names).to eq(["sketching"])
      end

      it "collapses a tag written twice", parity: true do
        update({ tags: ["field-notes", "Field-Notes"] })

        expect(tag_names).to eq(["field-notes"])
      end

      it "refuses a tag of one character", parity: true do
        update({ tags: ["a"] })

        expect(tag_names).to eq([])
      end

      it "refuses a tag of 21 characters", parity: true do
        update({ tags: ["a" * 21] })
      end

      it "accepts a tag of 20 characters", parity: true do
        update({ tags: ["a" * 20] })

        expect(tag_names).to eq(["a" * 20])
      end

      it "refuses a tag that is not text", parity: true do
        update({ tags: [5] })
      end

      it "refuses more than ten tags", parity: true do
        update({ tags: (10..20).map { "tag-#{_1}" } })
      end

      it "rolls the other changes back when a tag is refused", parity: true do
        update({ name: "Pen", price_cents: 450, tags: ["a"] })

        expect(product.reload.name).to eq("Pencil")
        expect(product.price_cents).to eq(300)
      end

      it "reports the name error before a tag error", parity: true do
        update({ name: "  ", tags: ["a"] })
      end

      it "hands a pair of tags back to Rails", parity: true do
        update({ tags: ["field-notes", "sketching"] })

        expect(tag_names).to eq(["field-notes", "sketching"])
      end

      it "hands a tag with a comma back to Rails", parity: true do
        update({ tags: ["field,notes"] })
      end

      it "hands a tag with a hash back to Rails", parity: true do
        update({ tags: ["#notes"] })
      end

      it "hands a tag with a non-ASCII letter back to Rails", parity: true do
        update({ tags: ["café"] })
      end

      it "refuses a tag list that is not a list", parity: true do
        update({ tags: "field-notes" })
      end
    end

    it "hands a currency back to Rails", parity: true do
      update({ currency: "eur" })
    end

    describe "pay what you want" do
      it "turns pay what you want on", parity: true do
        update({ pay_what_you_want: true })

        expect(product.reload.customizable_price).to be true
        expect(product.suggested_price_cents).to be_nil
      end

      it "turns pay what you want on with a suggested price", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: 900 })

        expect(product.reload.customizable_price).to be true
        expect(product.suggested_price_cents).to eq(900)
      end

      it "turns pay what you want off", parity: true do
        product.update_columns(customizable_price: true, suggested_price_cents: 900)
        update({ pay_what_you_want: false })

        expect(product.reload.customizable_price).to be_falsey
      end

      it "keeps a pay what you want switch that does not change", parity: true do
        product.update_columns(customizable_price: true)
        update({ pay_what_you_want: true })
      end

      it "changes the suggested price of a product that has pay what you want on", parity: true do
        product.update_columns(customizable_price: true, suggested_price_cents: 900)
        update({ suggested_price_cents: 1200 })

        expect(product.reload.suggested_price_cents).to eq(1200)
      end

      it "turns pay what you want on and changes the price together", parity: true do
        update({ price_cents: 450, pay_what_you_want: true, suggested_price_cents: 600 })
      end

      it "turns pay what you want on for a draft", parity: true do
        product.update_columns(draft: true, purchase_disabled_at: Time.current)
        update({ pay_what_you_want: true, suggested_price_cents: 900 })
      end

      it "turns pay what you want on for a published product", parity: true do
        product.update_columns(purchase_disabled_at: nil)
        update({ pay_what_you_want: true })
      end

      it "turns pay what you want off while a suggested price is stored and a price above it is set", parity: true do
        product.update_columns(customizable_price: true, suggested_price_cents: 400)
        update({ pay_what_you_want: false, price_cents: 800 })

        expect(product.reload.customizable_price).to be_falsey
      end

      it "turns pay what you want back on over a stored suggested price", parity: true do
        product.update_columns(suggested_price_cents: 900)
        update({ pay_what_you_want: true })
      end

      it "makes a product free and pay what you want", parity: true do
        update({ price_cents: 0, pay_what_you_want: false })

        expect(product.reload.customizable_price).to be true
      end

      it "refuses a suggested price while pay what you want is off", parity: true do
        update({ suggested_price_cents: 900 })

        expect(product.reload.suggested_price_cents).to be_nil
      end

      it "refuses a suggested price in a call that turns pay what you want off", parity: true do
        product.update_columns(customizable_price: true)
        update({ pay_what_you_want: false, suggested_price_cents: 900 })
      end

      it "reports a suggested price below the price as a tool error", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: 100 })

        expect(product.reload.customizable_price).to be_falsey
      end

      it "reports a price above the stored suggested price as a tool error", parity: true do
        product.update_columns(customizable_price: true, suggested_price_cents: 400)
        update({ price_cents: 800 })

        expect(product.reload.price_cents).to eq(300)
      end

      it "reports a negative suggested price as a tool error", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: -1 })
      end

      it "reports a suggested price over the maximum as a tool error", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: 2_147_483_648 })
      end

      it "keeps a suggested price equal to the price", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: 300 })
      end

      it "refuses a pay what you want switch that is not a boolean", parity: true do
        update({ pay_what_you_want: "yes" })
      end

      it "hands a suggested price with a decimal back to Rails", parity: true do
        update({ pay_what_you_want: true, suggested_price_cents: 9.5 })
      end

      it "refuses a null suggested price", parity: true do
        product.update_columns(customizable_price: true, suggested_price_cents: 900)
        update({ suggested_price_cents: nil })
      end

      it "hands a rename of a published product with pay what you want back to Rails", parity: true do
        product.update_columns(purchase_disabled_at: nil)
        update({ name: "Pen", pay_what_you_want: true })
      end

      it "hands a pay what you want change beside a discount code back to Rails", parity: true do
        create(:offer_code, user: seller, products: [product], code: "tenoff", amount_cents: 10)
        update({ pay_what_you_want: true })
      end

      it "hands a pay what you want change to a tiered membership back to Rails", parity: true do
        membership = create(:membership_product, user: seller, unique_permalink: "clubpk")
        call_tool("update_product", { id: membership.external_id, pay_what_you_want: true })
      end

      it "asks a pay what you want change without the edit scope to step up", parity: true do
        update({ pay_what_you_want: true }, scopes: "view_sales")
      end
    end

    it "asks a call without the edit scope to step up", parity: true do
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
