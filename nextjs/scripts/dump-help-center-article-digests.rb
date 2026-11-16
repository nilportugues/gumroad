# frozen_string_literal: true

# Writes the SHA-256 of every help center article as Rails renders it, for
# src/server/page-props/help-center-erb.test.ts:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-help-center-article-digests.rb
require "digest"
require "json"

controller = HelpCenter::ArticlesController.new
controller.request = ActionDispatch::TestRequest.create("HTTP_HOST" => "app.test.gumroad.com:31337")
controller.response = ActionDispatch::TestResponse.new
presenter = HelpCenterPresenter.new(view_context: controller.view_context)

digests = HelpCenter::Article.all.to_h do |article|
  [article.slug, Digest::SHA256.hexdigest(presenter.article_props(article)[:article][:content])]
end
File.write(Rails.root.join("nextjs/src/server/page-props/__fixtures__/help-center-article-digests.json"), "#{JSON.pretty_generate(digests)}\n")
