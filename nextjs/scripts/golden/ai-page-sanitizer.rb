# frozen_string_literal: true

# Produces nextjs/src/server/ai/__fixtures__/ai-page-sanitizer.golden.json: Ai::PageSanitizer.sanitize_with_report run by the real class
# (Loofah 2.25 over Nokogiri/libxml2) on hand-written and seeded random markup, which the Node port replays byte for byte. Nothing here
# re-implements Ruby behaviour. The class needs no database, so it runs under plain ruby in the app's bundle (the seeded inputs of
# html.golden.json are reused so the parser's own corpus also goes through the sanitizer):
#   docker exec gr-ruby-c25m bash -c 'source /tmp/env25.sh; cd /app && bundle exec ruby nextjs/scripts/golden/ai-page-sanitizer.rb'
require "json"
require "active_support/all"
require "loofah"
require "addressable/uri"
require "cgi"

module Ai; end
require_relative "../../../app/services/ai/page_sanitizer"

OUT = ENV.fetch("OUT", File.expand_path("../../src/server/ai/__fixtures__/ai-page-sanitizer.golden.json", __dir__))
SEED = Integer(ENV.fetch("SEED", 5150))
RANDOM_COUNT = Integer(ENV.fetch("COUNT", 600))

ALLOWED_TAG_LIST = Ai::PageSanitizer::ALLOWED_TAGS
ALLOWED_ATTR_LIST = Ai::PageSanitizer::ALLOWED_ATTRIBUTES

