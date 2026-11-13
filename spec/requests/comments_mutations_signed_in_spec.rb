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
  def send_json(method, path, body = nil, ip: nil)
    host! DOMAIN
    token = csrf_token
    host! seller.subdomain
    headers = json_headers.merge("X-CSRF-Token" => token)
    headers["CF-Connecting-IP"] = ip if ip
    public_send(method, path, params: body&.to_json, headers:)
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

    it "answers 422 for a blank comment", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "" } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "Content can't be blank")
    end

    it "answers 422 for a comment over the length limit", parity: true do
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "a" * 10_001 } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to start_with("Content is too long")
    end

    it "answers 422 for a reply nested deeper than the limit", parity: true do
      parent = comment_on(post_record, author: reader)
      4.times { |i| parent = comment_on(post_record, author: reader, content: "Level #{i + 1}", parent:) }
      sign_in_on_main_domain(seller)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Too deep", parent_id: parent.external_id } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body["error"]).to eq("Depth must be less than or equal to 4")
    end

    it "mails the seller about a root comment by a reader", parity: true, parity_mail_jobs: true do
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Great post" } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]).to include("depth" => 0, "is_editable" => true)
    end

    it "does not mail a seller who turned comment emails off", parity: true, parity_mail_jobs: true do
      seller.update!(disable_comments_email: true)
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Great post" } })

      expect(response).to be_successful
    end

    it "adds a reader's reply to a comment without mailing the seller", parity: true, parity_mail_jobs: true do
      parent = comment_on(post_record, author: seller)
      sign_in_on_main_domain(reader)

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Agreed", parent_id: parent.external_id } })

      expect(response).to be_successful
      expect(response.parsed_body["comment"]).to include("depth" => 1)
    end

    context "when the post is not shown on the profile" do
      let(:hidden_post) { create(:audience_post, :published, seller:, shown_on_profile: false, name: "Followers only", message: "<p>Talk</p>").tap { _1.update!(allow_comments: true) } }
      let(:comment_params) { { comment: { content: "Count me in" } } }

      def comment_as_reader_on(post)
        sign_in_on_main_domain(reader)
        send_json(:post, "/posts/#{post.external_id}/comments", comment_params)
      end

      it "refuses a reader who has no tie to the seller", parity: true do
        comment_as_reader_on(hidden_post)

        expect(response).to have_http_status(:unauthorized)
        expect(hidden_post.comments.count).to eq(0)
      end

      it "lets a confirmed follower comment on it", parity: true, parity_mail_jobs: true do
        create(:active_follower, user: seller, email: reader.email)

        comment_as_reader_on(hidden_post)

        expect(response).to be_successful
        expect(response.parsed_body["comment"]).to include("depth" => 0, "is_editable" => true)
      end

      it "lets a direct affiliate comment on it", parity: true, parity_mail_jobs: true do
        create(:direct_affiliate, seller:, affiliate_user: reader)

        comment_as_reader_on(hidden_post)

        expect(response).to be_successful
        expect(hidden_post.comments.count).to eq(1)
      end

      it "lets a follower who is also a direct affiliate comment on it", parity: true, parity_mail_jobs: true do
        create(:active_follower, user: seller, email: reader.email)
        create(:direct_affiliate, seller:, affiliate_user: reader)

        comment_as_reader_on(hidden_post)

        expect(response).to be_successful
      end

      it "refuses a follower a post sent to the seller's customers", parity: true do
        create(:active_follower, user: seller, email: reader.email)
        customers_post = create(:seller_post, :published, seller:, name: "Customers only").tap { _1.update!(allow_comments: true) }

        comment_as_reader_on(customers_post)

        expect(response).to have_http_status(:unauthorized)
        expect(customers_post.comments.count).to eq(0)
      end

      it "lets a follower comment on a post sent to followers", parity: true, parity_mail_jobs: true do
        create(:active_follower, user: seller, email: reader.email)
        followers_post = create(:follower_post, :published, seller:, name: "For followers").tap { _1.update!(allow_comments: true) }

        comment_as_reader_on(followers_post)

        expect(response).to be_successful
        expect(followers_post.comments.count).to eq(1)
      end

      it "refuses an affiliate a post sent to followers", parity: true do
        create(:direct_affiliate, seller:, affiliate_user: reader)
        followers_post = create(:follower_post, :published, seller:, name: "For followers").tap { _1.update!(allow_comments: true) }

        comment_as_reader_on(followers_post)

        expect(response).to have_http_status(:unauthorized)
      end

      it "lets an affiliate comment on a post sent to affiliates", parity: true, parity_mail_jobs: true do
        create(:direct_affiliate, seller:, affiliate_user: reader)
        affiliates_post = create(:affiliate_post, :published, seller:, name: "For affiliates").tap { _1.update!(allow_comments: true) }

        comment_as_reader_on(affiliates_post)

        expect(response).to be_successful
      end

      it "refuses a follower a post sent to affiliates", parity: true do
        create(:active_follower, user: seller, email: reader.email)
        affiliates_post = create(:affiliate_post, :published, seller:, name: "For affiliates").tap { _1.update!(allow_comments: true) }

        comment_as_reader_on(affiliates_post)

        expect(response).to have_http_status(:unauthorized)
      end

      it "refuses a follower a post that belongs to a workflow", parity: true do
        create(:active_follower, user: seller, email: reader.email)
        workflow = create(:audience_workflow, seller:)
        hidden_post.update!(workflow:)

        comment_as_reader_on(hidden_post)

        expect(response).to have_http_status(:unauthorized)
      end

      it "hands a follower who has not confirmed their address to Rails", parity: true do
        create(:follower, user: seller, email: reader.email)

        comment_as_reader_on(hidden_post)

        expect(response).to have_http_status(:unauthorized)
      end

      it "hands a follower of a post with an audience filter to Rails", parity: true do
        create(:active_follower, user: seller, email: reader.email)
        followers_post = create(:follower_post, :published, seller:, name: "For recent followers").tap { _1.update!(allow_comments: true) }
        followers_post.update!(created_before: Time.utc(2030, 1, 1))

        comment_as_reader_on(followers_post)

        expect(response).to be_successful
      end

      it "hands a collaborator of the seller to Rails", parity: true do
        create(:collaborator, seller:, affiliate_user: reader)

        comment_as_reader_on(hidden_post)

        expect(response).to have_http_status(:unauthorized)
      end
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

    it "answers 422 for a blank edit", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      send_json(:put, "/posts/#{post_record.external_id}/comments/#{comment.external_id}", { comment: { content: "" } })

      expect(response).to have_http_status(:unprocessable_entity)
      expect(response.parsed_body).to eq("success" => false, "error" => "Content can't be blank")
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

    it "deletes the whole subtree of a comment and tags its replies", parity: true do
      comment = comment_on(post_record, author: reader)
      reply = comment_on(post_record, author: seller, content: "Reply", parent: comment)
      comment_on(post_record, author: reader, content: "Nested reply", parent: reply)
      comment_on(post_record, author: reader, content: "Second reply", parent: comment)
      comment_on(post_record, author: reader, content: "Gone before", parent: comment, deleted_at: Time.utc(2025, 1, 3, 12))
      unrelated = comment_on(post_record, author: reader, content: "Unrelated")
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response.parsed_body["deleted_comment_ids"].size).to eq(4)
      expect(unrelated.reload.deleted_at).to be_nil
    end

    it "deletes a reply and its replies but keeps the parent", parity: true do
      comment = comment_on(post_record, author: reader)
      reply = comment_on(post_record, author: seller, content: "Reply", parent: comment)
      comment_on(post_record, author: reader, content: "Nested reply", parent: reply)
      sign_in_on_main_domain(seller)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{reply.external_id}")

      expect(response.parsed_body["deleted_comment_ids"].size).to eq(2)
      expect(comment.reload.deleted_at).to be_nil
    end

    it "hands a signed-out visitor to Rails", parity: true do
      comment = comment_on(post_record, author: reader)

      send_json(:delete, "/posts/#{post_record.external_id}/comments/#{comment.external_id}")

      expect(response).to have_http_status(:unauthorized).or have_http_status(:not_found)
    end
  end

  # config/initializers/rack_attack.rb counts comment writes per post and address in Redis (5 a minute, then exponential backoff). Node counts in the
  # same keys, so the sixth request of the window is refused there too. A localhost address is safelisted, hence the explicit one.
  describe "throttling" do
    let(:client_ip) { "203.0.113.7" }

    before do
      Rack::Attack.cache.store.flushdb
      # The counter is keyed by the minute window: start early in one so the requests cannot straddle two.
      sleep(61 - Time.now.sec) if Time.now.sec > 45
    end

    it "refuses the sixth comment of a minute from one address with a 429", parity: true do
      sign_in_on_main_domain(seller)

      5.times do |i|
        send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Note #{i}" } }, ip: client_ip)
        expect(response).to be_successful
      end

      send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "One too many" } }, ip: client_ip)

      expect(response).to have_http_status(:too_many_requests)
      expect(response.headers["Retry-After"].to_i).to be_between(1, 60)
      expect(response.body).to eq("Retry later\n")
    end

    it "refuses the sixth edit of a minute from one address with a 429", parity: true do
      comment = comment_on(post_record, author: reader)
      sign_in_on_main_domain(reader)

      6.times do |i|
        send_json(:put, "/posts/#{post_record.external_id}/comments/#{comment.external_id}", { comment: { content: "Edit #{i}" } }, ip: client_ip)
      end

      expect(response).to have_http_status(:too_many_requests)
    end

    it "does not count a request from localhost", parity: true do
      sign_in_on_main_domain(seller)

      6.times do |i|
        send_json(:post, "/posts/#{post_record.external_id}/comments", { comment: { content: "Note #{i}" } })
        expect(response).to be_successful
      end
    end
  end
end
