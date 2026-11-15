# frozen_string_literal: true

# Produces qp-resolver.golden.json: the real premailer-rails hook, EmailCustomPropertyInlining
# (config/initializers/premailer_rails.rb), EmailCustomPropertyResolver and QuotedPrintableHtmlMail
# (config/initializers/quoted_printable_html_mail.rb) run on `Mail#deliver` with the test delivery
# method, as ActionMailer does it. Rails itself is not booted: the initializers are loaded with a
# stub `Rails.application.config` that keeps their blocks, which are then run in boot order.
#
#   bundle exec ruby nextjs/src/server/mail/__fixtures__/generate-qp-resolver-golden.rb
require "json"
require "bundler/setup"
require "active_support/all"
require "mail"
require "nokogiri"
require "premailer"
require "premailer/rails"
require "ssrf_filter"

ENV["TZ"] = "UTC"
ROOT = File.expand_path("../../../../..", __dir__)

module Rails
  CONFIG = Struct.new(:blocks) do
    def to_prepare(&block) = (blocks[:to_prepare] << block)
    def after_initialize(&block) = (blocks[:after_initialize] << block)
  end.new({ to_prepare: [], after_initialize: [] })
  def self.application = Struct.new(:config).new(CONFIG)
  def self.env = ActiveSupport::EnvironmentInquirer.new("production")
end

require File.join(ROOT, "config/initializers/mail_encodings")
require File.join(ROOT, "lib/utilities/email_stylesheet_loader")
require File.join(ROOT, "lib/utilities/email_custom_property_resolver")
require File.join(ROOT, "config/initializers/premailer_rails")
require File.join(ROOT, "config/initializers/quoted_printable_html_mail")

STYLESHEETS = {}
Rails::CONFIG.blocks[:to_prepare].each(&:call)
# The loader's own strategy reads public files and the network; the stylesheets here are fixed.
EmailStylesheetLoader.singleton_class.prepend(Module.new do
  def load(url) = unwrap_layers(STYLESHEETS.fetch(url))
end)
# premailer-rails' railtie registers its hook before any after_initialize block runs; the encoder
# registers itself in one of them and has to come after it.
Mail.register_interceptor(Premailer::Rails::Hook)
Rails::CONFIG.blocks[:after_initialize].each(&:call)
Mail.defaults { delivery_method :test }
abort "interceptor order" unless Mail.delivery_interceptors.last == QuotedPrintableHtmlMail

def deliver(html)
  mail = Mail.new
  mail.from = "Gumroad <noreply@gumroad.com>"
  mail.to = "buyer@example.com"
  mail.subject = "Golden"
  mail.content_type = "text/html; charset=UTF-8"
  mail.body = html
  Mail::TestMailer.deliveries.clear
  mail.deliver
  Mail::TestMailer.deliveries.last.encoded
end

def page(css_href, body, head: "")
  <<~HTML
    <!DOCTYPE html>
    <html>
      <head>
        <title>Golden</title>
        <meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
        <link rel="stylesheet" href="#{css_href}">
        #{head}
      </head>
      <body>#{body}</body>
    </html>
  HTML
end

LONG_URL = "https://u1234.ct.sendgrid.net/ls/click?upn=#{"u001.AbCdEf0123456789-" * 22}"