HANDWRITTEN = {
  "a plain paragraph" => "<p>Hello</p>",
  "a full document is unwrapped" => "<!DOCTYPE html><html lang=\"en\"><head><title>t</title><meta charset=\"utf-8\"></head><body class=\"x\"><h1>Hi</h1></body></html>",
  "a second body and html are unwrapped" => "<html><body><p>a</p></body></html><html><body><p>b</p></body></html>",
  "a body at the start of a line becomes the fragment root" => "\n<body onload=\"x()\"><p>a</p></body>",
  "a head with a style and a stylesheet link" => "<head><style>p { color: red }</style><link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter\"></head><p>x</p>",
  "meta refresh is removed" => "<meta http-equiv=\"refresh\" content=\"0;url=https://example.com\"><p>x</p>",
  "meta refresh in upper case is removed" => "<META HTTP-EQUIV=\"REFRESH\" CONTENT=\"0\"><p>x</p>",
  "a meta tag that is not a refresh is not allowlisted" => "<meta name=\"viewport\" content=\"width=device-width\"><p>x</p>",
  "an iframe is removed with its reason" => "<iframe src=\"https://www.youtube.com/embed/x\" width=\"560\"></iframe><p>after</p>",
  "an iframe with nested content" => "<div><iframe src=\"a\"><p>inner</p></iframe></div>",
  "an object and embed are removed" => "<object data=\"x.swf\"><embed src=\"x.swf\"></object>",
  "a tag outside the allowlist" => "<marquee>x</marquee><center>y</center><font color=\"red\">z</font>",
  "a custom element is removed" => "<foo-bar x=\"1\">hi</foo-bar><x:y>z</x:y>",
  "an allowed script host" => "<script src=\"https://cdn.tailwindcss.com\"></script><script src=\"https://cdn.jsdelivr.net/npm/x\"></script><script src=\"https://unpkg.com/x\"></script>",
  "a script host in capitals" => "<script src=\"https://CDN.JSDELIVR.NET/npm/x\"></script>",
  "a script over http is removed" => "<script src=\"http://cdn.jsdelivr.net/npm/x\"></script>",
  "a script on another host is removed" => "<script src=\"https://evil.example.com/x.js\"></script>",
  "a script host with userinfo" => "<script src=\"https://cdn.jsdelivr.net@evil.example.com/x.js\"></script>",
  "a script with an invalid uri" => "<script src=\"https://cdn.jsdelivr.net/a b\"></script>",
  "a script with a blank src" => "<script src=\"\"></script><script src=\"   \"></script>",
  "a script with a valueless src" => "<script src></script>",
  "script srcs URI.parse rejects" => [" https://cdn.jsdelivr.net/x", "https://cdn.jsdelivr.net/x y", "https://cdn.jsdelivr.net/x|y", "https://cdn.jsdelivr.net/x#a#b", "https://cdn.jsdelivr.net:8x/x", "https://cdn.jsdelivr.net/é", "https://cdn.jsdelivr.net/%zz", "https://cdn.jsdelivr.net/x\\y", "https://cdn.jsdelivr.net/{x}"].map { |src| %(<script src="#{src}"></script>) }.join,
  "script srcs URI.parse accepts" => ["https://cdn.jsdelivr.net/x?a=b c", "https://cdn.jsdelivr.net/x?a[]=1", "HTTPS://CDN.JSDELIVR.NET/x", "https://cdn.jsdelivr.net:/x", "https://cdn.jsdelivr.net", "https://u:p@cdn.jsdelivr.net/", "https://cdn.jsdelivr.net/x?q={}", "https://cdn.jsdelivr.net./x", "https://cdn.jsdelivr.net:443/npm/@tailwindcss/browser@4", "https://unpkg.com/x#frag", "https://unpkg.com/x?q=1#frag/?"].map { |src| %(<script src="#{src}"></script>) }.join,
  "script srcs with another scheme" => ["//cdn.jsdelivr.net/x", "https:cdn.jsdelivr.net", "http://unpkg.com/x", "ftp://unpkg.com/x", "javascript:alert(1)", "cdn.jsdelivr.net/x"].map { |src| %(<script src="#{src}"></script>) }.join,
  "report values with C1 controls" => "<marquee title=\"a\u0085b\u009fc d\">x</marquee>",
  "an inline script" => "<script>var a = 1 < 2 && 3 > 2; document.title = \"x\";</script>",
  "an inline script closed by a style end tag" => "<script>a</style><p>b</p>",
  "an unterminated script" => "<p>a</p><script>alert(1)",
  "an inline style" => "<style>a > b { content: \"</p>\"; }</style>",
  "a stylesheet link on the allowed hosts" => "<link rel=\"stylesheet\" href=\"https://fonts.bunny.net/css?family=x\"><link rel=\"STYLESHEET preload\" href=\"https://fonts.googleapis.com/x\">",
  "a stylesheet link on another host" => "<link rel=\"stylesheet\" href=\"https://evil.example.com/x.css\">",
  "a link that is not a stylesheet" => "<link rel=\"icon\" href=\"https://fonts.googleapis.com/x\"><link href=\"https://fonts.googleapis.com/x\">",
  "a form action is removed" => "<form action=\"https://evil.example.com\" method=\"post\"><input name=\"a\" value=\"b\"></form>",
  "a form with a blank action" => "<form action=\"\"><button>go</button></form>",
  "a form with a valueless action" => "<form action><button>go</button></form>",
  "event handler attributes are allowed by name" => "<div onclick=\"x()\" onMouseOver=\"y()\" on=\"z\" on1=\"w\" onx_y=\"v\">x</div>",
  "data and aria attributes" => "<div data-gumroad-field=\"name\" DATA-X=\"1\" aria-label=\"l\" aria-custom=\"c\" data-=\"empty\">x</div>",
  "attributes outside the allowlist" => "<div bgcolor=\"red\" align=\"center\" itemprop=\"x\" is=\"y\" slot=\"z\" xml:lang=\"en\" lang=\"en\">x</div>",
  "uppercase attribute names are lowered by the parser" => "<DIV CLASS=\"a\" ID=\"b\" STYLE=\"color:red\">x</DIV>",
  "duplicate attributes keep the first" => "<div class=\"a\" class=\"b\" id=x id=y>x</div>",
  "valueless attributes" => "<input disabled checked required autofocus><button disabled>x</button><details open><summary>s</summary></details>",
  "boolean attributes with values" => "<input disabled=\"disabled\" checked=\"false\" selected=\"\"><select><option selected>a</option></select>",
  "a javascript href" => "<a href=\"javascript:alert(1)\">x</a>",
  "a javascript href with whitespace and case" => "<a href=\" JaVa\tScRiPt:alert(1)\">x</a><a href=\"java&#x09;script:alert(1)\">y</a><a href=\"java&Tab;script:x\">z</a>",
  "a javascript href percent encoded" => "<a href=\"%6Aavascript:alert(1)\">x</a><a href=\"%256Aavascript:alert(1)\">y</a>",
  "a javascript href with control characters" => "<a href=\"java\u0001script:alert(1)\">x</a>",
  "an entity encoded javascript href" => "<a href=\"&#106;avascript:alert(1)\">x</a><a href=\"&#x6A;avascript:1\">y</a><a href=\"&amp;#106;avascript:1\">z</a>",
  "a data href is blocked" => "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
  "a data image src is kept" => "<img src=\"data:image/png;base64,AAAA\"><video poster=\"data:image/jpeg;base64,AAAA\" src=\"data:video/mp4;base64,AAAA\"></video>",
  "a data html src is blocked" => "<img src=\"data:text/html,x\"><audio src=\"data:application/pdf;base64,AAAA\"></audio><source src=\"data:image/svg+xml,<svg/>\">",
  "a data form action" => "<form action=\"data:text/html,x\"></form>",
  "a data poster" => "<video poster=\"data:text/html,x\"></video>",
  "an srcset with a javascript url" => "<img srcset=\"javascript:alert(1) 1x, a.png 2x\">",
  "an srcset with a data url" => "<img srcset=\"data:text/html,x 1x\"><img srcset=\"data:image/png;base64,AAAA 1x, b.png 2x\">",
  "an srcset with plain urls" => "<img srcset=\"a.png 1x, b.png 2x\" sizes=\"100vw\" src=\"a.png\"><picture><source srcset=\"c.webp 1x\" media=\"(min-width: 1px)\" type=\"image/webp\"></picture>",
  "an srcset with odd separators" => "<img srcset=\"a.png ,  , b.png\"><img srcset=\"  \"><img srcset>",
  "target _blank gains rel" => "<a href=\"https://example.com\" target=\"_blank\">x</a>",
  "target _blank replaces an existing rel" => "<a href=\"https://example.com\" target=\" _BLANK \" rel=\"author\">x</a>",
  "target _blank on a non anchor gains no rel" => "<form target=\"_blank\"></form><button target=\"_blank\">x</button>",
  "target navigation is blocked" => "<a href=\"x\" target=\"_top\">a</a><a href=\"x\" target=\" _Parent \">b</a><a href=\"x\" target=\"_unfencedTop\">c</a><a href=\"x\" target=\"_self\">d</a>",
  "target valueless" => "<a href=\"x\" target>x</a>",
  "rel set after other attributes" => "<a target=\"_blank\" href=\"x\" class=\"c\">x</a><a rel=\"nofollow\" target=\"_blank\">y</a>",
  "svg elements and attributes" => "<svg viewBox=\"0 0 10 10\" xmlns=\"http://www.w3.org/2000/svg\" preserveAspectRatio=\"none\"><defs><linearGradient id=\"g\" x1=\"0\"><stop offset=\"0\" stop-color=\"red\"/></linearGradient></defs><path d=\"M0 0L10 10\" fill=\"url(#g)\" stroke-width=\"2\"/><circle cx=\"5\" cy=\"5\" r=\"2\"/><g transform=\"rotate(1)\"><rect x=\"1\" y=\"1\" rx=\"1\" width=\"1\" height=\"1\"/></g></svg>",
  "svg script and foreignObject are removed" => "<svg><script>alert(1)</script><foreignObject><p>x</p></foreignObject><use href=\"#a\"/><a xlink:href=\"javascript:1\"><text>t</text></a></svg>",
  "svg event handlers" => "<svg onload=\"alert(1)\"><circle onclick=\"x()\"/></svg>",
  "a table with all sections" => "<table><caption>c</caption><colgroup><col span=\"2\"></colgroup><thead><tr><th scope=\"col\">a</th></tr></thead><tbody><tr><td colspan=\"2\" rowspan=\"1\">b</td></tr></tbody><tfoot><tr><td>c</td></tr></tfoot></table>",
  "a table with stray cells and text" => "<td>a</td><tr><td>b</td></tr>text<table>x<tr><td>y",
  "lists with nesting and stray items" => "<ul><li>a<ul><li>b</ul><li>c</ul><li>stray</li><ol><li>1<li>2</ol>",
  "definition lists" => "<dl><dt>t<dd>d<dt>t2<dd>d2</dl>",
  "headings and phrasing" => "<h1>a<h2>b</h1></h2><b><i>x</b></i><u>y<s>z</u></s>",
  "nested paragraphs auto close" => "<p>a<p>b<div>c<p>d</div>",
  "a block in a paragraph" => "<p>a<ul><li>b</ul>c</p>",
  "unclosed inline formatting" => "<p><b>bold <i>italic</p><p>next",
  "void elements" => "<br><br/><hr><img src=a.png><input type=text><wbr><area shape=rect><col><source src=a><track src=b><link rel=stylesheet href=https://fonts.googleapis.com/x>",
  "void end tags" => "</br></p></div>text</img>",
  "self closing non void" => "<div/><span/>text<p/>",
  "a button, select and textarea" => "<button type=\"submit\" name=\"n\" value=\"v\">b</button><select name=\"s\" multiple><optgroup label=\"g\"><option value=\"1\">1</option></optgroup></select><textarea name=\"t\" rows=\"3\" cols=\"4\">a\n<b>c</textarea>",
  "details dialog and other new elements" => "<details><summary>s</summary>x</details><dialog open>d</dialog><search>s</search><template><p>t</p></template><slot name=\"s\"></slot><hgroup><h1>a</h1></hgroup>",
  "ruby annotations" => "<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>",
  "audio and video" => "<video controls autoplay muted loop playsinline poster=\"p.png\" width=\"1\" height=\"2\"><source src=\"a.mp4\" type=\"video/mp4\"><track kind=\"captions\" src=\"c.vtt\" srclang=\"en\"></video><audio controls src=\"a.mp3\"></audio>",
  "a canvas, map and meter" => "<canvas id=\"c\" width=\"1\"></canvas><map name=\"m\"><area coords=\"0,0,1,1\" href=\"x\" shape=\"rect\"></map><meter min=\"0\" max=\"1\" value=\"0.5\"></meter><progress value=\"1\" max=\"2\"></progress>",
  "entities in text" => "<p>&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &eacute; &hellip; &euro; &foo; &#65; &#x41; &#0; &#xD800; &</p>",
  "entities in attributes" => "<a href=\"?a=1&b=2&amp;c=3&copy=4&#38;d=5\" title=\"&lt;b&gt; &quot;q&quot; &amp;\" class=\"&nbsp;x\">x</a>",
  "quotes in attribute values" => "<div title='say \"hi\"' class=\"it's\" id='both \" and &apos;'>x</div>",
  "href escaping on serialization" => "<a href=\"  http://example.com/a b/é?x=[1]&y=é#f\">x</a><img src=\"über.png\"><a name=\"a b\">n</a>",
  "a form action with spaces and a javascript url" => "<form action=\" javascript:alert(1)\"></form>",
  "comments" => "<!-- a --><p>b</p><!-- c -- d --><!----><!--> <!---> <!-- unterminated",
  "conditional comments" => "<!--[if IE]><p>ie</p><![endif]--><!--[if !IE]><!--><p>x</p><!--<![endif]-->",
  "cdata and bogus declarations" => "<![CDATA[x]]><!bogus><!><?php echo 1 ?><?xml version=\"1.0\"?>",
  "unicode text" => "<p>café naïve 日本語 😀   ​ 　   \u0085</p>",
  "unicode attributes" => "<div title=\"日本語 😀 é\" class=\"ñ\" data-x=\"é\">x</div>",
  "unicode tag and attribute names" => "<é>x</é><div é=\"1\" data-é=\"2\" aria-é=\"3\">y</div>",
  "control characters in text" => "<p>a\u0001b\u0008c\td\u000be\u000cf\u007fg</p>",
  "control characters in attribute values" => "<div title=\"a\u0001b\u007fc\td\ne\">x</div><a href=\"a\u0001b\">y</a>",
  "a nul character" => "<p>a\u0000b</p>",
  "an attribute value with newlines" => "<div title=\"a\nb\r\nc\rd\">x</div>",
  "crlf in text" => "<p>a\r\nb\rc\nd</p>",
  "whitespace only" => "   \n\t ",
  "an empty string" => "",
  "text only" => "just text & more",
  "a lone angle bracket" => "a < b > c <",
  "a stray end tag" => "</div>after",
  "nested divs" => "<div><div><div><div><span>deep</span></div></div></div></div>",
  "deep nesting the parser refuses" => ("<div>" * 300),
  "a long attribute name" => "<div #{'a' * 150}=\"1\" class=\"c\">x</div>",
  "an unterminated attribute" => "<div class=\"a>x</div><p>y</p>",
  "an unquoted attribute with slash" => "<a href=http://example.com/x/>y</a>",
  "attribute names with odd characters" => "<div a\"b=\"1\" =x c d= e='f' g=\"\" h>x</div>",
  "xml namespaced attributes" => "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\"><path xlink:href=\"#a\" xml:space=\"preserve\" d=\"M0\"/></svg><div xml:lang=\"en\" lang=\"en\">x</div>",
  "a namespaced tag" => "<o:p>x</o:p><svg:rect/>",
  "style attribute with a url" => "<div style=\"background: url(javascript:alert(1))\">x</div><div style=\"expression(alert(1))\">y</div>",
  "a base tag" => "<base href=\"https://evil.example.com/\"><p>x</p>",
  "a title tag and noscript" => "<title>t</title><noscript><p>n</p></noscript><noframes>f</noframes>",
  "an input with url attributes" => "<input type=\"image\" src=\"javascript:alert(1)\"><input formaction=\"x\" value=\"v\">",
  "a href that is not a url attribute elsewhere" => "<div href=\"javascript:alert(1)\">x</div><img href=\"javascript:1\" src=\"a.png\">",
  "an a without href but with javascript in title" => "<a title=\"javascript:alert(1)\">x</a>",
  "label for and form attributes" => "<form id=\"f\"></form><label for=\"i\">l</label><input id=\"i\" form=\"f\" list=\"d\"><datalist id=\"d\"><option value=\"1\"></datalist><output for=\"i\">o</output>",
  "pre and code keep their whitespace" => "<pre>\n  a\n\n  b</pre><pre>\n\nx</pre><code>  x  </code>",
  "a textarea keeps a leading newline" => "<textarea>\nx</textarea>",
  "inline scripts around block elements" => "<div><script>1</script><p>x</p><script>2</script></div>",
  "block children serialization newlines" => "<div><p>a</p><p>b</p></div><div>text<p>x</p></div><p><div>y</div><div>z</div></p>",
  "tailwind page" => "<script src=\"https://cdn.tailwindcss.com\"></script><div class=\"min-h-screen bg-gray-50 flex items-center justify-center\"><h1 class=\"text-4xl font-bold\" data-gumroad-field=\"name\">Name</h1><a href=\"https://example.com\" target=\"_blank\" class=\"btn\">Go</a><a data-gumroad-action=\"buy\" data-gumroad-product=\"x\">Buy</a></div>",
  "many removals fill the report cap" => (1..120).map { |i| "<iframe src=\"https://example.com/#{i}\"></iframe>" }.join,
  "many attribute removals fill the report cap" => (1..120).map { |i| "<div bogus#{i}=\"v\">x</div>" }.join,
  "mixed removals past the cap" => (1..60).map { |i| "<marquee x=\"#{i}\">a</marquee><div bad#{i}=\"v\">b</div>" }.join,
  "report values lose control characters" => "<iframe title=\"a\u0001b\u007f\" src=\"x\"></iframe><div onclick=\"x\" bad=\"a\u0002b\"></div>",
  "report attrs with duplicate names" => "<marquee a=\"1\" a=\"2\" b>x</marquee>",
  "a very long attribute value" => "<div title=\"#{'x' * 5000}\" bogus=\"#{'y' * 5000}\">z</div>",
}.freeze

