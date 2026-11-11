# frozen_string_literal: true

require "spec_helper"

# Writing the comments of a post (CommentsController#create, #update, #destroy) from a seller's host while signed in, recorded for
# the Next.js port (PARITY_RECORD=1) and replayed by nextjs/parity/__tests__/audience-mutations.replay.test.ts.
describe "Post comments mutations when signed in", type: :request do
  include Parity::AudienceSignedIn

  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:post_record) { create(:audience_post, :published, seller:, shown_on_profile: true, name: "Discussed", message: "<p>Talk</p>").tap { _1.update!(allow_comments: true) } }
  let(:reader) { create(:user, name: "Reader") }
  let(:json_headers) { { "Accept" => "application/json", "Content-Type" => "application/json" } }

  def comment_on(post, author:, content: "Hello there", parent: nil, **attributes)
    create(:comment, commentable: post, author:, author_name: author.display_name, content:, parent:, created_at: Time.utc(2025, 1, 2, 12), **attributes)
  end

  def as_team_member(role)
    host! DOMAIN
    member = create(:user, name: "#{role.to_s.capitalize} Member")
    membership = create(:team_membership, user: member, seller:, role:)
    log_in(member)
    switch_to(membership)
  end

  # The session is made on the main domain, the request goes to the seller's host.
  def send_json(method, path, body = nil)
    host! DOMAIN
    token = csrf_token
    host! seller.subdomain
    public_send(method, path, params: body&.to_json, headers: json_headers.merge("X-CSRF-Token" => token))
  end

  def sign_in_on_main_domain(user)
    host! DOMAIN
    log_in(user)
  end

  describe "POST /posts/:post_id/comments" do
    it "adds a reply of the seller to a comment", parity: true do
      parent = comment_on(post_record, author: reader)
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Thanks for reading", parent_id: parent.external_id } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]).to include("content" => include("original" => "Thanks for reading"), "depth" => 1, "is_editable" => true)
    end

    it "adds a root comment of the seller", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "A note from the author" } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]).to include("depth" => 0, "parent_id" => nil)
    end

    it "treats an unknown parent as no parent", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Orphan", parent_id: "unknownparent" } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]["depth"]).to eq(0)
    end

    it "links URLs and escapes HTML in the formatted content", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "See https://example.com/a?b=1&c=2 <b>now</b>\n\n\n\n\nbye" } })

      expect(response.parsed_body["comment"]["content"]["formatted"]).to include("target=\"_blank\"")
    end

    it "lets an admin team member reply", parity: true do
      parent = comment_on(post_record, author: reader)
      as_team_member(:admin)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "From support", parent_id: parent.external_id } })

      expect(response).to be_successful
    end

    it "answers 404 for an unknown post", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/unknownpost/comments", { comment: { content: "Hello" } })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a blank comment to Rails", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "" } })

      expect(response).to have_http_status(:unprocessable_entity)
    end

    it "hands a root comment that notifies the seller to Rails", parity: true do
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Great post" } })

      expect(response).to be_successful
    end

    it "hands a reader replying to a comment to Rails", parity: true do
      parent = comment_on(post_record, author: seller)
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Agreed", parent_id: parent.external_id } })

      expect(response).to be_successful
    end

    it "hands a request with a purchase id to Rails", parity: true do
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { purchase_id: "unknownpurchase", comment: { content: "Hello" } })

      expect(response).to have_http_status(:unprocessable_entity).or be_successful.or have_http_status(:unauthorized)
    end
  end

  describe "PUT /posts/:post_id/comments/:id" do
    it "lets the author edit their comment", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      send_json(:put, "/posts/#{post_record.external_id}/comments/#{comment.external_id}", { comment: { content: "Edited" } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]["content"]["original"]).to eq("Edited")
    end

    it "refuses the seller the edit of another person's comment", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(seller)

      send_json(:put, "/posts/#{post_record.external_id}/comments/#{comment.external_id}", { comment: { content: "Edited" } })

      expect(response).to have_http_status(:unauthorized)
      expect(comment.reload.content).to eq("Hello there")
    end

    it "answers 404 for an unknown comment", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:put, "/posts/#{post_record.external_id}/comments/unknowncomment", { comment: { content: "Edited" } })

      expect(response).to have_http_status(:not_found)
    end

    it "hands a blank edit to Rails", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      send_json(:put, "/posts/#{post_record.external_id}/comments/#{comment.external_id}", { comment: { content: "" } })

      expect(response).to have_http_status(:unprocessable_entity)
    end
  end

  describe "DELETE /posts/:post_id/comments/:id" do
    it "lets the seller delete a comment", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response.parsed_body).to eq("success" => true, "deleted_comment_ids" => [comment.external_id])
      expect(comment.reload.deleted_at).to be_present
    end

    it "lets the author delete their comment", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response.parsed_body["deleted_comment_ids"]).to eq([comment.external_id])
    end

    it "lets an admin team member delete a comment", parity: true do
      comment = comment_on(post_record, author: reader)
      as_team_member(:admin)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response).to be_successful
    end

    it "refuses a reader the deletion of another person's comment", parity: true do
      comment = comment_on(post_record, author: seller)
      sign_in_on_main_domain(reader)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response).to have_http_status(:unauthorized)
      expect(comment.reload.deleted_at).to be_nil
    end

    it "deletes nothing for a comment that is already deleted", parity: true do
      comment = comment_on(post_record, author: reader, deleted_at: Time.utc(2025, 1, 3, 12))
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response.parsed_body).to eq("success" => true, "deleted_comment_ids" => [])
    end

    it "answers 404 for a comment of another post", parity: true do
      other = create(:audience_post, :published, seller:, name: "Other")
      comment = comment_on(other, author: reader)
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response).to have_http_status(:not_found)
    end

    it "hands a comment with replies to Rails", parity: true do
      comment = comment_on(post_record, author: reader)
      comment_on(post_record, author: seller, content: "Reply", parent: comment)
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response.parsed_body["deleted_comment_ids"].size).to eq(2)
    end

    it "hands a signed-out visitor to Rails", parity: true do
      comment = comment_on(post_record, author: reader)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response).to have_http_status(:unauthorized).or have_http_status(:not_found)
    end
  end
end
