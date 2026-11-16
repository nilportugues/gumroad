# frozen_string_literal: true

require "spec_helper"

# Signed-in visits to the emails pages, recorded for the Next.js port (PARITY_RECORD=1) and replayed by
# nextjs/parity/__tests__/audience-pages.replay.test.ts, which sends the last request of each example.
describe "Emails when signed in", type: :request, elasticsearch_wait_for_refresh: true do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Emailing Seller") }
  let(:partial_headers) do
    { "X-Inertia" => "true", "X-Inertia-Partial-Component" => "Emails/Published", "X-Inertia-Partial-Data" => "installments,pagination", "X-Requested-With" => "XMLHttpRequest" }
  end

  before { host! DOMAIN }

  def post_for(seller, name, **attributes)
    create(:audience_installment, seller:, name:, message: "<p>#{name} body</p>", **attributes)
  end

  def resend_open(installment, opened_at:)
    CreatorContactingCustomersEmailInfo.new(installment:, purchase_id: rand(1..1_000_000), email_name: "purchase_installment", state: "opened", sent_at: opened_at - 1.hour, opened_at:).save!(validate: false)
  end

  it "redirects a signed-out visitor to the login page", parity: true do
    get published_emails_path

    expect(response).to redirect_to(login_path(next: "/emails/published"))
  end

  it "sends /emails to the published tab for a seller without scheduled emails", parity: true do
    log_in(seller)

    get emails_path

    expect(response).to have_http_status(:moved_permanently)
    expect(response).to redirect_to(published_emails_path)
  end

  it "sends /emails to the scheduled tab for a seller with a scheduled email", parity: true do
    post_for(seller, "Coming soon", ready_to_publish: true).tap { create(:installment_rule, installment: _1, to_be_published_at: (2.days + 90.minutes).from_now) }
    log_in(seller)

    get emails_path

    expect(response).to redirect_to(scheduled_emails_path)
  end

  it "lists no emails for a seller without any and records the view", parity: true do
    log_in(seller)

    get published_emails_path

    expect(response).to be_successful
    expect(inertia_props_of(response)).to include("installments" => [], "has_posts" => false, "pagination" => { "count" => 0, "next" => nil })
  end

  it "lists published emails newest first with their profile sections and recipients", parity: true do
    product = create(:product, user: seller, name: "Emailed product")
    section = create(:seller_profile_posts_section, seller:, header: "Updates")
    older = post_for(seller, "Older update", published_at: Time.utc(2025, 1, 2), shown_on_profile: true, slug: "older-update")
    section.update!(shown_posts: [older.id])
    create(:product_post, seller:, link: product, name: "Product news", message: "<p>For buyers</p>", published_at: Time.utc(2025, 3, 2))
    create(:seller_post, seller:, name: "Everyone news", message: "<p>Customers</p>", published_at: Time.utc(2025, 2, 2), send_emails: false, shown_on_profile: true)
    post_for(seller, "Draft only")
    log_in(seller)

    get published_emails_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["installments"].map { _1["name"] }).to eq(["Product news", "Everyone news", "Older update"])
    expect(inertia_props_of(response)["has_posts"]).to eq(true)
  end

  it "shows the delivery state of a blast that is still sending, one that stalled and one that expired", parity: true do
    sending = post_for(seller, "Sending now", published_at: 10.minutes.ago)
    sending_blast = create(:post_email_blast, post: sending, requested_at: 10.minutes.ago, last_email_delivered_at: 1.minute.ago, delivery_count: 40)
    $redis.set(RedisKey.blast_pending_recipients(sending_blast.id), 60)
    stalled = post_for(seller, "Stalled", published_at: 3.hours.ago)
    stalled_blast = create(:post_email_blast, post: stalled, requested_at: 3.hours.ago, last_email_delivered_at: 2.hours.ago, delivery_count: 10)
    $redis.set(RedisKey.blast_pending_recipients(stalled_blast.id), 90)
    waiting = post_for(seller, "Waiting for quota", published_at: 20.minutes.ago)
    waiting_blast = create(:post_email_blast, post: waiting, requested_at: 20.minutes.ago, last_email_delivered_at: nil, first_email_delivered_at: nil, delivery_count: 0)
    $redis.set(RedisKey.blast_quota_deferred_until(waiting_blast.id), 10.years.from_now.iso8601)
    expired = post_for(seller, "Expired", published_at: 2.days.ago)
    create(:post_email_blast, post: expired, requested_at: 2.days.ago, first_email_delivered_at: nil, last_email_delivered_at: nil, delivery_count: 0, expired_at: 1.day.ago, expiry_reason: "quota")
    abandoned = post_for(seller, "Abandoned", published_at: 3.days.ago)
    create(:post_email_blast, post: abandoned, requested_at: 3.days.ago, first_email_delivered_at: nil, delivery_count: 0, expired_at: 2.days.ago, expiry_reason: "abandoned")
    stopped = post_for(seller, "Stopped", published_at: 4.days.ago)
    create(:post_email_blast, post: stopped, requested_at: 4.days.ago, delivery_count: 5, expired_at: 3.days.ago, expiry_reason: "newsletter_retired")
    done = post_for(seller, "Done", published_at: 5.days.ago)
    create(:post_email_blast, post: done, requested_at: 5.days.ago, completed_at: 5.days.ago + 1.hour, delivery_count: 100)
    log_in(seller)

    get published_emails_path

    expect(response).to be_successful
    statuses = inertia_props_of(response)["installments"].to_h { [_1["name"], _1.dig("delivery", "status")] }
    expect(statuses).to include("Sending now" => "sending", "Stalled" => "incomplete", "Waiting for quota" => "waiting", "Expired" => "expired", "Abandoned" => "abandoned", "Stopped" => "stopped", "Done" => "sent")
  end

  it "reports the resends to non-openers with the opens credited to each", parity: true do
    post = post_for(seller, "Resent post", published_at: 5.days.ago, customer_count: 10)
    create(:post_email_blast, post:, requested_at: 5.days.ago, completed_at: 5.days.ago + 1.hour, delivery_count: 10)
    first = create(:post_email_blast, post:, requested_at: 3.days.ago, completed_at: 3.days.ago + 1.hour, delivery_count: 4, recipient_filter: "unopened")
    create(:post_email_blast, post:, requested_at: 1.day.ago, completed_at: 1.day.ago + 1.hour, delivery_count: 2, recipient_filter: "unopened")
    create(:post_email_blast, post:, requested_at: 1.hour.ago, completed_at: nil, delivery_count: 0, recipient_filter: "unopened")
    resend_open(post, opened_at: first.requested_at + 1.hour)
    resend_open(post, opened_at: first.requested_at + 2.hours)
    resend_open(post, opened_at: 20.hours.ago)
    log_in(seller)

    get published_emails_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["installments"].first["non_opener_resends"].size).to eq(3)
  end

  it "says there are more emails than one page holds and answers the next page as a partial reload", parity: true do
    26.times { |index| post_for(seller, "Email #{index}", published_at: Time.utc(2025, 1, 1) + index.days) }
    log_in(seller)

    get published_emails_path, params: { page: 2 }, headers: partial_headers

    expect(response).to be_successful
    expect(response.parsed_body["props"]["installments"].size).to eq(1)
    expect(response.parsed_body["props"]["pagination"]).to eq("count" => 26, "next" => nil)
  end

  it "shows the first page with a next page", parity: true do
    26.times { |index| post_for(seller, "Email #{index}", published_at: Time.utc(2025, 1, 1) + index.days) }
    log_in(seller)

    get published_emails_path

    expect(inertia_props_of(response)["installments"].size).to eq(25)
    expect(inertia_props_of(response)["pagination"]).to eq("count" => 26, "next" => 2)
  end

  it "answers a page past the end with no emails", parity: true do
    post_for(seller, "Only email", published_at: Time.utc(2025, 1, 1))
    log_in(seller)

    get published_emails_path, params: { page: 9 }

    expect(inertia_props_of(response)["installments"]).to eq([])
    expect(inertia_props_of(response)["pagination"]).to eq("count" => 1, "next" => nil)
  end

  it "searches the name and message of published emails", parity: true do
    post_for(seller, "Launch week", published_at: Time.utc(2025, 1, 5), created_at: Time.utc(2025, 1, 1))
    post_for(seller, "Weekly digest", message: "<p>Launch notes</p>", published_at: Time.utc(2025, 1, 6), created_at: Time.utc(2025, 1, 2))
    post_for(seller, "Unrelated", published_at: Time.utc(2025, 1, 7))
    index_model_records(Installment)
    log_in(seller)

    get published_emails_path, params: { query: "  Launch " }

    expect(response).to be_successful
    expect(inertia_props_of(response)["installments"].map { _1["name"] }).to match_array(["Launch week", "Weekly digest"])
    expect(inertia_props_of(response)["pagination"]).to eq("count" => 2, "next" => nil)
  end

  it "lists scheduled emails by the time they go out", parity: true do
    later = post_for(seller, "Later", ready_to_publish: true)
    create(:installment_rule, installment: later, to_be_published_at: (5.days + 90.minutes).from_now)
    sooner = post_for(seller, "Sooner", ready_to_publish: true, installment_type: "seller", link: nil)
    create(:installment_rule, installment: sooner, to_be_published_at: (1.day + 90.minutes).from_now)
    log_in(seller)

    get scheduled_emails_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["installments"].map { _1["name"] }).to eq(%w[Sooner Later])
    expect(inertia_props_of(response)["installments"].first).to include("display_type" => "scheduled", "recipient_description" => "Your customers")
  end

  it "lists drafts by the time they were last changed with who they are for", parity: true do
    product = create(:product, user: seller, name: "Drafted product")
    create(:product_post, seller:, link: product, name: "Product draft", message: "<p>x</p>", updated_at: (2.days + 90.minutes).ago)
    create(:follower_post, seller:, name: "Follower draft", message: "<p>y</p>", updated_at: (1.day + 90.minutes).ago)
    log_in(seller)

    get drafts_emails_path

    expect(response).to be_successful
    expect(inertia_props_of(response)["installments"].map { _1["recipient_description"] }).to eq(["Your followers", "Customers of Drafted product"])
  end

  it "renders the new email form with the products, sections and countries of the seller", parity: true do
    product = create(:product, user: seller, name: "Form product")
    create(:variant, variant_category: create(:variant_category, link: product), name: "Gold")
    create(:seller_profile_posts_section, seller:, header: "Updates")
    post_for(seller, "Earlier send", published_at: Time.utc(2025, 1, 5))
    log_in(seller)

    get new_email_path, headers: { "Referer" => "http://#{DOMAIN}#{scheduled_emails_path}" }

    expect(response).to be_successful
    expect(inertia_props_of(response)["context"]).to include("from_tab" => "scheduled")
  end

  it "copies an existing email into the new email form", parity: true do
    original = post_for(seller, "Template", published_at: Time.utc(2025, 1, 5), shown_on_profile: true, slug: "template")
    log_in(seller)

    get new_email_path, params: { copy_from: original.external_id }

    expect(response).to be_successful
    expect(inertia_props_of(response)["installment"]).to include("name" => "Template")
    expect(inertia_props_of(response)["installment"]).not_to have_key("external_id")
  end

  it "resolves the recipient of a single customer email from the purchase", parity: true do
    purchase = build(:purchase, link: create(:product, user: seller), seller:, email: "buyer@example.com").tap { _1.save!(validate: false) }
    log_in(seller)

    get new_email_path, params: { purchase_id: purchase.external_id }

    expect(response).to be_successful
    expect(inertia_props_of(response)["single_customer_recipient"]).to eq("purchase_id" => purchase.external_id, "email" => "buyer@example.com")
  end

  it "renders the edit form of an email", parity: true do
    email = post_for(seller, "Editable", published_at: Time.utc(2025, 1, 5))
    log_in(seller)

    get edit_email_path(email.external_id)

    expect(response).to be_successful
    expect(inertia_props_of(response)["installment"]).to include("name" => "Editable", "external_id" => email.external_id)
  end

  it "answers 404 for the edit form of an email that belongs to someone else", parity: true do
    other = post_for(create(:user), "Not yours", published_at: Time.utc(2025, 1, 5))
    log_in(seller)

    get edit_email_path(other.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "lets an accountant see the list but sends them away from the new email form", parity: true do
    member = create(:user, name: "Accounting Member")
    membership = create(:team_membership, user: member, seller:, role: TeamMembership::ROLE_ACCOUNTANT)
    post_for(seller, "Visible", published_at: Time.utc(2025, 1, 5))
    log_in(member)
    switch_to(membership)

    get new_email_path

    expect(response).to have_http_status(:found)
    expect(response.location).to include("/dashboard")
  end
end
