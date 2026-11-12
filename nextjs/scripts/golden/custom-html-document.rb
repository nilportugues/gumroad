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

constants = {
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

FileUtils.mkdir_p(GOLDEN.dirname)
File.write(GOLDEN, JSON.pretty_generate("tailwind_head" => tailwind_states, "tailwind_head_without_build" => tailwind_states["no build output"], "documents" => documents) + "\n")
puts "wrote #{GENERATED} and #{GOLDEN} (#{documents.size} documents, #{tailwind_states.size} tailwind states)"
