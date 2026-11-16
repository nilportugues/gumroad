# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/save-installment.golden.json: SaveInstallmentService#process and
# Workflow::ManageService#process run by the real app against a scratch database, inside the executor a request runs in
# (query cache on, support/sidekiq_executor.rb). Every statement, Redis write, Sidekiq push and Elasticsearch request is
# recorded. Run it like workflow-writes.rb:
#
#   RAILS_ENV=test DATABASE_NAME=gumroad_ws82 TEST_DATABASE_NAME=gumroad_ws82 DISABLE_TEST_REDIS_ISOLATION=1 \
#     USE_DB_WORKER_REPLICAS=true REDIS_HOST=127.0.0.1:6379/6 SIDEKIQ_REDIS_HOST=127.0.0.1:6379/6 \
#     RPUSH_REDIS_HOST=127.0.0.1:6379/6 RACK_ATTACK_REDIS_HOST=127.0.0.1:6379/6 \
#     OBFUSCATE_IDS_CIPHER_KEY=ws82-golden-obfuscate-key OBFUSCATE_IDS_NUMERIC_CIPHER_KEY=123456789 \
#     bundle exec ruby bin/rails runner nextjs/scripts/golden/save-installment.rb
require_relative "support/rails_cases"
include RailsCases
capture_elasticsearch!

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/save-installment.golden.json")
NOW = Time.utc(2025, 11, 1, 12, 30, 45, 123_000)
SEEDED_AT = "2025-01-01 00:00:00"
TABLES = %w[users links installments installment_rules versions product_files payments post_email_blasts team_memberships seller_profiles
            seller_profile_sections workflows base_variants variant_categories workflow_installment_schedule_intents merchant_accounts purchases].freeze
SHOWN_ON_PROFILE = 1 << 7
SEND_EMAILS = 1 << 8
TEAM_MEMBER = 1 << 27

Stripe.api_base = "http://127.0.0.1:9"
Stripe.max_network_retries = 0
ActiveJob::Base.queue_adapter = :sidekiq
ActiveJob::Base.logger = Logger.new(nil)
Rails.logger = ActiveSupport::Logger.new(nil)

$uuid_seq = 0
SecureRandom.singleton_class.prepend(Module.new do
  def uuid
    $uuid_seq += 1
    format("00000000-0000-4000-8000-%012d", $uuid_seq)
  end

  def hex(n = nil)
    return super unless n == 4

    $hex_seq = ($hex_seq || 0) + 1
    format("%08x", $hex_seq)
  end
end)

def es_answer(count, price_cents = 0)
  seller = %w[price_cents fee_cents amount_refunded_cents fee_refunded_cents affiliate_credit_amount_cents affiliate_credit_amount_partially_refunded_cents
              direct_affiliate_credit_amount_cents direct_affiliate_credit_amount_partially_refunded_cents].to_h { ["#{_1}_total", { "value" => _1 == "price_cents" ? price_cents : 0 }] }
  own = %w[affiliate_credit direct_affiliate_credit].product(%w[amount_cents fee_cents amount_partially_refunded_cents fee_partially_refunded_cents])
    .to_h { |prefix, measure| ["#{prefix}_#{measure}_own", { "total" => { "value" => 0 } }] }
  { "count" => count, "aggregations" => seller.merge(own) }
end

def user_row(id, **overrides)
  { id:, email: "user#{id}@example.com", username: "user#{id}", external_id: (1000 + id).to_s, recommendation_type: "own_products",
    user_risk_state: "compliant", flags: TEAM_MEMBER, json_data: nil, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT, timezone: "Pacific Time (US & Canada)" }.merge(overrides)
end

