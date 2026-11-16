# frozen_string_literal: true

# Generates installment-message.golden.json: the real Installment#message_snippet, #featured_image_url and
# #tags for the messages the port is tested on.
#   bundle exec rails runner nextjs/src/server/html/__fixtures__/generate-installment-message-golden.rb > installment-message.golden.json
messages = [
  "<p>First paragraph</p><p>Second<br/>line &amp; more</p>",
  "Just text, no markup",
  "<p>#{"lorem ipsum " * 40}</p>",
  "<p>#{"a" * 250}</p>",
  "<figure><img src=\"https://example.com/a.png\" alt=\"x\"></figure><p>Body</p>",
  "<p>lead</p><figure><img src=\"https://example.com/a.png\"></figure>",
  "<figure><figcaption>x</figcaption></figure>",
  "<p>x</p><p>#Ruby on #Rails</p>",
  "<p>x</p><p>#iOS #q&a #C++ #hello_world #foo-bar #Ünï #123go #ABCDef #a'b</p>",
  "<p>x</p><p>#a #a #A</p>",
  "<p>x</p><div>#a</div>",
  "   ",
  "<p>#</p>",
  "Tom &amp; Jerry<br>and <b>bold</b> <script>x</script> text &lt;b&gt;"
]
rows = messages.map do |m|
  inst = Installment.new(message: m)
  { message: m, snippet: inst.message_snippet, featured: inst.featured_image_url, tags: inst.tags }
end
puts JSON.generate(rows)
