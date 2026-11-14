# frozen_string_literal: true

# Produces two files for the sandboxed custom HTML document that Api::Internal::AgentCustomHtmlPreviewsController stages
# (RendersCustomHtmlPages#profile_custom_html_document), run by the real concern:
#
#   nextjs/src/server/controllers/custom-html-document.generated.json   the script and style constants the document embeds, as the app
#                                                                        evaluates them (read by controllers/custom-html-document.ts)
#   nextjs/src/server/controllers/__fixtures__/custom-html-document.golden.json
#                                                                        the whole document for fixed inputs, and
#                                                                        `pages_tailwind_head` for each state of the Tailwind build output
#
#   docker exec gr-ruby-c25m bash -c 'source /tmp/env25.sh; cd /app && bundle exec rails runner nextjs/scripts/golden/custom-html-document.rb'
require "json"
require "fileutils"
require "tmpdir"

Rails.logger = ActiveSupport::Logger.new(nil)

GENERATED = Rails.root.join("nextjs/src/server/controllers/custom-html-document.generated.json")
GOLDEN = Rails.root.join("nextjs/src/server/controllers/__fixtures__/custom-html-document.golden.json")

concern = RendersCustomHtmlPages
controller = Api::Internal::AgentCustomHtmlPreviewsController
instance = controller.new

# The navigation bridge embeds the seller's hostnames and the environment's VALID_REQUEST_HOSTS; the template keeps both as placeholders so
# the port fills them from its own configuration.
HOSTNAMES_PLACEHOLDER = "@@STORE_HOSTNAMES@@"
VALID_HOSTS_PLACEHOLDER = "@@VALID_REQUEST_HOSTS@@"
navigation_bridge_template = instance.send(:custom_html_navigation_bridge_script, allowed_hostnames: [HOSTNAMES_PLACEHOLDER])
  .sub(ERB::Util.json_escape([HOSTNAMES_PLACEHOLDER].to_json), HOSTNAMES_PLACEHOLDER)
  .sub(ERB::Util.json_escape(VALID_REQUEST_HOSTS.to_json), VALID_HOSTS_PLACEHOLDER)
navigation_allowlist_js = instance.send(:custom_html_navigation_allowlist_js)
navigation_allowlist_template = navigation_allowlist_js.sub(ERB::Util.json_escape(VALID_REQUEST_HOSTS.to_json), VALID_HOSTS_PLACEHOLDER)
raise "navigation allowlist placeholder not found" unless navigation_allowlist_template.include?(VALID_HOSTS_PLACEHOLDER)
raise "navigation bridge placeholders not found" unless navigation_bridge_template.include?(HOSTNAMES_PLACEHOLDER) && navigation_bridge_template.include?(VALID_HOSTS_PLACEHOLDER)

# The trusted wrapper's scripts (UserPagesController, UsersController) take the seller's id, a nonce and the version URL; same placeholders.
SELLER_ID_PLACEHOLDER = "@@SELLER_ID@@"
NONCE_PLACEHOLDER = "@@NONCE@@"
VERSION_SRC_PLACEHOLDER = "@@VERSION_SRC@@"
wrapper_controller = UserPagesController.new
wrapper_controller.set_request!(ActionDispatch::TestRequest.create("HTTP_HOST" => DOMAIN))
follow_wrapper_template = wrapper_controller.send(:custom_html_follow_wrapper_script, seller_external_id: SELLER_ID_PLACEHOLDER, nonce: NONCE_PLACEHOLDER)
background_wrapper_template = wrapper_controller.send(:custom_html_background_wrapper_script, nonce: NONCE_PLACEHOLDER)
live_reload_template = wrapper_controller.send(:custom_html_live_reload_script, version_src: VERSION_SRC_PLACEHOLDER, nonce: NONCE_PLACEHOLDER)

constants = {
  "navigation_allowlist_template" => navigation_allowlist_template,
  "follow_wrapper_template" => follow_wrapper_template,
  "background_wrapper_template" => background_wrapper_template,
  "live_reload_template" => live_reload_template,
  "follow_bridge_script" => concern::FOLLOW_BRIDGE_SCRIPT,
  "products_bridge_script" => concern::PRODUCTS_BRIDGE_SCRIPT,
  "navigation_bridge_template" => navigation_bridge_template,
  "sandbox_compat_script" => concern::SANDBOX_COMPAT_SCRIPT,
  "background_bridge_script" => concern::BACKGROUND_BRIDGE_SCRIPT,
  "preview_scroll_to_change_script" => concern::PREVIEW_SCROLL_TO_CHANGE_SCRIPT,
  "profile_fields_preview_script" => concern::PROFILE_FIELDS_PREVIEW_SCRIPT,
  "tailwind_v3_gradient_compat_style" => concern::TAILWIND_V3_GRADIENT_COMPAT_STYLE,
  "tailwind_v3_cdn_host_pattern" => concern::TAILWIND_V3_CDN_HOST_PATTERN.source,
  "tailwind_v3_cdn_host_pattern_options" => concern::TAILWIND_V3_CDN_HOST_PATTERN.options,
  "custom_html_csp" => concern::CUSTOM_HTML_CSP,
  "preview_changed_marker_text" => concern::PREVIEW_CHANGED_MARKER_TEXT,
}
File.write(GENERATED, JSON.pretty_generate(constants) + "\n")

