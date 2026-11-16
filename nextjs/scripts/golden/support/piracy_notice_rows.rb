# frozen_string_literal: true

# Seed rows for the piracy notice cases of handle-resend-event-job.rb and handle-sendgrid-event-job.rb.
module PiracyNoticeRows
  SEEDED_AT = "2026-01-01 00:00:00"
  RECIPIENT = "buyer@example.com"
  URL = "https://example.org/pirated"

  def piracy_user_row(id = 1)
    { id:, email: "seller#{id}@example.com", username: "seller#{id}", external_id: (1000 + id).to_s, user_risk_state: "compliant", flags: 0, confirmed_at: SEEDED_AT, created_at: SEEDED_AT, updated_at: SEEDED_AT }
  end

  def piracy_link_row(id = 1)
    { id:, name: "Product #{id}", user_id: 1, unique_permalink: "p#{id}", price_currency_type: "usd", flags: 0, created_at: SEEDED_AT, updated_at: SEEDED_AT }
  end

  def piracy_report_row(id = 4, **overrides)
    url = overrides.fetch(:url, URL)
    digest = Digest::SHA256.hexdigest(PiracyReport.normalize_url(url) || url)
    { id:, external_id: "report#{id}".ljust(21, "x"), seller_id: 1, product_id: 1, source: "dashboard", state: "sent", url:, normalized_url_digest: digest, sent_to_email: RECIPIENT, sent_at: "2026-01-02 00:00:00", created_at: SEEDED_AT, updated_at: SEEDED_AT }.merge(overrides)
  end

  def piracy_seed(*reports, users: [piracy_user_row], links: [piracy_link_row])
    { users:, links:, piracy_reports: reports }
  end
end
