# frozen_string_literal: true

# Records html.golden.json: the gems' own output (Nokogiri 1.19 / libxml2 2.13.9, Loofah 2.25,
# rails-html-sanitizer 1.6, Rinku 2.0, ActionView 8.1) on seeded random markup, for the Node ports
# in this directory to replay. Nothing here re-implements Ruby behaviour.
#
#   bundle exec ruby nextjs/src/server/html/__fixtures__/generate-html-golden.rb [seed] [count] [out]
#
# The defaults write the committed golden. A larger count and another output path is how the ports
# are fuzzed beyond it (see fuzz-html.ts).
require "json"
require "set"
require "nokogiri"
require "loofah"
require "rails-html-sanitizer"
require "rinku"
require "active_support"
require "active_support/core_ext"
require "action_view"
require "action_view/helpers"

SEED = Integer(ARGV[0] || 4040)
COUNT = Integer(ARGV[1] || 200)
OUT = ARGV[2] || File.join(__dir__, "html.golden.json")

# The sanitizer configuration config/application.rb sets, read from the file so the two cannot drift.
APPLICATION_RB = File.read(File.expand_path("../../../../../config/application.rb", __dir__))
def config_list(name) = JSON.parse(APPLICATION_RB[/config\.action_view\.#{name} = (\[.*\])/, 1])
abort "config/application.rb no longer pins Rails::HTML4::Sanitizer" unless APPLICATION_RB.include?("config.action_view.sanitizer_vendor = Rails::HTML4::Sanitizer")
ActionView::Helpers::SanitizeHelper.sanitizer_vendor = Rails::HTML4::Sanitizer
Rails::HTML4::SafeListSanitizer.allowed_tags = Set.new(config_list("sanitized_allowed_tags"))
Rails::HTML4::SafeListSanitizer.allowed_attributes = Set.new(config_list("sanitized_allowed_attributes"))

class Helpers
  include ActionView::Helpers::TextHelper
  include ActionView::Helpers::SanitizeHelper
  include ActionView::Helpers::TagHelper
end
H = Helpers.new

# The calls the mailers make, by name.
RECAP_TAGS = %w[ul ol li strong b em a].freeze
RECAP_ATTRIBUTES = %w[href target rel].freeze
COMMENT_LINK_ATTRS = %(target="_blank" rel="noopener noreferrer nofollow")
RECAP_LINK_ATTRS = 'target="_blank" rel="nofollow"'

# Canonical dump of a parsed tree, compared node for node by the Node test.
def dump(node)
  case node.type
  when Nokogiri::XML::Node::ELEMENT_NODE
    ["e", node.name, node.attribute_nodes.map { |a| [a.name, a.children.empty? ? nil : a.value] }, node.children.map { dump(_1) }]
  when Nokogiri::XML::Node::TEXT_NODE then ["t", node.content]
  when Nokogiri::XML::Node::CDATA_SECTION_NODE then ["c", node.content]
  when Nokogiri::XML::Node::COMMENT_NODE then ["!", node.content]
  when Nokogiri::XML::Node::PI_NODE then ["?", node.name, node.content]
  else raise "unexpected node type #{node.type}"
  end
end

def dump_document(doc)
  dtd = doc.internal_subset
  {
    "dtd" => dtd && [dtd.name, dtd.external_id, dtd.system_id],
    "children" => doc.children.reject { _1.type == Nokogiri::XML::Node::DTD_NODE }.map { dump(_1) },
  }
end

# --- seeded random markup ---------------------------------------------------------------------------
R = Random.new(SEED)
def pick(list) = list[R.rand(list.size)]
def chance(p) = R.rand < p

TAGS = %w[
  html head body title meta link style script p div span a b i u em strong br hr img ul ol li dl dt dd table thead tbody tfoot tr td th
  caption col colgroup h1 h2 h3 h4 h5 h6 pre code blockquote form input select option optgroup textarea label button center font
  small big tt s strike sub sup address noscript noframes frame frameset iframe object param embed area map base basefont abbr acronym
  q cite dfn kbd samp var bdo del ins fieldset legend menu dir isindex applet xmp listing nobr wbr article section foo x-y my:tag
].freeze
ATTRS = %w[href src class id style title name alt target rel checked disabled selected nowrap action onclick data-x xml:lang lang width height cellpadding].freeze
WORDS = ["hello", "world", "Tom & Jerry", "a<b", "x > y", "café", "naïve", "日本語", "😀", "  ", "\n", "\t", "\r\n", "\r", " ", " ", " ", "￾", "\u0001", "\u007F",
         "end.", "(paren)", "\"quoted\"", "'single'", "100%", "a=b", "x;y", "--", "->", "]]>", "​", "　"].freeze
ENTITIES = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;", "&copy;", "&eacute;", "&hellip;", "&euro;", "&foo;", "&amp", "&copy", "&", "& ", "&#65;", "&#x41;", "&#X263A;",
            "&#0;", "&#1;", "&#128;", "&#xD800;", "&#x110000;", "&#9999999999;", "&#;", "&#x;", "&#65", "&#xZZ;", "&AMP;", "&Eacute;", "&thetasym;", "&{x}", "&é;", "&a.b;", "&_:-;", "&\u00a0;", "&x\u00b7y;", "&\u0101\u0300;", "&\u4e00;", "&\u0660;", "&a\u0660;"].freeze
URLS = ["http://example.com", "https://example.com/path?q=1&r=2", "www.example.com", "WWW.Example.COM/x", "ftp://files.example.org/a.txt", "mailto:a@example.com",
        "user@example.com", "first.last+tag@sub.example.co.uk", "http://example.com/Pikachu_(Electric)", "(http://example.com/x)", "http://example.com/a.", "http://example.com/a,",
        "http://x", "http://localhost:3000/", "https://例え.jp/パス", "http://example.com/\"q\"", "javascript:alert(1)", "https://a.b/c;d", "https://a.b/&amp;", "https://a.b/&#39;",
        "@example.com", "a@b", "a@b.", "a@b.c", "http://_bad.example.com", "http://ex_ample.com", "https://example.com/【x】", "www.example.com」", "ｗｗｗ.example.com", "http://example.com/?a=<b>"].freeze

def text_piece
  case R.rand(10)
  when 0..4 then pick(WORDS)
  when 5..6 then pick(ENTITIES)
  when 7 then pick(URLS)
  when 8 then (+"") << R.rand(0x20..0x7e)
  else [R.rand(0x80..0x2fff)].pack("U")
  end
end

def attr_piece
  name = chance(0.9) ? pick(ATTRS) : pick(["", "=", "a b", "a\"b", "1x", "_x", ":x", ".x", "X-UP", "a" * 120])
  return " #{name}" if chance(0.2)
  value = Array.new(R.rand(0..3)) { chance(0.7) ? pick(WORDS + URLS) : pick(ENTITIES) }.join
  sep = pick(["=", " = ", "=\n"])
  case R.rand(6)
  when 0 then " #{name}#{sep}#{value.gsub(/[\s>"'=<`]/, "")}"
  when 1 then " #{name}#{sep}'#{value.delete("'")}'"
  when 2 then " #{name}#{sep}\"#{value}" # unterminated
  else " #{name}#{sep}\"#{value.delete('"')}\""
  end
end

def start_tag
  tag = pick(TAGS)
  tag = tag.upcase if chance(0.1)
  attrs = Array.new(R.rand(0..3)) { attr_piece }.join
  close = pick([">", ">", ">", " />", "/>", "", " >", "\n>"])
  "<#{tag}#{attrs}#{close}"
end

def end_tag
  tag = pick(TAGS)
  pick(["</#{tag}>", "</#{tag}>", "</#{tag} >", "</#{tag.upcase}>", "</#{tag}", "</>", "</ #{tag}>", "</#{tag} x>"])
end

def markup_piece
  case R.rand(24)
  when 0..6 then start_tag
  when 7..11 then end_tag
  when 12 then pick(["<!-- c -->", "<!---->", "<!-->", "<!--->", "<!-- a -- b -->", "<!-- x --!>", "<!-- unterminated", "<!--é￾-->"])
  when 13 then pick(["<!DOCTYPE html>", "<!doctype HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\">", "<!DOCTYPE html SYSTEM \"about:legacy-compat\">", "<!DOCTYPE>", "<!DOCTYPE html PUBLIC 'x' 'y'>", "<!DOCTYPE \u00e9l\u00e9ment>", "<!DOCTYPE \u00a0>"])
  when 14 then pick(["<?php echo 1 ?>", "<?xml version=\"1.0\"?>", "<?x>", "<?>", "<?x ", "<? y>", "<?\u00e9t\u00e9 x?>", "<?a\u00a0b?>"])
  when 15 then pick(["<!bogus>", "<!>", "<![CDATA[x]]>", "< p>", "<1>", "<_x>", "<:y>", "<", "a < b", "<>"])
  when 16 then "<script>#{pick(["alert(1)", "a<b && c>d", "</div>", "x</scr", "</SCRIPT>"])}#{pick(["</script>", "</script >", "", "</style>"])}"
  when 17 then "<style>#{pick(["p { color: red }", "a > b", "</p>"])}#{pick(["</style>", ""])}"
  when 18 then "\u0000"
  else text_piece
  end
end

def random_markup(max)
  Array.new(R.rand(0..max)) { chance(0.55) ? markup_piece : text_piece }.join
end

def random_text_for_links(max)
  Array.new(R.rand(0..max)) do
    case R.rand(8)
    when 0..2 then pick(URLS)
    when 3 then pick(["<a href=\"http://x.com\">http://x.com</a>", "<pre>www.a.com</pre>", "<code>http://b.com", "<kbd>x</kbd>", "<script>www.s.com</script>", "<b>", "</b>", "<a>", "<ab>", "<"])
    else pick(WORDS + [" ", " ", ". ", ", ", "!", "?", ":", ";", ")", "(", "]", "\"", "'", "»", "：", "x"])
    end
  end.join
end

URI_PIECES = ["java", "script", "JaVa", ":", "&#58;", "&#058;", "&#x3a;", "&#X3A;", "&#x003a", "&colon;", "%3A", "%3a", "&#37;3A", "&#x70", "data",
              "image/png", "image/svg+xml", "text/plain", ";", ",", "base64", " ", "\t", "\n", "&#0;", "&#9;", "`", "é", "ā", "Ā", "&amp;", "&amp;#58;",
              "&lt;", "&#1114111;", "&#1114110;", "&#x10FFFE;", "&#1;", "mailto", "http", "https", "vbscript", "x", "-", "+", ".", "&#59;", "//",
              "a@b", "\u0001", "\u00a0", "\"", "'", "#", "?", "%", "&#", "&#;", "&#x;", "&a", "&ap", "&apos;", "&quot;", "&gt;", "&#65", "Σ:"].freeze

def random_uri = Array.new(R.rand(0..8)) { pick(URI_PIECES) }.join

# An <a> whose href is `uri` (attribute-escaped, so the parser hands Loofah `uri` back), with an
# allowed attribute before it half the time: those rewrite the href before it is checked.
def href_fragment(uri)
  href = %( href="#{uri.gsub("&", "&amp;").gsub('"', "&quot;")}")
  other = %( class="#{pick(["x y", "a\"b", "", "c"])}")
  "<a#{chance(0.5) ? other + href : href + other} title=t>#{pick(WORDS)}</a>"
