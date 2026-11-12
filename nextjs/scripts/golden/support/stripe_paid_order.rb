# frozen_string_literal: true

# Stripe and TaxJar as a paid POST /orders sees them, answered by WebMock in the golden generators (never the real services).
# The bodies under stripe_paid_order/ are the answers of the recorded $5 tokenized-card cassette (Orders_paid_purchase); the
# amounts, ids and statuses are rewritten per request so a taxed, tipped or multi-line order gets a consistent PaymentIntent
# and charge. Every call is also pushed into the statement log as an `http` entry, so the order of the Stripe calls against
# the writes is on record.
#
# A scenario picks what each Stripe step answers:
#   create:   :ok | :drop (every attempt of POST /v1/payment_intents loses its answer) | n (the first n attempts do)
#   confirm:  :succeeded | :requires_action | :processing | :decline | :drop | n
#   retrieve: what GET /v1/payment_intents/:id answers for a late confirmation (same values as confirm, plus :requires_payment_method)
#   decline:  overrides of the card error (code, decline_code, message)
require "json"
require "rack/utils"

class StripePaidOrder
  DIR = File.expand_path("stripe_paid_order", __dir__)
  PM_ID = "pm_1SzH3vIBOqvOFDrfC0dEIUL7"
  FIXTURES = %w[payment_method_get payment_intent_create payment_intent_confirm charge decline].index_with { JSON.parse(File.read("#{DIR}/#{_1}.json")).freeze }.freeze
  CREATED = 1_770_730_388
  TAX_RESPONSE = {
    "tax" => {
      "order_total_amount" => 5.0, "shipping" => 0.0, "taxable_amount" => 5.0, "amount_to_collect" => 0.51, "rate" => 0.1025,
      "has_nexus" => true, "freight_taxable" => false, "tax_source" => "destination",
      "jurisdictions" => { "country" => "US", "state" => "WA", "county" => "KING", "city" => "SEATTLE" },
      "breakdown" => {
        "taxable_amount" => 5.0, "tax_collectable" => 0.51, "combined_tax_rate" => 0.1025, "state_taxable_amount" => 5.0, "state_tax_rate" => 0.065,
        "state_tax_collectable" => 0.33, "county_taxable_amount" => 5.0, "county_tax_rate" => 0.004, "county_tax_collectable" => 0.02,
        "city_taxable_amount" => 5.0, "city_tax_rate" => 0.0, "city_tax_collectable" => 0.0, "special_district_taxable_amount" => 5.0,
        "special_tax_rate" => 0.0335, "special_district_tax_collectable" => 0.17
      }
    }
  }.freeze

  attr_reader :intents

  def initialize(create: :ok, confirm: :succeeded, retrieve: :succeeded, decline: {}, taxjar: :ok)
    @create = create
    @confirm = confirm
    @retrieve = retrieve
    @decline = decline
    @taxjar = taxjar
    @intents = {}
    @attempts = Hash.new(0)
    @retrieved = {}
  end

  def call(request, entry)
    uri = request.uri
    path = uri.path
    form = Rack::Utils.parse_nested_query(request.body.to_s)
    if uri.host.include?("taxjar") then answer_taxjar(path)
    elsif request.method == :get && path.start_with?("/v1/payment_methods/") then json(payment_method(path.split("/").last))
    elsif request.method == :post && path == "/v1/payment_intents" then answer_create(form, entry)
    elsif request.method == :post && path.end_with?("/confirm") then answer_confirm(path.split("/")[3], entry)
    elsif request.method == :get && path.start_with?("/v1/payment_intents/") then answer_retrieve(path.split("/").last)
    elsif request.method == :get && path.start_with?("/v1/charges/") then json(charge(path.split("/").last))
    else
      { status: 404, body: { error: { type: "invalid_request_error", message: "Unrecognized request URL (#{request.method.upcase}: #{path})" } }.to_json }
    end
  end

  private
    def json(body, status: 200) = { status:, body: body.to_json, headers: { "Content-Type" => "application/json" } }

    def drop!(key, mode, entry)
      @attempts[key] += 1
      dropped = mode == :drop || (mode.is_a?(Integer) && @attempts[key] <= mode)
      return unless dropped

      entry["dropped"] = true
      raise Net::ReadTimeout, "Net::ReadTimeout"
    end

    def answer_taxjar(path)
      return json(TAX_RESPONSE) if path == "/v2/taxes" && @taxjar == :ok

      json({ error: "Bad Request", detail: "unavailable", status: 503 }, status: 503)
    end

    def payment_method(id) = FIXTURES["payment_method_get"].merge("id" => id)

    def answer_create(form, entry)
      drop!(:create, @create, entry)
      id = "pi_golden_#{@intents.size + 1}"
      pi = FIXTURES["payment_intent_create"].merge(
        "id" => id, "client_secret" => "#{id}_secret_golden", "amount" => form["amount"].to_i, "currency" => form["currency"],
        "description" => form["description"], "metadata" => form["metadata"], "transfer_group" => form["transfer_group"],
        "payment_method" => form["payment_method"], "statement_descriptor_suffix" => form["statement_descriptor_suffix"],
        "application_fee_amount" => form["application_fee_amount"]&.to_i, "created" => CREATED
      )
      @intents[id] = pi
      json(pi)
    end

    def answer_confirm(id, entry)
      pi = @intents.fetch(id)
      drop!(:confirm, @confirm, entry)
      # A server-side confirm that follows a retrieve of an intent without a payment method is declined, as Stripe does.
      return json(decline_error(pi), status: 402) if @confirm == :decline || @retrieved[id] == :requires_payment_method

      json(intent_in(pi, @confirm == :drop || @confirm.is_a?(Integer) ? :succeeded : @confirm))
    end

    def answer_retrieve(id)
      pi = @intents.fetch(id)
      @retrieved[id] = @retrieve
      json(intent_in(pi, @retrieve))
    end

    def intent_in(pi, state)
      case state
      when :succeeded
        pi.merge("status" => "succeeded", "amount_received" => pi["amount"], "latest_charge" => "ch_#{pi["id"]}")
      when :requires_action
        pi.merge("status" => "requires_action", "next_action" => { "type" => "use_stripe_sdk", "use_stripe_sdk" => { "type" => "three_d_secure_redirect", "stripe_js" => "https://hooks.stripe.com/redirect/authenticate/src_golden" } })
      when :processing
        pi.merge("status" => "processing", "processing" => { "type" => "card", "card" => {} })
      when :requires_payment_method
        pi.merge("status" => "requires_payment_method", "last_payment_error" => decline_error(pi)["error"].except("payment_intent"))
      else
        raise "unknown intent state #{state.inspect}"
      end
    end

    def decline_error(pi)
      base = FIXTURES["decline"]
      error = base["error"].merge("charge" => "ch_#{pi["id"]}", "payment_intent" => pi.merge("status" => "requires_payment_method")).merge(@decline.transform_keys(&:to_s))
      { "error" => error }
    end

    def charge(id)
      pi = @intents.fetch(id.delete_prefix("ch_"))
      amount = pi["amount"]
      fee = (amount * 0.029 + 30).round
      base = FIXTURES["charge"]
      base.merge(
        "id" => id, "amount" => amount, "amount_captured" => amount, "payment_intent" => pi["id"], "description" => pi["description"],
        "metadata" => pi["metadata"], "created" => CREATED + 1, "application_fee_amount" => pi["application_fee_amount"],
        "balance_transaction" => base["balance_transaction"].merge(
          "id" => "txn_#{id}", "amount" => amount, "fee" => fee, "net" => amount - fee, "source" => id, "created" => CREATED + 1,
          "fee_details" => [base["balance_transaction"]["fee_details"][0].merge("amount" => fee)]
        )
      ).tap { |c| c["payment_method_details"] = c["payment_method_details"].merge("card" => c["payment_method_details"]["card"].merge("amount_authorized" => amount)) }
    end
end
