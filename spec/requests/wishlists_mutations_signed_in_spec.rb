# frozen_string_literal: true

require "spec_helper"

# Creating, updating and deleting wishlists the way the Library page (Inertia) and the product page (fetch) do, recorded for the
# Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/wishlists-mutations.replay.test.ts.
describe "Wishlists mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:buyer) { create(:user, name: "Wishing Buyer") }
  let(:inertia_headers) do
    { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest", "Accept" => "text/html, application/xhtml+xml", "Content-Type" => "application/json" }
  end
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  before { host! DOMAIN }

  def send_form(method, path, body, headers)
    public_send(method, path, params: body.to_json, headers: headers.merge("X-CSRF-Token" => csrf_token))
  end

  it "creates a wishlist from the library page", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { wishlist: { name: "Birthday ideas" } }, inertia_headers)

    expect(response).to have_http_status(:see_other)
    expect(Wishlist.last).to have_attributes(name: "Birthday ideas", user_id: buyer.id)
  end

  it "creates a wishlist for the product page and answers its listing props", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { wishlist: { name: "Summer reads" } }, json_headers)

    expect(response).to have_http_status(:created)
    expect(response.parsed_body["wishlist"]["name"]).to eq("Summer reads")
  end

  it "ignores attributes that are not permitted on create", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { wishlist: { name: "Plain", description: "no", recommendable: true } }, json_headers)

    expect(response).to have_http_status(:created)
  end

  it "redirects with the validation error when the name is blank", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { wishlist: { name: "" } }, inertia_headers)

    expect(response).to have_http_status(:see_other)
  end

  it "answers the first validation error as JSON when the name is blank", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { wishlist: { name: "" } }, json_headers)

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body["error"]).to eq("Name can't be blank")
  end

  it "wraps a JSON body without a wishlist key", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { name: "Loose" }, json_headers)

    expect(response).to have_http_status(:created)
    expect(Wishlist.last.name).to eq("Loose")
  end

  it "hands a request with an empty body to Rails", parity: true do
    log_in(buyer)

    send_form(:post, wishlists_path, { other: 1 }, json_headers)

    expect(response).to have_http_status(:bad_request)
  end

  it "updates the name, the description and the Discover opt-out", parity: true do
    wishlist = create(:wishlist, user: buyer, name: "Old name")
    log_in(buyer)

    send_form(:patch, wishlist_path(wishlist.external_id), { wishlist: { name: "New name", description: "A list", discover_opted_out: true } }, inertia_headers)

    expect(response).to have_http_status(:see_other)
    expect(wishlist.reload).to have_attributes(name: "New name", description: "A list", discover_opted_out: true)
  end

  it "updates through PUT and answers no content to JSON", parity: true do
    wishlist = create(:wishlist, user: buyer, name: "Old name", discover_opted_out: true)
    log_in(buyer)

    send_form(:put, wishlist_path(wishlist.external_id), { wishlist: { name: "Kept", discover_opted_out: false } }, json_headers)

    expect(response).to have_http_status(:no_content)
    expect(wishlist.reload.discover_opted_out).to be(false)
  end

  it "marks the wishlist recommendable when it has products and a custom name", parity: true do
    wishlist = create(:wishlist, user: buyer, name: "Wishlist 1")
    create(:wishlist_product, wishlist:)
    log_in(buyer)

    send_form(:patch, wishlist_path(wishlist.external_id), { wishlist: { name: "Gardening" } }, json_headers)

    expect(wishlist.reload.recommendable).to be(true)
  end

  it "redirects with the error when the description is too long", parity: true do
    wishlist = create(:wishlist, user: buyer)
    log_in(buyer)

    send_form(:patch, wishlist_path(wishlist.external_id), { wishlist: { description: "x" * 3_001 } }, inertia_headers)

    expect(response).to have_http_status(:see_other)
  end

  it "answers 404 for a wishlist of someone else", parity: true do
    other = create(:wishlist)
    log_in(buyer)

    send_form(:patch, wishlist_path(other.external_id), { wishlist: { name: "Mine now" } }, inertia_headers)

    expect(response).to have_http_status(:not_found)
  end

  it "answers 404 for a deleted wishlist", parity: true do
    wishlist = create(:wishlist, user: buyer, deleted_at: Time.utc(2025, 1, 1))
    log_in(buyer)

    send_form(:patch, wishlist_path(wishlist.external_id), { wishlist: { name: "Back" } }, inertia_headers)

    expect(response).to have_http_status(:not_found)
  end

  it "deletes a wishlist and its followers", parity: true do
    wishlist = create(:wishlist, user: buyer)
    create(:wishlist_follower, wishlist:)
    log_in(buyer)

    send_form(:delete, wishlist_path(wishlist.external_id), {}, inertia_headers)

    expect(response).to have_http_status(:see_other)
    expect(wishlist.reload.deleted_at).to be_present
    expect(WishlistFollower.alive.count).to eq(0)
  end

  it "keeps followers that already left deleted when the wishlist is deleted", parity: true do
    wishlist = create(:wishlist, user: buyer)
    create(:wishlist_follower, wishlist:, deleted_at: Time.utc(2025, 1, 1))
    log_in(buyer)

    send_form(:delete, wishlist_path(wishlist.external_id), {}, inertia_headers)

    expect(response).to have_http_status(:see_other)
  end
end
