# frozen_string_literal: true

require "spec_helper"

# The Gumroad blog index, recorded for the Next.js port (PARITY_RECORD=1). Replayed by
# nextjs/parity/__tests__/public-pages.replay.test.ts.
describe "Gumroad blog", type: :request do
  include Parity::SignedInRequests

  let(:blog_owner) { create(:user, username: "gumroad") }

  before { host! DOMAIN }

  describe "GET /blog" do
    def blog_post(**attributes)
      create(:audience_post, :published, seller: blog_owner, shown_on_profile: true, **attributes)
    end

    it "lists the posts shown on the profile, newest first, with their image, snippet and tags", parity: true do
      blog_post(name: "Older post", published_at: 80.hours.ago, message: "<p>First paragraph</p><p>Second<br/>line &amp; more</p>")
      blog_post(
        name: "Newest post", published_at: 90.minutes.ago,
        message: %(<figure><img src="https://example.com/cover.png"></figure><p>#{"word " * 80}</p><p>#launch #product-updates #iOS #q&a #C++</p>)
      )
      blog_post(name: "Tagged post", published_at: 30.hours.ago, message: "<p>Body</p><p>#launch #launch #Design_Systems #123go</p>")
      blog_post(name: "Plain post", published_at: 50.hours.ago, message: "Just text, no markup")

      get "/blog"

      expect(response).to be_successful
      posts = inertia_props_of(response)["posts"]
      expect(posts.map { _1["subject"] }).to eq(["Newest post", "Tagged post", "Plain post", "Older post"])
    end

    it "leaves out drafts, hidden posts, deleted posts, workflow posts and other audiences", parity: true do
      blog_post(name: "Visible", published_at: 30.hours.ago)
      create(:audience_post, seller: blog_owner, shown_on_profile: true, published_at: nil, name: "Draft")
      create(:audience_post, :published, seller: blog_owner, shown_on_profile: false, name: "Hidden")
      blog_post(name: "Deleted", deleted_at: Time.current)
      create(:seller_installment, :published, seller: blog_owner, shown_on_profile: true, name: "Seller type")
      create(:audience_post, :published, seller: create(:user, username: "someoneelse"), shown_on_profile: true, name: "Someone else")

      get "/blog"

      expect(inertia_props_of(response)["posts"].map { _1["subject"] }).to eq(["Visible"])
    end

    it "renders an empty list for a blog owner without posts", parity: true do
      blog_owner

      get "/blog"

      expect(response).to be_successful
      expect(inertia_props_of(response)["posts"]).to eq([])
    end

    it "renders for a signed-in seller", parity: true do
      blog_post(name: "Visible", published_at: 30.hours.ago)
      seller = create(:user, name: "Signed In Seller")
      log_in(seller, token_path: "/blog")

      get "/blog"

      expect(response).to be_successful
      expect(inertia_props_of(response)["logged_in_user"]).to include("email" => seller.email)
    end

    it "answers an Inertia visit with the page as JSON", parity: true do
      blog_post(name: "Visible", published_at: 30.hours.ago)

      get "/blog", headers: { "X-Inertia" => "true", "X-Requested-With" => "XMLHttpRequest" }

      expect(response).to be_successful
      expect(response.parsed_body["component"]).to eq("GumroadBlog/Posts/Index")
    end

    it "is a 404 when the blog owner does not exist", parity: true do
      get "/blog"

      expect(response).to have_http_status(:not_found)
    end
  end
end
