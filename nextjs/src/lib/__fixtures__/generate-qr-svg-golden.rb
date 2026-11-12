# frozen_string_literal: true
# Regenerates qr-tables.ts and qr-svg.golden.json: bundle exec ruby nextjs/src/lib/__fixtures__/generate-qr-svg-golden.rb nextjs/src/lib/qr-tables.ts nextjs/src/lib/__fixtures__/qr-svg.golden.json
require "erb"
require "rqrcode_core"
require "json"

h_blocks = (0...40).map { |v| RQRCodeCore::QRRSBlock::RS_BLOCK_TABLE[v * 4 + 3] }
out = +"// Generated from rqrcode_core 1.2.0 (level :h only): QRRSBlock::RS_BLOCK_TABLE, QRUtil::PATTERN_POSITION_TABLE and QRMAXBITS[:h].\n"
out << "// Each RS row is [count, total, data, count, total, data] per version 1..40.\n"
out << "export const RS_BLOCKS_H: number[][] = #{h_blocks.to_json.gsub('],[', "],\n  [")};\n\n"
out << "export const PATTERN_POSITIONS: number[][] = #{RQRCodeCore::QRUtil::PATTERN_POSITION_TABLE.to_json.gsub('],[', "],\n  [")};\n\n"
out << "export const MAX_BITS_H: number[] = #{RQRCodeCore::QRMAXBITS[:h].to_json};\n"
File.write(ARGV[0], out)

# Golden vectors: provisioning-URI-like inputs of many lengths, rendered the way Settings::TotpController does.
require "rqrcode"
vectors = {}
srand(7)
emails = ["a@example.com", "seller+totp@example.com", "x" * 40 + "@example.org", "y" * 120 + "@example.net", "z" * 200 + "@example.com", "first.last@sub.example.co.uk"]
secrets = Array.new(6) { |i| Array.new(32) { "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[rand(32)] }.join }
emails.each_with_index do |email, i|
  uri = "otpauth://totp/Gumroad:#{ERB::Util.url_encode(email)}?secret=#{secrets[i]}&issuer=Gumroad"
  vectors[uri] = RQRCode::QRCode.new(uri).as_svg(module_size: 4, offset: 16, fill: "ffffff", use_path: true, viewbox: true)
end
# Longer inputs, to walk through the versions (and the remainder bits of the larger ones).
[10, 60, 120, 200, 330, 520].each do |len|
  data = Array.new(len) { |k| ("a".."z").to_a[(k * 7 + len) % 26] }.join
  vectors[data] = RQRCode::QRCode.new(data).as_svg(module_size: 4, offset: 16, fill: "ffffff", use_path: true, viewbox: true)
end
File.write(ARGV[1], JSON.pretty_generate(vectors))