def run(html)
  result = Ai::PageSanitizer.sanitize_with_report(html)
  { "ok" => { "html" => result.html, "report" => result.report.deep_stringify_keys } }
rescue StandardError => e
  { "error" => "#{e.class}: #{e.message[0, 120]}" }
end

# --- seeded random markup ---------------------------------------------------------------------------
R = Random.new(SEED)
def pick(list) = list[R.rand(list.size)]
def chance(p) = R.rand < p

EXTRA_TAGS = %w[html head body iframe meta link script style object embed marquee center font frameset frame applet base title noscript foo x-y svg:rect o:p].freeze
ATTR_NAMES = (ALLOWED_ATTR_LIST.sample(30, random: R) + %w[onclick onload onerror data-x data-gumroad-field aria-label aria-foo bgcolor align xml:lang xlink:href srcdoc formaction href src srcset target rel action poster style class id]).uniq.freeze
URL_VALUES = ["https://example.com/x", "http://example.com", "javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:x", "&#106;avascript:x", "%6Aavascript:x", "data:text/html,x", "data:image/png;base64,AAAA", "data:video/mp4;base64,AA",
              "data:font/woff;base64,AA", "data:application/json,{}", "https://cdn.jsdelivr.net/npm/x", "https://CDN.TAILWINDCSS.COM/x", "https://unpkg.com@evil.example.com/", "https://fonts.googleapis.com/css", "http://fonts.googleapis.com/css",
              "#anchor", "/relative/path?q=1&r=2", "mailto:a@example.com", "", "  ", "a b", "é/ü", "a.png 1x, b.png 2x", "javascript:1 1x, a.png 2x", "data:text/html,x 1x", "_blank", " _TOP ", "_parent", "_self", "stylesheet", "STYLESHEET preload", "refresh", "Refresh"].freeze
