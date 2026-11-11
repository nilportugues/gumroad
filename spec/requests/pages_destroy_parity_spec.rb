# frozen_string_literal: true

require "spec_helper"

# PagesController#destroy of a slugged page, which Node deletes: the row and the touch of the seller (with its paper_trail version).
# Recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/pages-destroy.replay.test.ts. The refusals
# of #destroy are in pages_controller_guards_parity_spec.rb.
describe "PagesController#destroy", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Pages Destroy Seller", username: "pagesdestroy", created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/pages" }
  end

  before do
    host! DOMAIN
    create(:user_page, pageable: seller, slug: "about-me", title: "About me", content: "<p>Hello</p>")
  end

  def send_delete(path)
    token = csrf_token
    delete path, headers: inertia_headers.merge("X-CSRF-Token" => token)
  end

  # Logging in updates the seller's updated_at, so it is set back afterwards: a touch in the same second as the seed would leave
  # no difference for the replay to compare.
  it "deletes the page and touches the seller", parity: true do
    log_in(seller)
    seller.update_columns(updated_at: 1.hour.ago)

    send_delete("/pages/about-me")

    expect(response).to have_http_status(:see_other)
    expect(response).to redirect_to(pages_path)
    expect(flash[:notice]).to eq("Page deleted!")
    expect(seller.pages.count).to eq(0)
  end

  it "deletes a custom HTML page", parity: true do
    create(:user_page, pageable: seller, slug: "my-landing", title: "Landing", content: nil, custom_html: "<main><h1>Landing</h1></main>")
    log_in(seller)
    seller.update_columns(updated_at: 1.hour.ago)

    send_delete("/pages/my-landing")

    expect(response).to redirect_to(pages_path)
    expect(seller.pages.pluck(:slug)).to eq(["about-me"])
  end

  it "lets a marketing member delete a page", parity: true do
    member = create(:user, name: "Marketing Member")
    membership = create(:team_membership, user: member, seller:, role: :marketing)
    seller.update_columns(updated_at: 1.hour.ago)
    log_in(member)
    switch_to(membership)

    send_delete("/pages/about-me")

    expect(response).to redirect_to(pages_path)
    expect(seller.pages.count).to eq(0)
  end
end