end

def safely
  { "ok" => yield }
rescue => e
  { "error" => "#{e.class}: #{e.message}" }
end

cases = []
COUNT.times do |i|
  doc_input = (chance(0.3) ? pick(["<!DOCTYPE html>", "<!-- lead -->\n", "  \n", "<?pi x?>", "﻿"]) : "") + random_markup(i % 4 == 0 ? 60 : 25)
  fragment_input = random_markup(i % 4 == 1 ? 60 : 20)
  link_input = random_text_for_links(i % 4 == 2 ? 40 : 12)
  plain = Array.new(R.rand(0..12)) { chance(0.3) ? pick(["\n", "\n\n", "\r\n", "\n\n\n", "\r", " \n"]) : text_piece }.join
  simple_format_input = chance(0.5) ? plain : fragment_input
  uri = random_uri
  href = href_fragment(chance(0.5) ? uri : random_uri)
  cases << {
    "document" => doc_input,
    "parse" => dump_document(Nokogiri::HTML4::Document.parse(doc_input, nil, "UTF-8")),
    "fragment" => fragment_input,
    "fragment_html" => Loofah.html4_fragment(fragment_input).to_html,
    "strip_tags" => H.strip_tags(fragment_input),
    "sanitize" => H.sanitize(fragment_input),
    "sanitize_recap" => H.sanitize(fragment_input, tags: RECAP_TAGS, attributes: RECAP_ATTRIBUTES),
    "uri" => uri,
    "allowed_uri" => safely { Loofah::HTML5::Scrub.allowed_uri?(uri).to_s },
    "href_fragment" => href,
    "href" => safely { H.sanitize(href) },
    "simple_format_input" => simple_format_input,
    "simple_format" => H.simple_format(simple_format_input),
    "links" => link_input,
    "auto_link" => safely { Rinku.auto_link(link_input, :all, COMMENT_LINK_ATTRS) },
    "comment_body" => safely { Rinku.auto_link(H.strip_tags(fragment_input + link_input).to_str, :all, COMMENT_LINK_ATTRS) },
    "recap_summary" => safely { H.sanitize(Rinku.auto_link(link_input + fragment_input, :all, RECAP_LINK_ATTRS), tags: RECAP_TAGS, attributes: RECAP_ATTRIBUTES) },
  }
end
# One case per line: the parse dumps are too deep to pretty-print usefully.
File.write(OUT, %({"seed":#{SEED},"count":#{COUNT},"cases":[\n#{cases.map { JSON.generate(_1) }.join(",\n")}\n]}\n))
puts "wrote #{cases.size} cases to #{OUT}"