WORDS = ["hello", "Tom & Jerry", "a<b", "café", "日本語", "😀", " ", "\n", "\t", "\r\n", "\u0001", "&amp;", "&lt;", "&nbsp;", "&copy;", "&foo;", "&#65;", "&#0;", "&", "--", "]]>", " ", " "].freeze

def random_attr
  name = pick(ATTR_NAMES)
  name = name.upcase if chance(0.1)
  return " #{name}" if chance(0.15)
  value = chance(0.75) ? pick(URL_VALUES) : Array.new(R.rand(1..3)) { pick(WORDS) }.join
  case R.rand(6)
  when 0 then " #{name}=#{value.gsub(/[\s>"'=<`]/, '')}"
  when 1 then " #{name}='#{value.delete("'")}'"
  when 2 then " #{name}=\"#{value}" # unterminated
  else " #{name}=\"#{value.delete('"')}\""
  end
end

def random_start_tag
  tag = chance(0.55) ? pick(ALLOWED_TAG_LIST) : pick(EXTRA_TAGS)
  tag = tag.upcase if chance(0.08)
  attrs = Array.new(R.rand(0..4)) { random_attr }.join
  attrs += %( http-equiv="#{pick(%w[refresh Refresh content-type])}") if tag.downcase == "meta" && chance(0.7)
  "<#{tag}#{attrs}#{pick([">", ">", ">", " />", "/>", " >"])}"