def link_row(id = 1, **overrides)
  { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def installment_row(id, **overrides)
  { id:, seller_id: 1, installment_type: "audience", name: "Email #{id}", message: "<p>Hello</p>", slug: "email-#{id}", flags: SEND_EMAILS,
    created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def rule_row(installment_id, **overrides)
  { id: installment_id, installment_id:, version: 3, to_be_published_at: "2025-12-01 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def profile_row(seller_id = 1) = { id: seller_id, seller_id:, created_at: SEEDED_AT, updated_at: SEEDED_AT }

def section_row(id, shown_posts: [], **overrides)
  { id:, seller_id: 1, type: "SellerProfilePostsSection", header: "Posts #{id}", json_data: { shown_posts: }.to_json, flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

def payment_row(user_id) = { id: user_id, user_id:, state: "completed", amount_cents: 1000, created_at: SEEDED_AT, updated_at: SEEDED_AT }

cases = []

# kind "installment": SaveInstallmentService; kind "workflow": Workflow::ManageService.
installment_call = lambda do |name, installment_params: {}, installment_id: nil, top: {}, es_body: es_answer(3), kind: "installment", **seed|
  seed = { users: [user_row(1)], links: [link_row], installments: [], installment_rules: [] }.merge(seed)
  $uuid_seq = 0
  $hex_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, kind:, case_now: NOW.to_f, es_body:, request_params: { installment: installment_params }.merge(top), installment_id:) do
    seller = User.find(1)
    params = ActionController::Parameters.new({ installment: installment_params }.merge(top))
    installment = installment_id && Installment.find(installment_id)
    service = SaveInstallmentService.new(seller:, params:, installment:, preview_email_recipient: seller)
    ok = service.process
    $return = { "ok" => ok, "error" => service.error, "installment_id" => service.installment&.id }
  end
  result.delete("rows")
  result.delete("seed")
  result["return"] = result["error"] ? nil : $return
  cases << result
end

draft = { name: "Hello world", message: "<p>Hi there</p>", installment_type: "audience", send_emails: true, shown_on_profile: false, allow_comments: true,
          shown_in_profile_sections: [], files: [] }
product_draft = draft.merge(installment_type: "product", link_id: "p1")

# --- creating -----------------------------------------------------------------------------------------------------------
installment_call.call("create: an audience email draft", installment_params: draft)
installment_call.call("create: a post shown on the profile only", installment_params: draft.merge(send_emails: false, shown_on_profile: true))
installment_call.call("create: a product email", installment_params: product_draft)
installment_call.call("create: a seller email with filters", installment_params: draft.merge(installment_type: "seller", paid_more_than_cents: 500, paid_less_than_cents: 9000, created_after: "2025-01-02",
                                                                                          created_before: "2025-02-03", bought_from: "Canada", active_customers_only: true, minimum_license_uses: "2",
                                                                                          bought_products: %w[p1], not_bought_products: %w[p2]))
installment_call.call("create: a follower email", installment_params: draft.merge(installment_type: "follower"))
installment_call.call("create: an affiliate email", installment_params: draft.merge(installment_type: "affiliate", affiliate_products: %w[p1]))
variant_rows = { variant_categories: [{ id: 1, link_id: 1, title: "Tier" }],
                 base_variants: [{ id: 5, variant_category_id: 1, type: "Variant", name: "Gold", created_at: SEEDED_AT, updated_at: SEEDED_AT }] }
variant_draft = draft.merge(installment_type: "variant", link_id: "p1")
installment_call.call("create: a variant post", installment_params: variant_draft, top: { variant_external_id: ObfuscateIds.encrypt(5) }, **variant_rows)
installment_call.call("create: a variant post with an unknown option", installment_params: variant_draft, top: { variant_external_id: "unknown" }, **variant_rows)
installment_call.call("create: a variant post without an option id", installment_params: variant_draft, **variant_rows)
installment_call.call("create: a variant post without a product", installment_params: variant_draft.merge(link_id: ""), top: { variant_external_id: ObfuscateIds.encrypt(5) }, **variant_rows)
installment_call.call("update: a draft to a variant post", installment_id: 10, installment_params: variant_draft, top: { variant_external_id: ObfuscateIds.encrypt(5) }, es_body: es_answer(3),
                      installments: [installment_row(10)], **variant_rows)
installment_call.call("update: a variant draft to an audience email", installment_id: 10, installment_params: draft, es_body: es_answer(3),
                      installments: [installment_row(10, installment_type: "variant", link_id: 1, base_variant_id: 5)], **variant_rows)
installment_call.call("create: a product that is not the seller's", installment_params: product_draft.merge(link_id: "p9"))
installment_call.call("create: a product email without a product", installment_params: product_draft.merge(link_id: ""))
installment_call.call("create: paid more than paid less", installment_params: draft.merge(installment_type: "seller", paid_more_than_cents: 9000, paid_less_than_cents: 500))
installment_call.call("create: created after created before", installment_params: draft.merge(installment_type: "seller", created_after: "2025-03-01", created_before: "2025-01-01"))
installment_call.call("create: an empty message", installment_params: draft.merge(message: "<p><br></p>"))
installment_call.call("create: no channel", installment_params: draft.merge(send_emails: false, shown_on_profile: false))
installment_call.call("create: a name that is taken", installment_params: draft, installments: [installment_row(10, name: "Hello world", slug: "hello-world")])
installment_call.call("create: a name that is taken twice", installment_params: draft,
                      installments: [installment_row(10, name: "Hello world", slug: "hello-world"), installment_row(11, name: "Hello world", slug: "hello-world-11")])
installment_call.call("create: a name with punctuation", installment_params: draft.merge(name: "  Hello,  World!! (2025) -- ok  "))
installment_call.call("create: a name that is a reserved word", installment_params: draft.merge(name: "new"))
installment_call.call("create: a blank name", installment_params: draft.merge(name: ""))
installment_call.call("create: a name that needs transliteration", installment_params: draft.merge(name: "Café Münster"))
installment_call.call("create: a post shown on the profile of an unconfirmed seller", installment_params: draft.merge(shown_on_profile: true), users: [user_row(1, confirmed_at: nil)])
installment_call.call("create: shown in profile sections", installment_params: draft.merge(shown_in_profile_sections: [ObfuscateIds.encrypt(2)]),
                      seller_profiles: [profile_row], seller_profile_sections: [section_row(1, shown_posts: [7]), section_row(2), section_row(3, type: "SellerProfileProductsSection", json_data: nil)])
installment_call.call("create: a seller with a profile and no sections", installment_params: draft, seller_profiles: [profile_row])
installment_call.call("create: with a file", installment_params: draft.merge(files: [{ external_id: "f1", position: 0, url: "https://example.com/f.pdf", stream_only: false }]))
installment_call.call("create: a message with an upsell card", installment_params: draft.merge(message: "<p>x</p><upsell-card productid=\"1\"></upsell-card>"))
installment_call.call("create: a message with markup", installment_params: draft.merge(message: "<h2>Title</h2><p>One <strong>two</strong> <em>three</em><br>four</p>"))
installment_call.call("create: a message with a link", installment_params: draft.merge(message: "<p><a href=\"https://example.com/a?b=1&amp;c=2\">link</a></p>"))
installment_call.call("create: a message with entities and quotes", installment_params: draft.merge(message: "<p>Tom &amp; Jerry \"quoted\" it's &lt;b&gt; 5 &gt; 3</p>"))
installment_call.call("create: a message with unicode", installment_params: draft.merge(message: "<p>Café — 日本</p>"))
installment_call.call("create: a message that is plain text", installment_params: draft.merge(message: "Just text"))
installment_call.call("create: a message with unclosed tags", installment_params: draft.merge(message: "<p>One<p>Two<br"))
installment_call.call("create: a message with attributes", installment_params: draft.merge(message: "<p class=\"x\" style=\"color: red\">Hi</p><img src=\"https://example.com/a.png\" alt=\"A\">"))
installment_call.call("create: a message with a script", installment_params: draft.merge(message: "<p>Hi</p><script>alert(1)</script>"))
[
  ["a newline between blocks", "<p>a</p>\n<p>b</p>"],
  ["a trailing newline", "<p>a</p>\n"],
  ["leading spaces", "  <p>a</p>"],
  ["double spaces and a newline in text", "<p>a  b\nc</p>"],
  ["upper case tags", "<P>Upper</P><BR>"],
  ["a self closing br", "<p>a<br/>b<br />c</p>"],
  ["a non breaking space", "<p>a&nbsp;b \u00a0c</p>"],
  ["a numeric entity", "<p>&#169; &copy; &quot;x&quot;</p>"],
  ["a list of paragraphs", "<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li>x</li></ol>"],
  ["a code block", "<pre><code>a &lt; b\n  c</code></pre><blockquote><p>q</p></blockquote><hr>"],
  ["an image", "<p><img src=\"https://example.com/a b.png\" alt=\"A &amp; B\"></p>"],
  ["a link with a space and non ascii", "<p><a href=\"https://example.com/a b/\u00e9\" target=\"_blank\" rel=\"noopener\">x</a></p>"],
  ["an empty paragraph", "<p></p><p>x</p>"],
  ["a block inside a paragraph", "<p>a<div>b</div></p>"],
  ["a stray closing tag", "<p>a</p></div>"],
  ["a comment", "<p>a</p><!-- c -->"],
  ["a bare ampersand and angle", "<p>a & b < c</p>"],
  ["a tab and a carriage return", "<p>a\tb\r\nc</p>"],
  ["underline strike and heading", "<h1>H</h1><p><u>u</u><s>s</s><b>b</b><i>i</i></p>"],
  ["attributes without values or quotes", "<p class=x data-a>hi</p>"],
].each do |label, message|
  installment_call.call("message: #{label}", installment_params: draft.merge(message:))
end
installment_call.call("create: a name longer than the column", installment_params: draft.merge(name: "x" * 300))

# --- publishing and scheduling ------------------------------------------------------------------------------------------
installment_call.call("publish: an audience email", installment_params: draft, top: { publish: "true" }, es_body: es_answer(3))
installment_call.call("publish: a post shown on the profile only", installment_params: draft.merge(send_emails: false, shown_on_profile: true), top: { publish: "true" })
installment_call.call("publish: a seller who may not send emails", installment_params: draft, top: { publish: "true" }, users: [user_row(1, flags: 0)])
installment_call.call("publish: a seller with sales and a payout", installment_params: draft, top: { publish: "true" }, es_body: es_answer(3, 20_000), users: [user_row(1, flags: 0)], payments: [payment_row(1)])
installment_call.call("publish: more than 100 recipients from a small seller", installment_params: draft, top: { publish: "true" }, es_body: es_answer(101, 100))
installment_call.call("publish: an unconfirmed seller", installment_params: draft.merge(send_emails: false, shown_on_profile: false), top: { publish: "true" }, users: [user_row(1, confirmed_at: nil)])
installment_call.call("publish: a draft that exists", installment_id: 10, installment_params: draft.merge(name: "Email 10"), top: { publish: "true" }, es_body: es_answer(3), installments: [installment_row(10)])
installment_call.call("publish: a draft with a schedule", installment_id: 10, installment_params: draft.merge(name: "Email 10"), top: { publish: "true" }, es_body: es_answer(3),
                      installments: [installment_row(10)], installment_rules: [rule_row(10)])
installment_call.call("schedule: an audience email", installment_params: draft, top: { to_be_published_at: "2025-12-24T09:30:00" }, es_body: es_answer(3))
installment_call.call("schedule: an invalid date", installment_params: draft, top: { to_be_published_at: "2025-13-45T09:30:00" }, es_body: es_answer(3))
installment_call.call("schedule: an unconfirmed seller", installment_params: draft, top: { to_be_published_at: "2025-12-24T09:30:00" }, users: [user_row(1, confirmed_at: nil)])
installment_call.call("schedule: a draft that was scheduled before", installment_id: 10, installment_params: draft.merge(name: "Email 10"), top: { to_be_published_at: "2025-12-25 10:00" }, es_body: es_answer(3),
                      installments: [installment_row(10)], installment_rules: [rule_row(10, deleted_at: SEEDED_AT)])
installment_call.call("schedule: a seller who may not send emails", installment_params: draft, top: { to_be_published_at: "2025-12-24T09:30:00" }, users: [user_row(1, flags: 0)])

# --- updating -----------------------------------------------------------------------------------------------------------
existing = { installments: [installment_row(10)] }
installment_call.call("update: a draft", installment_id: 10, installment_params: draft.merge(name: "Renamed", message: "<p>New text</p>"), es_body: es_answer(3), **existing)
installment_call.call("update: nothing changed", installment_id: 10, installment_params: draft.merge(name: "Email 10", message: "<p>Hello</p>"), es_body: es_answer(3), **existing)
installment_call.call("update: a draft without a slug", installment_id: 10, installment_params: draft.merge(name: "Renamed"), es_body: es_answer(3), installments: [installment_row(10, slug: nil)])
installment_call.call("update: the type of a draft", installment_id: 10, installment_params: product_draft, es_body: es_answer(3), **existing)
installment_call.call("update: a product email to an audience email", installment_id: 10, installment_params: draft, es_body: es_answer(3), installments: [installment_row(10, installment_type: "product", link_id: 1)])
installment_call.call("update: filters of a draft", installment_id: 10, installment_params: draft.merge(installment_type: "seller", bought_products: %w[p1], paid_more_than_cents: 100), es_body: es_answer(3),
                      installments: [installment_row(10, installment_type: "seller", json_data: { bought_products: %w[p2], created_after: "2024-01-01T00:00:00-08:00" }.to_json)])
installment_call.call("update: an empty message", installment_id: 10, installment_params: draft.merge(message: ""), es_body: es_answer(3), **existing)
installment_call.call("update: a draft not shown in a section any more", installment_id: 10, installment_params: draft.merge(shown_in_profile_sections: []), es_body: es_answer(3),
                      installments: [installment_row(10)], seller_profiles: [profile_row], seller_profile_sections: [section_row(1, shown_posts: [10, 7]), section_row(2, shown_posts: [10])])
published = { installments: [installment_row(10, published_at: SEEDED_AT, flags: SEND_EMAILS | SHOWN_ON_PROFILE)] }
installment_call.call("update: a published post", installment_id: 10, installment_params: draft.merge(name: "Renamed", message: "<p>Edited</p>", allow_comments: false, installment_type: "product", link_id: "p1"), es_body: es_answer(3), **published)
installment_call.call("update: a published post, new publish date", installment_id: 10, installment_params: draft.merge(name: "Email 10", published_at: "2025-06-01T10:00:00Z"), es_body: es_answer(3), **published)
installment_call.call("update: a published post, same publish day", installment_id: 10, installment_params: draft.merge(name: "Email 10", published_at: "2025-01-01T20:00:00Z"), es_body: es_answer(3), **published)
installment_call.call("update: a published post that was emailed", installment_id: 10, installment_params: draft.merge(name: "Email 10", send_emails: false, shown_on_profile: true), es_body: es_answer(3),
                      installments: [installment_row(10, published_at: SEEDED_AT)], post_email_blasts: [{ id: 1, post_id: 10, seller_id: 1, requested_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }])
installment_call.call("update: a published post emptied", installment_id: 10, installment_params: draft.merge(message: "<p><br></p>"), es_body: es_answer(3), **published)

# --- Workflow::ManageService --------------------------------------------------------------------------------------------
def workflow_row(id = 1, **overrides)
  { id:, name: "Workflow #{id}", seller_id: 1, workflow_type: "audience", flags: 0, json_data: nil, created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
end

workflow_call = lambda do |name, workflow_params: {}, workflow_id: nil, es_body: es_answer(3), **seed|
  seed = { users: [user_row(1)], links: [link_row], workflows: [], installments: [], installment_rules: [] }.merge(seed)
  $uuid_seq = 0
  $hex_seq = 0
  result = capture(name, now: NOW, tables: TABLES, seed:, sidekiq: true, kind: "workflow", case_now: NOW.to_f, es_body:, request_params: { workflow: workflow_params }, installment_id: workflow_id) do
    seller = User.find(1)
    params = ActionController::Parameters.new({ workflow: workflow_params }).require(:workflow).permit(
      :name, :workflow_type, :variant_external_id, :workflow_trigger, :paid_more_than, :paid_less_than, :bought_from, :created_after, :created_before, :permalink,
      :send_to_past_customers, :save_action_name, bought_products: [], not_bought_products: [], affiliate_products: [], bought_variants: [], not_bought_variants: []
    )
    product = nil
    if [Workflow::PRODUCT_TYPE, Workflow::VARIANT_TYPE].include?(params[:workflow_type])
      product = seller.products.visible.find_by(unique_permalink: params[:permalink]) || seller.products.visible.find_by(custom_permalink: params[:permalink]) || raise("404")
    end
    workflow = workflow_id && Workflow.find(workflow_id)
    service = Workflow::ManageService.new(seller:, params:, product:, workflow:)
    ok, error = service.process
    $return = { "ok" => ok, "error" => error, "installment_id" => service.workflow.id }
  end
  result.delete("rows")
  result.delete("seed")
  result["return"] = result["error"] ? nil : $return
  cases << result
end

wf = { name: "Welcome", workflow_type: "audience", workflow_trigger: nil, bought_products: [], bought_variants: [], variant_external_id: nil, permalink: nil, not_bought_products: [], not_bought_variants: [],
       paid_more_than: nil, paid_less_than: nil, created_after: "", created_before: "", bought_from: nil, affiliate_products: [], send_to_past_customers: false, save_action_name: "save" }
workflow_call.call("workflow create: an audience workflow", workflow_params: wf)
workflow_call.call("workflow create: a workflow without a name", workflow_params: wf.merge(name: nil))
workflow_call.call("workflow create: a seller workflow with filters", workflow_params: wf.merge(workflow_type: "seller", paid_more_than: 10, paid_less_than: "50.5", created_after: "2025-01-02", created_before: "2025-02-03",
                                                                                              bought_from: "Canada", bought_products: %w[p1], not_bought_products: %w[p2], send_to_past_customers: true))
workflow_call.call("workflow create: a product workflow", workflow_params: wf.merge(workflow_type: "product", permalink: "p1", send_to_past_customers: true, bought_products: %w[p1]))
workflow_call.call("workflow create: a product workflow with a member cancellation trigger", workflow_params: wf.merge(workflow_type: "product", permalink: "p1", workflow_trigger: "member_cancellation"))
workflow_call.call("workflow create: a follower workflow", workflow_params: wf.merge(workflow_type: "follower"))
workflow_call.call("workflow create: an affiliate workflow", workflow_params: wf.merge(workflow_type: "affiliate", affiliate_products: %w[p1]))
workflow_call.call("workflow create: paid more than paid less", workflow_params: wf.merge(workflow_type: "seller", paid_more_than: 500, paid_less_than: 10))
workflow_call.call("workflow create: before and after dates out of order", workflow_params: wf.merge(workflow_type: "seller", created_after: "2025-03-01", created_before: "2025-01-01"))
workflow_call.call("workflow create: save and publish is ignored for a new workflow", workflow_params: wf.merge(save_action_name: "save_and_publish"))
workflow_call.call("workflow create: an abandoned cart workflow for a seller without a payout", workflow_params: wf.merge(workflow_type: "abandoned_cart"), users: [user_row(1, flags: 0)])
workflow_call.call("workflow create: an abandoned cart workflow", workflow_params: wf.merge(workflow_type: "abandoned_cart"))
workflow_call.call("workflow create: a variant workflow", workflow_params: wf.merge(workflow_type: "variant", permalink: "p1", variant_external_id: "x"))
workflow_call.call("workflow create: a product that is not the seller's", workflow_params: wf.merge(workflow_type: "product", permalink: "p9"))

emails = { installments: [installment_row(10, workflow_id: 1), installment_row(11, workflow_id: 1, name: "Second")],
           installment_rules: [rule_row(10, delayed_delivery_time: 3600, time_period: "hour", to_be_published_at: nil), rule_row(11, delayed_delivery_time: 86_400, time_period: "day", to_be_published_at: nil)] }
unpublished = { workflows: [workflow_row(1)] }
published = { workflows: [workflow_row(1, published_at: SEEDED_AT, first_published_at: SEEDED_AT)],
              installments: [installment_row(10, workflow_id: 1, published_at: SEEDED_AT), installment_row(11, workflow_id: 1, name: "Second", published_at: SEEDED_AT)], installment_rules: emails[:installment_rules] }
workflow_call.call("workflow update: a rename", workflow_id: 1, workflow_params: wf.merge(name: "Renamed"), **unpublished)
workflow_call.call("workflow update: nothing changed", workflow_id: 1, workflow_params: wf.merge(name: "Workflow 1"), **unpublished)
workflow_call.call("workflow update: the emails follow the filters", workflow_id: 1, workflow_params: wf.merge(workflow_type: "seller", paid_more_than: 10, bought_products: %w[p1], send_to_past_customers: true), **unpublished, **emails)
workflow_call.call("workflow update: the emails follow a product", workflow_id: 1, workflow_params: wf.merge(workflow_type: "product", permalink: "p1"), **unpublished, **emails)
workflow_call.call("workflow update: an email that is deleted stays out", workflow_id: 1, workflow_params: wf.merge(name: "Renamed"), **unpublished,
                   installments: emails[:installments] + [installment_row(12, workflow_id: 1, deleted_at: SEEDED_AT)], installment_rules: emails[:installment_rules])
workflow_call.call("workflow update: an email with an empty message", workflow_id: 1, workflow_params: wf.merge(workflow_type: "seller"), **unpublished,
                   installments: [installment_row(10, workflow_id: 1, message: "<p><br></p>")], installment_rules: [])
workflow_call.call("workflow update: a published workflow keeps its audience", workflow_id: 1, workflow_params: wf.merge(name: "Renamed", workflow_type: "seller", paid_more_than: 99), **published)
workflow_call.call("workflow update: save and publish", workflow_id: 1, workflow_params: wf.merge(save_action_name: "save_and_publish"), **unpublished, **emails)
workflow_call.call("workflow update: save and publish without emails", workflow_id: 1, workflow_params: wf.merge(save_action_name: "save_and_publish"), **unpublished)
workflow_call.call("workflow update: save and publish by a seller who may not", workflow_id: 1, workflow_params: wf.merge(save_action_name: "save_and_publish"), **unpublished, **emails, users: [user_row(1, flags: 0)])
workflow_call.call("workflow update: save and unpublish", workflow_id: 1, workflow_params: wf.merge(save_action_name: "save_and_unpublish"), **published)
workflow_call.call("workflow update: save and unpublish a workflow that is not published", workflow_id: 1, workflow_params: wf.merge(save_action_name: "save_and_unpublish"), **unpublished, **emails)
workflow_call.call("workflow update: abandoned cart emails go when the type changes", workflow_id: 1, workflow_params: wf.merge(name: "Renamed"), **unpublished,
                   installments: [installment_row(10, workflow_id: 1, installment_type: "abandoned_cart")], installment_rules: [rule_row(10, delayed_delivery_time: 86_400, time_period: "hour", to_be_published_at: nil)])
workflow_call.call("workflow update: an abandoned cart workflow", workflow_id: 1, workflow_params: wf.merge(workflow_type: "abandoned_cart"), workflows: [workflow_row(1, workflow_type: "abandoned_cart")],
                   installments: [installment_row(10, workflow_id: 1, installment_type: "abandoned_cart")], installment_rules: [rule_row(10, delayed_delivery_time: 86_400, time_period: "hour", to_be_published_at: nil)])
workflow_call.call("workflow update: invalid paid filters", workflow_id: 1, workflow_params: wf.merge(workflow_type: "seller", paid_more_than: 500, paid_less_than: 10), **unpublished)
workflow_call.call("workflow update: a member cancellation workflow", workflow_id: 1, workflow_params: wf.merge(workflow_type: "product", permalink: "p1", workflow_trigger: "member_cancellation"), workflows: [workflow_row(1, workflow_type: "product", link_id: 1)])

File.write(OUT, JSON.pretty_generate({ "now" => NOW.to_f, "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"
