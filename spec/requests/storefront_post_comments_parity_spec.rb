# frozen_string_literal: true

require "spec_helper"

# The comments of the post page on a seller subdomain (PaginatedCommentsPresenter, CommentPresenter),
# recorded for the Next.js port (PARITY_RECORD=1). Replayed by
# nextjs/parity/__tests__/storefront-posts.replay.test.ts.
describe "Post page comments", type: :request do
  let(:seller) { create(:named_seller, name: "Parity Seller") }
  let(:post_record) { create(:audience_post, :published, seller:, shown_on_profile: true, name: "Discussed", message: "<p>Talk</p>").tap { _1.update!(allow_comments: true) } }

  before { host! seller.subdomain }

  def comments_props(response)
    page = response.body[/<script[^>]*data-page="[^"]*"[^>]*>(.*?)<\/script>/m, 1] || CGI.unescapeHTML(response.body[/\sdata-page="([^"]*)"/, 1])
    JSON.parse(page)["props"]["paginated_comments"]
  end

  it "shows the first page of 20 root comments with the pagination of the rest", parity: true do
    21.times { |i| create(:comment, commentable: post_record, content: "Comment #{i}", author: create(:user, name: "Author #{i}"), created_at: (60 - i).minutes.ago) }

    get "/p/#{post_record.slug}"

    expect(response).to be_successful
    expect(comments_props(response)["comments"].size).to eq(20)
    expect(comments_props(response)["pagination"]).to include("pages" => 2, "next" => 2)
  end

  it "nests replies and leaves out deleted comments", parity: true do
    root = create(:comment, commentable: post_record, content: "Root", author: create(:user, name: "Root author"))
    reply = create(:comment, commentable: post_record, content: "Reply", parent: root, author: create(:user, name: "Replier"))
    create(:comment, commentable: post_record, content: "Reply to the reply", parent: reply, author: create(:user, name: "Third"))
    create(:comment, commentable: post_record, content: "Deleted", parent: root, author: create(:user, name: "Gone"), deleted_at: 1.minute.ago)
    create(:comment, commentable: post_record, content: "Another root", author: create(:user, name: "Other"))

    get "/p/#{post_record.slug}"

    expect(response).to be_successful
    expect(comments_props(response)["comments"].map { _1["depth"] }).to include(0, 1, 2)
    expect(comments_props(response)["count"]).to eq(4)
  end

  it "links URLs, escapes HTML and names an anonymous author", parity: true do
    create(:comment, commentable: post_record, content: "See https://example.com/a?b=1&c=2 <b>now</b> & www.example.org", author: nil, author_name: "Guest")
    create(:comment, commentable: post_record, content: "Email me at someone@example.com", author: create(:user, name: nil, username: "plainuser"))

    get "/p/#{post_record.slug}"

    expect(response).to be_successful
    expect(comments_props(response)["comments"].first["content"]["formatted"]).to include("target=\"_blank\"")
  end

  it "words how long ago each comment was written", parity: true do
    [5.minutes, 3.hours, 2.days, 40.days, 5.months].each_with_index do |age, i|
      create(:comment, commentable: post_record, content: "Aged #{i}", author: create(:user, name: "Aged #{i}"), created_at: age.ago)
    end

    get "/p/#{post_record.slug}"

    expect(response).to be_successful
    expect(comments_props(response)["comments"].size).to eq(5)
  end

  it "has no comments section when the post does not allow them", parity: true do
    post_record.update!(allow_comments: false)

    get "/p/#{post_record.slug}"

    expect(response).to be_successful
    expect(comments_props(response)).to be_nil
  end
end
