# frozen_string_literal: true

# Writes the SHA-256 of every help center article as HelpCenter::ArticleText reduces it to plain text, for
# src/server/page-props/help-article-text.test.ts:
#
#   RAILS_ENV=test bin/rails runner nextjs/scripts/dump-help-article-text-digests.rb
require "digest"
require "json"

digests = HelpCenter::Article.all.to_h do |article|
  [article.slug, Digest::SHA256.hexdigest(HelpCenter::ArticleText.render_plain_text(article))]
end
File.write(Rails.root.join("nextjs/src/server/page-props/__fixtures__/help-article-text-digests.json"), "#{JSON.pretty_generate(digests)}\n")
