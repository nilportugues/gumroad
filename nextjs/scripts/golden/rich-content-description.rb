# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/rich-content-description.golden.json: RichContent's description readers and rewriters run
# by the real model on descriptions shaped like the editor's. Nothing is written to a database.
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/rich-content-description.rb
require "json"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/rich-content-description.golden.json")
Rails.logger = ActiveSupport::Logger.new(nil)

def enc(id) = ObfuscateIds.encrypt(id)
def embed(id, uid = "u#{id}") = { "type" => "fileEmbed", "attrs" => { "id" => enc(id), "uid" => uid } }
def para(text) = { "type" => "paragraph", "content" => [{ "type" => "text", "text" => text }] }
def group(name, *children) = { "type" => "fileEmbedGroup", "attrs" => { "name" => name, "uid" => "g-#{name}" }, "content" => children }
def container(type, *children) = { "type" => type, "content" => children }
def link_text(href, type: "link") = { "type" => "paragraph", "content" => [{ "type" => "text", "text" => "go", "marks" => [{ "type" => type, "attrs" => { "href" => href } }] }] }

DESCRIPTIONS = {
  "empty" => [],
  "one paragraph" => [para("Hello")],
  "one embed" => [embed(1)],
  "embed twice" => [embed(1), para("x"), embed(1, "other")],
  "two embeds" => [embed(1), embed(2)],
  "embed without id" => [{ "type" => "fileEmbed", "attrs" => { "uid" => "a" } }],
  "embed with blank id" => [{ "type" => "fileEmbed", "attrs" => { "id" => "  ", "uid" => "a" } }],
  "embed with empty id" => [{ "type" => "fileEmbed", "attrs" => { "id" => "", "uid" => "a" } }],
  "embed with null id" => [{ "type" => "fileEmbed", "attrs" => { "id" => nil } }],
  "embed without attrs" => [{ "type" => "fileEmbed" }],
  "embed with a garbage id" => [{ "type" => "fileEmbed", "attrs" => { "id" => "not-a-ciphertext", "uid" => "a" } }],
  "embed with a ciphertext of text" => [{ "type" => "fileEmbed", "attrs" => { "id" => ObfuscateIds.encrypt("abc") } }],
  "embed with a ciphertext of zero" => [{ "type" => "fileEmbed", "attrs" => { "id" => enc(0) } }],
  "group of two" => [group("Pack", embed(1), embed(2))],
  "group of one" => [group("Solo", embed(3))],
  "empty group" => [group("Empty")],
  "group beside embed" => [embed(4), group("Pack", embed(1), embed(2)), para("tail")],
  "embed in a list" => [container("bulletList", container("listItem", embed(1)))],
  "embed in a quote" => [container("blockquote", embed(1), para("q"))],
  "embed in an ordered list with text" => [container("orderedList", container("listItem", para("one"), embed(2)), container("listItem", embed(1)))],
  "group in a list" => [container("bulletList", container("listItem", group("Deep", embed(1), embed(2))))],
  "embed inside a paragraph" => [{ "type" => "paragraph", "content" => [embed(1)] }],
  "embed inside a heading" => [{ "type" => "heading", "attrs" => { "level" => 2 }, "content" => [embed(1)] }],
  "text mentioning fileEmbed" => [container("bulletList", container("listItem", para("fileEmbed is a node type")))],
  "license key" => [{ "type" => "licenseKey" }],
  "license key in a list" => [container("bulletList", container("listItem", { "type" => "licenseKey" }))],
  "license key in a paragraph" => [{ "type" => "paragraph", "content" => [{ "type" => "licenseKey" }] }],
  "license key text" => [para("licenseKey")],
  "license key in a quote with an embed" => [container("blockquote", embed(1), { "type" => "licenseKey" })],
  "javascript link" => [link_text("javascript:alert(1)")],
  "javascript link in capitals" => [link_text("JAVASCRIPT:alert(1)")],
  "javascript link with a tab" => [link_text("java\tscript:alert(1)")],
  "javascript link with a control character" => [link_text("\u0001javascript:alert(1)")],
  "javascript link with spaces" => [link_text("  javascript:alert(1)  ")],
  "data link" => [link_text("data:text/html,<b>x</b>")],
  "vbscript, file and blob links" => [link_text("vbscript:x"), link_text("file:///etc/passwd"), link_text("blob:https://example.com/x")],
  "repeated javascript links" => [link_text("javascript:a"), link_text("javascript:b")],
  "https link" => [link_text("https://example.com/")],
  "custom scheme link" => [link_text("myapp://activate")],
  "relative link" => [link_text("/about")],
  "no scheme with a colon later" => [link_text("example.com/a:b")],
  "scheme must start with a letter" => [link_text("1javascript:x")],
  "javascript tiptap link" => [link_text("javascript:x", type: "tiptap-link")],
  "javascript button mark" => [link_text("javascript:x", type: "button")],
  "javascript on another mark type" => [link_text("javascript:x", type: "bold")],
  "javascript button node" => [{ "type" => "button", "attrs" => { "href" => "javascript:x" } }],
  "javascript image link" => [{ "type" => "image", "attrs" => { "link" => "javascript:x", "src" => "https://example.com/a.png" } }],
  "javascript image src" => [{ "type" => "image", "attrs" => { "src" => "javascript:x" } }],
  "javascript media embed" => [{ "type" => "mediaEmbed", "attrs" => { "url" => "data:text/html,x" } }],
  "javascript link node" => [{ "type" => "link", "attrs" => { "href" => "javascript:x" } }],
  "javascript deep in a list" => [container("bulletList", container("listItem", link_text("javascript:x")))],
  "javascript in a table-like unknown container" => [{ "type" => "table", "content" => [link_text("javascript:x")] }],
  "javascript and data" => [link_text("data:x"), link_text("javascript:y"), link_text("data:z")],
  "null href" => [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "x", "marks" => [{ "type" => "link", "attrs" => { "href" => nil } }] }] }],
  "numeric href" => [{ "type" => "button", "attrs" => { "href" => 5 } }],
  "marks without attrs" => [{ "type" => "paragraph", "content" => [{ "type" => "text", "text" => "x", "marks" => [{ "type" => "link" }] }] }],
}.freeze

ID_SETS = [[1], [2], [1, 2], [3], [0], [99]].freeze
HREFS = ["javascript:a", " JavaScript:a", "java\nscript:a", "\u0000\u0001data:x", "https://example.com", "data", "data :x", "mailto:a@example.com", "", "   ", ":x", "a:", "+x:y", "a+b.c-d:e"].freeze

cases = DESCRIPTIONS.map do |name, description|
  content = RichContent.new(description:)
  {
    "name" => name,
    "description" => description,
    "embeddedIds" => content.embedded_product_file_ids_in_order,
    "hasLicenseKey" => RichContent.has_license_key_in?(description),
    "blockedSchemes" => content.send(:collect_blocked_hrefs, description).uniq,
    "rejected" => ID_SETS.map { |ids| { "ids" => ids, "result" => RichContent.reject_file_embeds(description, ids) } },
  }
end

schemes = HREFS.map { |href| { "href" => href, "scheme" => RichContent.new.send(:browser_canonicalized_scheme, href) } }

File.write(OUT, "#{JSON.pretty_generate({ "cases" => cases, "schemes" => schemes })}\n")
puts "wrote #{cases.size} cases and #{schemes.size} schemes to #{OUT}"