CASES = [
  # --- quoted-printable only (no var() in the stylesheet) ---------------------------------------
  ["qp_plain", "p { color: #333 }", '<p>Hello world</p>'],
  ["qp_equals_in_title_and_text", "p { color: #333 }", "<p>price=99 and =3D and =0D=0A</p>", { head: "<title>price=99</title>" }],
  ["qp_non_ascii", "p { color: #333 }", "<p>Café — ✓ 日本語のテキスト Ünïcödé</p>"],
  ["qp_long_tracked_links", "a { color: #00f }", %(<p>#{(1..6).map { |i| %(<a href="#{LONG_URL}#{i}">link #{i}</a>) }.join(" ")}</p>)],
  ["qp_trailing_whitespace", "p { color: #333 }", "<pre>trailing space \nand tab\t\nend </pre>"],
  ["qp_exact_line_lengths", "p { margin: 0 }", "<p>#{"x" * 40}</p>\n#{"y" * 72}\n#{"z" * 73}\n#{"w" * 71}é"],
  ["qp_carriage_returns", "p { margin: 0 }", "<p>one\r\ntwo\rthree</p>\r\n"],
  ["qp_entities_and_scripts", "p { margin: 0 }", "<p>a &amp; b &lt; c &nbsp; d</p><script>alert(1)</script>"],

  # --- custom properties --------------------------------------------------------------------------
  ["var_root_property", ":root { --ink: #112233; --pad: 4px } p { color: var(--ink); padding: var(--pad) }", "<p>root</p>"],
  ["var_missing_property_kept", "p { color: var(--nope); margin: var(--gone, 3px) }", "<p>missing</p>"],
  ["var_empty_fallback", "p { margin: var(--gone,) 1px; padding: var(--gone2,  ) }", "<p>empty fallback</p>"],
  ["var_nested_fallback", ":root { --a: 1px } p { margin: var(--nope, var(--a)); padding: var(--nope, calc(var(--a) + 2px)) }", "<p>nested</p>"],
  ["var_chain_and_depth", ":root { --a: var(--b); --b: var(--c); --c: 9px; --loop: var(--loop) } p { margin: var(--a); padding: var(--loop) }", "<p>chain</p>"],
  ["var_inline_own_properties", ":root { --ink: #111 } p { color: var(--ink) }", '<div style="--ink: #abc; --gap: var(--ink)"><p style="margin: var(--gap)">own</p><p>inherited</p></div>'],
  ["var_own_property_only_style", ":root { --ink: #111 } p { color: var(--ink) }", '<p style="--only: 1px">only custom</p>'],
  ["var_modern_rgb", ":root { --c: rgb(1 2 3) } p { color: var(--c); background-color: rgb(4 5 6 / 50%); border-color: rgba(7 8 9 / .25); outline-color: rgb(10, 11, 12) }", "<p>rgb</p>"],
  ["var_whitespace_forms", ":root{--a:1px;--b:  2px  } p { margin: var( --a ); padding: var(\n--b\n) }", "<p>spaces</p>"],
  ["var_semicolons_and_quotes", ":root { --q: 'a;b'; --u: url(\"x;y.png\") } p { content: var(--q); background-image: var(--u) }", "<p>quotes</p>"],
  ["var_non_ascii", ":root { --f: Ünï } p { font-family: var(--f), 'Café' }", "<p>Café — Ünï</p>"],
  ["var_in_media_rule", ":root { --w: 100% } p { color: red } @media (max-width: 600px) { p { width: var(--w) } }", "<p>media</p>"],
  ["var_in_head_style", ":root { --ink: #444 } p { color: var(--ink) }", "<p>head</p>", { head: "<style>.k { margin: var(--ink); color: var(--ink) }</style>" }],
  ["var_ids_and_comments", ":root { --ink: #444 } #main { color: var(--ink) }", "<!-- note --><div id=\"main\" class=\"x\">ids<br>and <b>bold</b></div>"],
  ["var_second_root_block_wins", ":root { --ink: red } .x { --z: 1 } :root { --ink: blue } p { color: var(--ink) }", "<p>later root</p>"],
  ["var_tracked_links_long", ":root { --link: #00f } a { color: var(--link) }", %(<p>#{(1..4).map { |i| %(<a href="#{LONG_URL}#{i}">link #{i}</a>) }.join(" ")}</p>)],
].freeze

cases = CASES.each_with_index.map do |(name, css, body, opts), index|
  href = "https://assets.gumroad.com/vite/assets/golden-#{index}.css"
  STYLESHEETS[href] = css
  rendered = page(href, body, **(opts || {}))
  { "name" => name, "css" => css, "rendered_html" => rendered, "encoded" => deliver(rendered) }
end

# The resolver on its own, without premailer's re-serialisation in front of it.
DIRECT = [
  ["direct_no_var", "<p style=\"color: red\">x</p>", ":root{--a:1}"],
  ["direct_own_and_fallback", "<html><body><div style=\"--a: 2px; margin: var(--a)\"><p style=\"padding: var(--a); margin: var(--b, 5px)\">x</p></div></body></html>", ":root{--b: 9px}"],
  ["direct_unclosed_and_bare_text", "<p style=\"margin: var(--a)\">one<p style=\"--a: 1px; margin: var(--a)\">two", ":root{--a: 3px}"],
].freeze
direct = DIRECT.map do |name, html, css|
  roots = EmailCustomPropertyResolver.root_properties(css)
  { "name" => name, "html" => html, "css" => css, "root_properties" => roots, "resolved" => EmailCustomPropertyResolver.resolve(html, roots) }
end

File.write(File.join(__dir__, "qp-resolver.golden.json"), JSON.pretty_generate({ "cases" => cases, "direct" => direct }) + "\n")
puts "wrote #{cases.size} pipeline cases and #{direct.size} direct cases"
