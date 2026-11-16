# frozen_string_literal: true

require "spec_helper"

# Archiving, unarchiving and removing a purchase from the library the way the Inertia page does (JSON body, X-Inertia, the CSRF token in a
# header), recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/content-delivery-mutations.replay.test.ts,
# which sends the last request of each example.
describe "Library mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:buyer) { create(:user, name: "Library Buyer") }
  let(:seller) { create(:user, name: "Library Seller") }
  let(:product) { create(:product, user: seller, name: "Library product", unique_permalink: "libmut") }
  let!(:purchase) { create(:free_purchase, link: product, purchaser: buyer, email: buyer.email, created_at: Time.utc(2025, 1, 1)) }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json", "Referer" => "http://#{DOMAIN}/library" }
  end

  before { host! DOMAIN }

  def send_patch(path)
    token = csrf_token
    patch path, params: {}.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token)
  end

  it "archives a purchase", parity: true do
    log_in(buyer)

    send_patch library_archive_path(purchase.external_id)

    expect(response).to redirect_to(library_path)
    expect(flash[:notice]).to eq("Product archived!")
    expect(purchase.reload.is_archived).to be(true)
  end

  it "unarchives a purchase", parity: true do
    purchase.update!(is_archived: true)
    log_in(buyer)

    send_patch library_unarchive_path(purchase.external_id)

    expect(response).to redirect_to(library_path)
    expect(flash[:notice]).to eq("Product unarchived!")
    expect(purchase.reload.is_archived).to be(false)
  end

  it "removes a purchase from the library", parity: true do
    log_in(buyer)

    send_patch library_delete_path(purchase.external_id)

    expect(response).to redirect_to(library_path)
    expect(flash[:notice]).to eq("Removed from your library!")
    expect(purchase.reload.is_deleted_by_buyer).to be(true)
  end

  it "answers 404 for another buyer's purchase", parity: true do
    log_in(create(:user, name: "Someone else"))

    send_patch library_archive_path(purchase.external_id)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for an unknown purchase", parity: true do
    log_in(buyer)

    send_patch library_archive_path("nope")

    expect(response).to have_http_status(:not_found)
  end

  it "redirects a signed-out request to the login page", parity: true do
    token = csrf_token

    patch library_archive_path(purchase.external_id), params: {}.to_json, headers: inertia_headers.merge("X-CSRF-Token" => token)

    expect(response).to have_http_status(:see_other)
  end
end
