# frozen_string_literal: true

require "spec_helper"

# Api::Internal::Installments::RemainingSendsController#create for every state of the latest blast that Node decides without looking at
# Sidekiq, recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/internal-api.replay.test.ts, which sends
# the last request of each example. An example named "hands a ..." records what Node passes to Rails whole: it would claim the resume
# marker and scan Sidekiq.
describe "Internal API remaining send", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:user, name: "Remaining Seller") }
  let(:installment) { create(:installment, seller:, link: nil, installment_type: "seller", name: "Sent post", message: "<p>Body</p>", published_at: Time.utc(2025, 1, 1), send_emails: true) }

  before do
    host! DOMAIN
    log_in(seller)
  end

  def remaining_send(post = installment)
    post "/internal/installments/#{post.external_id}/remaining_send",
         params: {}.to_json,
         headers: { "Accept" => "application/json", "X-CSRF-Token" => csrf_token, "Content-Type" => "application/json" }
  end

  def blast_of(post = installment, **attributes)
    create(:post_email_blast, post:, seller: post.seller, requested_at: 3.days.ago, started_at: nil, first_email_delivered_at: nil, last_email_delivered_at: nil, delivery_count: 0, **attributes)
  end

  def refuses(message)
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body).to eq("success" => false, "error" => message)
  end

  it "starts a new blast for a send that expired before reaching anyone", parity: true do
    blast_of(expired_at: 2.days.ago, expiry_reason: PostEmailBlast::EXPIRY_QUOTA)

    remaining_send

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("success" => true)
    expect(installment.blasts.count).to eq(2)
    expect(SendPostBlastEmailsJob.jobs.size).to eq(1)
  end

  it "starts a new blast for an abandoned send", parity: true do
    blast_of(expired_at: 2.days.ago, expiry_reason: PostEmailBlast::EXPIRY_ABANDONED)

    remaining_send

    expect(response).to have_http_status(:ok)
    expect(SendPostBlastEmailsJob.jobs.size).to eq(1)
  end

  it "judges the latest blast and leaves older ones alone", parity: true do
    blast_of(requested_at: 20.days.ago, completed_at: 19.days.ago, delivery_count: 3)
    blast_of(expired_at: 2.days.ago, expiry_reason: PostEmailBlast::EXPIRY_QUOTA)

    remaining_send

    expect(response).to have_http_status(:ok)
    expect(installment.blasts.count).to eq(3)
  end

  it "ignores a resend to non-openers when it picks the blast", parity: true do
    blast_of(expired_at: 5.days.ago, expiry_reason: PostEmailBlast::EXPIRY_QUOTA, requested_at: 6.days.ago)
    blast_of(recipient_filter: "unopened", requested_at: 1.day.ago, completed_at: 1.hour.ago, delivery_count: 5)

    remaining_send

    expect(response).to have_http_status(:ok)
  end

  it "refuses a send that finished", parity: true do
    blast_of(completed_at: 2.days.ago, delivery_count: 5)

    remaining_send

    refuses("This email is not waiting on any recipients.")
  end

  it "refuses a send that has nobody left to email", parity: true do
    blast = blast_of
    $redis.set(RedisKey.blast_pending_recipients(blast.id), "0")

    remaining_send

    refuses("This email is not waiting on any recipients.")
  end

  it "refuses a send that was stopped when the newsletter retired", parity: true do
    blast_of(expired_at: 2.days.ago, expiry_reason: PostEmailBlast::EXPIRY_NEWSLETTER_RETIRED)

    remaining_send

    refuses("This email is not waiting on any recipients.")
  end

  it "refuses a send that is still emailing", parity: true do
    blast_of(requested_at: 10.minutes.ago, last_email_delivered_at: 1.minute.ago)

    remaining_send

    refuses("This email is not waiting on any recipients.")
  end

  it "refuses a send that waits for the seller's quota", parity: true do
    blast = blast_of
    $redis.set(RedisKey.blast_quota_deferred_until(blast.id), 10.years.from_now.iso8601)

    remaining_send

    refuses("This email is not waiting on any recipients.")
  end

  it "refuses a stalled send that is about to be retried automatically", parity: true do
    Feature.activate(:auto_resume_stalled_post_blasts)
    blast_of(requested_at: 3.hours.ago)

    remaining_send

    refuses("We are retrying this automatically.")
  end

  it "refuses a stalled send whose resume marker is taken", parity: true do
    blast = blast_of
    $redis.set(RedisKey.stalled_blast_auto_resumed(blast.id), "seller:1", ex: 3600)

    remaining_send

    refuses("A send was started recently. Check back in a few hours.")
  end

  it "hands a stalled send that nobody holds to Rails", parity: true do
    blast_of

    remaining_send

    expect(response).to have_http_status(:ok)
    expect(SendPostBlastEmailsJob.jobs.size).to eq(1)
  end
end