# pages_tailwind_head reads public/ and memoizes per process: each state below builds its own tree and clears the memo.
def tailwind_head(controller)
  controller.instance_variable_set(:@pages_tailwind_head, nil)
  controller.pages_tailwind_head
rescue StandardError => e
  { "error" => e.class.name } # a manifest that parses to a list raises TypeError, which the Node port refuses
end

public_dir = Rails.root.join("public")
manifest = public_dir.join("pages-tailwind-manifest.json")
inline_css = public_dir.join("pages-tailwind.css")
asset = public_dir.join("assets/pages/pages-tailwind-0123abcd.css")
[manifest, inline_css, asset].each { |path| raise "#{path} exists; this generator creates it" if path.exist? }

tailwind_states = {}
begin
  tailwind_states["no build output"] = tailwind_head(controller)

  File.write(inline_css, "body{margin:0}\n")
  tailwind_states["only the inline stylesheet"] = tailwind_head(controller)

  File.write(manifest, "{ not json")
  tailwind_states["a manifest that is not JSON"] = tailwind_head(controller)

  File.write(manifest, JSON.generate("pages-tailwind.css" => "assets/pages/pages-tailwind-0123abcd.css"))
  tailwind_states["a manifest whose asset is missing"] = tailwind_head(controller)

  FileUtils.mkdir_p(asset.dirname)
  File.write(asset, "x")
  tailwind_states["a manifest and its asset"] = tailwind_head(controller)

  File.write(manifest, JSON.generate("pages-tailwind.css" => "assets/other/pages-tailwind-0123abcd.css"))
  tailwind_states["a manifest path outside the build directory"] = tailwind_head(controller)

  File.write(manifest, JSON.generate("pages-tailwind.css" => 5))
  tailwind_states["a manifest path that is not text"] = tailwind_head(controller)

  File.write(manifest, JSON.generate("other.css" => "assets/pages/pages-tailwind-0123abcd.css"))
  tailwind_states["a manifest without the entry"] = tailwind_head(controller)

  File.write(manifest, "[]")
  tailwind_states["a manifest that is a list"] = tailwind_head(controller)
ensure
  [manifest, inline_css, asset].each { |path| FileUtils.rm_f(path) }
  FileUtils.rm_rf(public_dir.join("assets/pages"))
  Dir.rmdir(public_dir.join("assets")) if public_dir.join("assets").exist? && Dir.empty?(public_dir.join("assets"))
  controller.instance_variable_set(:@pages_tailwind_head, nil)
end

NAVIGATION_BRIDGE_HOSTNAME_LISTS = [[], ["seller.test.gumroad.com"], ["shop.example.com", "seller.test.gumroad.com"], ["a\"b.example.com", "café.example.com", "x<y>&z.example.net"]].freeze
navigation_bridges = NAVIGATION_BRIDGE_HOSTNAME_LISTS.map do |hostnames|
  { "allowed_hostnames" => hostnames, "script" => instance.send(:custom_html_navigation_bridge_script, allowed_hostnames: hostnames) }
end
NAVIGATION_BRIDGE_SAMPLE = navigation_bridges[2]["script"]

DOCUMENT_CASES = [
  { name: "a page with the empty payload", custom_html: "<h1>Hello</h1>", data_json: "{}" },
  { name: "a page with a payload and prices", custom_html: "<p data-gumroad-field=\"name\">x</p>", data_json: '{"products":[],"posts":[],"pages":[{"name":"Home"}],"products_total":0,"posts_total":0}', prices_json: '{"a":{"price":"$1"}}' },
  { name: "a page marked for scrolling", custom_html: "<p>a</p><!--gumroad-preview-changed--><p>b</p>", data_json: "{}", scroll_to_change: true },
  { name: "a page that loads tailwind v3", custom_html: "<script src=\"https://cdn.tailwindcss.com\"></script><div class=\"bg-gradient-to-r from-red-500\">x</div>", data_json: "{}" },
  { name: "a page that loads tailwind v3 from a host in capitals", custom_html: "<script src=\"https://CDN.Tailwindcss.com\"></script>", data_json: "{}" },
  { name: "a page that only names the tailwind host in text", custom_html: "<p>see cdn.tailwindcss.com</p>", data_json: "{}" },
  { name: "a page with multibyte text", custom_html: "<p>Café ☃ \u{1F600} 日本語</p>", data_json: "{}" },
  { name: "a page with a blank payload", custom_html: "<p>x</p>", data_json: "" },
  { name: "a page with an empty prices payload", custom_html: "<p>x</p>", data_json: "{}", prices_json: "" },
  { name: "a page with live fields", custom_html: "<p data-gumroad-field=\"name\">x</p>", data_json: "{}", live_fields: true },
  { name: "a page with every bridge", custom_html: "<a href=\"/x\">x</a>", data_json: "{}", navigation_bridge: NAVIGATION_BRIDGE_SAMPLE, follow_bridge: RendersCustomHtmlPages::FOLLOW_BRIDGE_SCRIPT, products_bridge: RendersCustomHtmlPages::PRODUCTS_BRIDGE_SCRIPT },
  { name: "a page with every bridge, prices and live fields", custom_html: "<p>x</p>", data_json: "{}", prices_json: '{"a":{"price":"$1"}}', live_fields: true, navigation_bridge: NAVIGATION_BRIDGE_SAMPLE, follow_bridge: RendersCustomHtmlPages::FOLLOW_BRIDGE_SCRIPT, products_bridge: RendersCustomHtmlPages::PRODUCTS_BRIDGE_SCRIPT },
].freeze