end

def random_end_tag
  tag = chance(0.6) ? pick(ALLOWED_TAG_LIST) : pick(EXTRA_TAGS)
  pick(["</#{tag}>", "</#{tag}>", "</#{tag} >", "</#{tag.upcase}>", "</#{tag}"])
end

def random_piece
  case R.rand(20)
  when 0..8 then random_start_tag
  when 9..12 then random_end_tag
  when 13 then pick(["<!-- c -->", "<!---->", "<!-- unterminated", "<!--[if IE]>x<![endif]-->"])
  when 14 then "<script#{chance(0.6) ? " src=\"#{pick(URL_VALUES)}\"" : ''}>#{pick(['alert(1)', 'a<b', '</div>', ''])}#{pick(['</script>', '', '</style>'])}"
  when 15 then "<style>#{pick(['p{color:red}', 'a>b', '</p>'])}#{pick(['</style>', ''])}"
  when 16 then pick(["<!DOCTYPE html>", "<?php x ?>", "<![CDATA[x]]>", "<!bogus>", "<", "<>", "< p>"])
  else pick(WORDS)
  end
end

def random_markup = Array.new(R.rand(1..14)) { random_piece }.join

generated = Array.new(RANDOM_COUNT) { random_markup }
golden_html = JSON.parse(File.read(File.expand_path("../../src/server/html/__fixtures__/html.golden.json", __dir__)))["cases"].flat_map { |c| [c["fragment"], c["document"]] }

cases = HANDWRITTEN.map { |name, html| { "name" => name, "html" => html, "origin" => "handwritten" }.merge(run(html)) }
cases += generated.each_with_index.map { |html, i| { "name" => "random #{i}", "html" => html, "origin" => "random" }.merge(run(html)) }
cases += golden_html.each_with_index.map { |html, i| { "name" => "parser corpus #{i}", "html" => html, "origin" => "parser" }.merge(run(html)) }
# Callers can hand over nil (a page with no custom HTML).
cases << { "name" => "nil input", "html" => nil, "origin" => "handwritten" }.merge(run(nil))

File.write(OUT, JSON.pretty_generate({ "seed" => SEED, "cases" => cases }) + "\n")
puts "wrote #{cases.size} cases (#{cases.count { |c| c['error'] }} raised) to #{OUT}"
