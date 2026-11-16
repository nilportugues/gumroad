# frozen_string_literal: true

# Produces mime.golden.json: how the mail gem (2.9.0, pinned in Gemfile.lock) encodes a text part
# whose body the HTML-only templates never exercise — non-ASCII, long lines, "="-heavy markup,
# trailing whitespace, CR line endings — so mime.ts's transfer-encoding negotiation and
# quoted-printable/base64 output are checked against the gem rather than against the two bodies the
# mailer goldens happen to produce. Run with the same gem set as generate-mail-golden.rb.
require "json"
require "mail"
require_relative "../../../../../config/initializers/mail_encodings"

BODIES = {
  "ascii_short" => "Hello\nworld",
  "trailing_space" => "a line with trailing space \nand tab\t\nend ",
  "crlf_and_cr" => "one\r\ntwo\rthree\n",
  "long_ascii_line" => ("word " * 250) + "\n",
  "exactly_72" => "x" * 72,
  "exactly_73" => "x" * 73,
  "equals_boundary" => ("y" * 70) + "=z" + ("w" * 5),
  "equals_heavy" => ('<a b="c" d="e">' * 120),
  "utf8_short" => "Café — ✓\n",
  "utf8_long" => ("Ünïcödé " * 200),
  "utf8_mostly" => "日本語のテキスト" * 30,
  "control_chars" => "bell\aand\x7Fdel\x00nul",
  "only_newlines" => "\n\n\n",
  "empty" => "",
}.freeze

def part_for(content_type, body)
  part = Mail::Part.new
  part.content_type = "#{content_type}; charset=UTF-8"
  part.body = body
  part
end

cases = BODIES.map do |name, body|
  part = part_for("text/plain", body)
  part.transport_encoding = "7bit"
  part.ready_to_send!
  { name:, body:, pack_m: [body].pack("M"), pack_m_base64: [body].pack("m"), part: part.encoded }
end

File.write(File.join(__dir__, "mime.golden.json"), JSON.pretty_generate(cases) + "\n")
puts "wrote #{cases.size} cases"