documents = DOCUMENT_CASES.map do |entry|
  arguments = entry.except(:name, :custom_html)
  {
    "name" => entry[:name],
    "custom_html" => entry[:custom_html],
    "arguments" => arguments.transform_keys(&:to_s),
    # The tailwind head of this environment (no build output) is part of every document.
    "document" => instance.send(:profile_custom_html_document, entry[:custom_html], **arguments),
  }
end

WRAPPER_CASES = [
  { seller_external_id: "abc123==", nonce: "Zm9vYmFy+/=", version_src: "/studio/landing/version" },
  { seller_external_id: "a\"b</script>&c", nonce: "x\"y<&>'", version_src: "/a b/landing/version?x=1&y=<2>" },
].freeze
wrapper_scripts = WRAPPER_CASES.map do |entry|
  {
    "arguments" => entry.transform_keys(&:to_s),
    "follow" => wrapper_controller.send(:custom_html_follow_wrapper_script, seller_external_id: entry[:seller_external_id], nonce: entry[:nonce]),
    "background" => wrapper_controller.send(:custom_html_background_wrapper_script, nonce: entry[:nonce]),
    "live_reload" => wrapper_controller.send(:custom_html_live_reload_script, version_src: entry[:version_src], nonce: entry[:nonce]),
  }
end

TitlePage = Struct.new(:title, :seo_title, :content)
page_cases = [
  { title: "About", seo_title: nil, content: "<p>Hello</p>", seller_name: "Jane Doe", profile_href: "/", head_extra: "" },
  { title: "About | Jane Doe", seo_title: nil, content: "<p>Hello</p>", seller_name: "Jane Doe", profile_href: "https://jane.test.gumroad.com", head_extra: "<link rel=\"canonical\" href=\"x\">" },
  { title: "  ", seo_title: nil, content: "", seller_name: "Jane Doe", profile_href: "/", head_extra: "" },
  { title: "Notes <b>&", seo_title: "SEO \"title\" & more", content: "<p>x</p>", seller_name: "J & <D>", profile_href: "/a?b=1&c=2", head_extra: "" },
  { title: "Straße", seo_title: "", seller_name: "STRASSE", content: "<p>Ünï</p>", profile_href: "/", head_extra: "" },
  { title: nil, seo_title: nil, content: nil, seller_name: nil, profile_href: "/", head_extra: "" },
  { title: "Shop", seo_title: nil, content: "<p>x</p>", seller_name: "  ", profile_href: "/", head_extra: "" },
  { title: "Shop — Jane", seo_title: nil, content: "<p>x</p>", seller_name: " JANE ", profile_href: "/", head_extra: "" },
  { title: "École", seo_title: nil, content: "<p>x</p>", seller_name: "éCOLE", profile_href: "/", head_extra: "" },
].freeze
rich_text_documents = page_cases.map do |entry|
  page = TitlePage.new(entry[:title], entry[:seo_title], entry[:content])
  {
    "arguments" => entry.transform_keys(&:to_s),
    "document_title" => Pages::DocumentTitle.for(page_title: entry[:title], seller_name: entry[:seller_name], seo_title: entry[:seo_title]),
    "document" => Pages::RichTextDocument.render(page:, seller_name: entry[:seller_name], profile_href: entry[:profile_href], head_extra: entry[:head_extra]).to_str,
  }
end

safe_css_colors = ["#fff", "#FFFFFF", "#12345", "#abcdefg", "", "#ffffff\nbody{}", "red", "#abc\n", nil, "rgb(0,0,0)", "#ABC", "#a1b2c3"].map do |value|
  { "value" => value, "safe" => HexColorValidator.safe_for_css?(value) }
end

FileUtils.mkdir_p(GOLDEN.dirname)
File.write(GOLDEN, JSON.pretty_generate("tailwind_head" => tailwind_states, "tailwind_head_without_build" => tailwind_states["no build output"], "navigation_allowlist" => navigation_allowlist_js, "navigation_bridges" => navigation_bridges, "wrapper_scripts" => wrapper_scripts, "rich_text_documents" => rich_text_documents, "safe_css_colors" => safe_css_colors, "documents" => documents) + "\n")
puts "wrote #{GENERATED} and #{GOLDEN} (#{documents.size} documents, #{tailwind_states.size} tailwind states)"
