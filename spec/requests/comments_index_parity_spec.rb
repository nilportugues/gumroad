# frozen_string_literal: true

require "spec_helper"

# Reading the comments of a post (CommentsController#index, PaginatedCommentsPresenter) from a seller's host, signed out and signed
# in, recorded for the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts.
describe "Post comments index", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:post_record) { create(:audience_post, :published, seller:, shown_on_profile: true, name: "Discussed", message: "<p>Talk</p>").tap { _1.update!(allow_comments: true) } }
  let(:reader) { create(:user, name: "Reader") }
  let(:json_headers) { { "Accept" => "application/json" } }

  def comment_on(post, author:, content: "Hello there", parent: nil, **attributes)
    create(:comment, commentable: post, author:, author_name: author&.display_name, content:, parent:, created_at: Time.utc(2025, 1, 2, 12), **attributes)
  end

  def read_comments(post = post_record, query = "")
    host! seller.subdomain
    get "/posts/#{post.external_id}/comments#{query}", headers: json_headers
  end

  def sign_in_on_main_domain(user)
    host! DOMAIN
    log_in(user)
  end

  describe "signed out" do
    it "lists the root comments with their replies and the count", parity: true do
      root = comment_on(post_record, author: reader, content: "First")
      reply = comment_on(post_record, author: create(:user, name: "Replier"), content: "Reply", parent: root)
      comment_on(post_record, author: create(:user, name: "Third"), content: "Reply to the reply", parent: reply)
      comment_on(post_record, author: create(:user, name: "Gone"), content: "Deleted", parent: root, deleted_at: 1.minute.ago)
      comment_on(post_record, author: nil, content: "See https://example.com/a?b=1&c=2 <b>now</b>", author_name: "Guest")

      read_comments

      expect(response).to be_successful
      expect(response.parsed_body["comments"].map { _1["depth"] }).to include(0, 1, 2)
      expect(response.parsed_body["count"]).to eq(4)
    end

    it "pages 20 root comments at a time", parity: true do
      21.times { |i| comment_on(post_record, author: create(:user, name: "Author #{i}"), content: "Comment #{i}", created_at: (60 - i).minutes.ago) }

      read_comments(post_record, "?page=2")

      expect(response).to be_successful
      expect(response.parsed_body["comments"].size).to eq(1)
      expect(response.parsed_body["pagination"]).to include("page" => 2, "pages" => 2, "prev" => 1, "next" => nil)
    end

    it "reads a page below 1 or that is not a number as the first", parity: true do
      comment_on(post_record, author: reader)

      read_comments(post_record, "?page=0")

      expect(response).to be_successful
      expect(response.parsed_body["pagination"]).to include("page" => 1)
    end

    it "lists no comments of a post without any", parity: true do
      read_comments

      expect(response).to be_successful
      expect(response.parsed_body).to include("comments" => [], "count" => 0)
    end

    it "lists the comments of a post that does not allow them", parity: true do
      comment_on(post_record, author: reader)
      post_record.update!(allow_comments: false)

      read_comments

      expect(response).to be_successful
      expect(response.parsed_body["count"]).to eq(1)
    end

    it "answers 404 for an unknown post", parity: true do
      host! seller.subdomain
      get "/posts/unknown/comments", headers: json_headers

      expect(response).to have_http_status(:not_found)
    end

    it "answers 404 for a post that is not published", parity: true do
      draft = create(:audience_post, seller:, shown_on_profile: true)

      read_comments(draft)

      expect(response).to have_http_status(:not_found)
    end

    it "refuses a post that is not shown on the profile", parity: true do
      hidden = create(:audience_post, :published, seller:, shown_on_profile: false).tap { _1.update!(allow_comments: true) }

      read_comments(hidden)

      expect(response).to have_http_status(:unauthorized)
    end

    it "refuses a post sent to the seller's customers", parity: true do
      customers_post = create(:seller_post, :published, seller:, shown_on_profile: true).tap { _1.update!(allow_comments: true) }

      read_comments(customers_post)

      expect(response).to have_http_status(:unauthorized)
    end
  end

  describe "signed in" do
    it "marks the comments of the post's seller editable and deletable for them", parity: true do
      comment_on(post_record, author: reader, content: "By a reader")
      comment_on(post_record, author: seller, content: "By the seller")
      sign_in_on_main_domain(seller)

      read_comments

      expect(response).to be_successful
      expect(response.parsed_body["comments"].map { _1["is_deletable"] }).to all(be(true))
    end

    it "marks only the comments of a reader as theirs", parity: true do
      comment_on(post_record, author: reader, content: "Mine")
      comment_on(post_record, author: create(:user, name: "Someone"), content: "Theirs")
      sign_in_on_main_domain(reader)

      read_comments

      expect(response).to be_successful
      expect(response.parsed_body["comments"].map { _1["is_editable"] }).to eq([true, false])
    end

    it "lets a support member of the seller read the comments", parity: true do
      comment_on(post_record, author: reader)
      member = create(:user, name: "Support Member")
      membership = create(:team_membership, user: member, seller:, role: :support)
      sign_in_on_main_domain(member)
      switch_to(membership)

      read_comments

      expect(response).to be_successful
    end

    it "refuses a reader with no tie to the seller a post sent to the seller's customers", parity: true do
      customers_post = create(:seller_post, :published, seller:, shown_on_profile: true).tap { _1.update!(allow_comments: true) }
      sign_in_on_main_domain(reader)

      read_comments(customers_post)

      expect(response).to have_http_status(:unauthorized)
    end

    it "hands a follower of the seller to Rails", parity: true do
      follower_post = create(:follower_post, :published, seller:, shown_on_profile: false).tap { _1.update!(allow_comments: true) }
      create(:active_follower, user: seller, email: reader.email)
      sign_in_on_main_domain(reader)

      read_comments(follower_post)

      expect(response).to be_successful
    end

    it "hands a reader who bought the post's product to Rails", parity: true do
      product = create(:product, user: seller)
      product_post = create(:product_post, :published, seller:, link: product, shown_on_profile: true).tap { _1.update!(allow_comments: true) }
      purchase = build(:purchase, link: product, purchaser: reader, email: reader.email, purchase_state: "successful")
      purchase.save!(validate: false)
      sign_in_on_main_domain(reader)

      read_comments(product_post)

      expect(response).to be_successful
    end

    it "reads a purchase_id that names no purchase as none", parity: true do
      comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      read_comments(post_record, "?purchase_id=unknown")

      expect(response).to be_successful
    end

    it "hands a request whose purchase_id names a purchase to Rails", parity: true do
      product = create(:product, user: seller)
      purchase = build(:purchase, link: product, email: "buyer@example.com", purchase_state: "successful")
      purchase.save!(validate: false)
      comment_on(post_record, author: reader)

      read_comments(post_record, "?purchase_id=#{purchase.external_id}")

      expect(response).to be_successful
    end
  end
end
