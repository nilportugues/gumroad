# frozen_string_literal: true

# Regenerates rails-cookies.golden.json with the real ActionDispatch cookie jar, configured the way
# config/application.rb (load_defaults 8.1), session_store.rb and cookie_rotator.rb configure it.
#
#   GEM_HOME=<scratch> gem install actionpack:8.1.3.1 bcrypt:3.1.22
#   GEM_HOME=<scratch> ruby generate-rails-cookies.rb > rails-cookies.golden.json
#   GEM_HOME=<scratch> ruby generate-rails-cookies.rb --read <file.json>  # decrypt cookies made by TS
#
# IVs are pinned so the TypeScript port can be checked byte for byte, not just round-tripped.

gem "actionpack", "8.1.3.1"
gem "bcrypt", "3.1.22"
gem "json", "2.13.2" # Gemfile.lock; json 3.x breaks ActiveSupport::JSON.decode on 8.1.3.1
require "json"
require "action_dispatch"
require "active_support/key_generator"
require "active_support/message_encryptor"
require "active_support/messages/rotation_configuration"
require "bcrypt"

ActiveSupport::JSON::Encoding.escape_html_entities_in_json = true
ActiveSupport::JSON::Encoding.escape_js_separators_in_json = true
ActiveSupport::Messages::Metadata.use_message_serializer_for_metadata = true

SECRET_KEY_BASE = "a" * 64 + "0123456789abcdef" * 4
EXPIRES = Time.utc(2100, 1, 1)

module PinnedIv
  def random_iv
    return super unless $pinned_iv
    self.iv = $pinned_iv
    $pinned_iv
  end
end
OpenSSL::Cipher.prepend(PinnedIv)

def key_generator(digest)
  ActiveSupport::CachingKeyGenerator.new(
    ActiveSupport::KeyGenerator.new(SECRET_KEY_BASE, iterations: 1000, hash_digest_class: digest)
  )
end

# Mirrors config/initializers/cookie_rotator.rb.
def rotations
  config = ActiveSupport::Messages::RotationConfiguration.new
  old = ActiveSupport::KeyGenerator.new(SECRET_KEY_BASE, iterations: 1000, hash_digest_class: OpenSSL::Digest::SHA1)
  config.rotate :encrypted, old.generate_key("authenticated encrypted cookie", ActiveSupport::MessageEncryptor.key_len)
  config.rotate :signed, old.generate_key("signed cookie")
  config
end

def jar(digest: OpenSSL::Digest::SHA256, cookie_header: nil, with_rotations: true)
  env = Rack::MockRequest.env_for("https://gumroad.com/", "HTTP_COOKIE" => cookie_header.to_s).merge(
    "action_dispatch.key_generator" => key_generator(digest),
    "action_dispatch.authenticated_encrypted_cookie_salt" => "authenticated encrypted cookie",
    "action_dispatch.signed_cookie_salt" => "signed cookie",
    "action_dispatch.use_authenticated_cookie_encryption" => true,
    "action_dispatch.use_cookies_with_metadata" => true,
    "action_dispatch.cookies_serializer" => :json,
    "action_dispatch.cookies_rotations" => with_rotations ? rotations : ActiveSupport::Messages::RotationConfiguration.new,
  )
  request = ActionDispatch::Request.new(env)
  ActionDispatch::Cookies::CookieJar.build(request, request.cookies)
end

def write(kind, name, value, iv:, expires: EXPIRES, digest: OpenSSL::Digest::SHA256)
  $pinned_iv = iv && [iv].pack("H*")
  j = jar(digest:)
  j.public_send(kind)[name] = { value:, expires: }
  j[name]
ensure
  $pinned_iv = nil
end

def ruby_reads(kind, name, raw)
  jar(cookie_header: "#{name}=#{Rack::Utils.escape(raw)}").public_send(kind)[name]
end

if ARGV[0] == "--read"
  input = JSON.parse(File.read(ARGV.fetch(1)))
  puts JSON.pretty_generate(input.to_h { |c| [c["label"], ruby_reads(c["kind"], c["name"], c["raw"])] })
  exit
end

session = {
  "session_id" => "0123456789abcdef0123456789abcdef",
  "warden.user.user.key" => [[42], "$2a$11$abcdefghijklmnopqrstuv"],
  "warden.user.user.session" => { "last_sign_in_at" => 1_700_000_000 },
  "_csrf_token" => "Zm9vYmFyYmF6",
  "flash" => { "discard" => [], "flashes" => { "notice" => "Caf\u00e9 <b>&</b> \u2028 \u2713 \"quoted\" \n \u0001 / \u007f" } },
}
remember = [[42], "$2a$11$abcdefghijklmnopqrstuv", "1700000000.123456"]
session_name = "_gumroad_app_session"
iv = "00112233445566778899aabb"

vectors = []
add = ->(label, kind:, name:, raw:, value:, expected:, pinned_iv: nil, expires: EXPIRES) do
  ruby = ruby_reads(kind, name, raw)
  raise "#{label}: Ruby read #{ruby.inspect}, expected #{expected.inspect}" unless ruby == expected
  vectors << { label:, kind:, name:, raw:, value:, expected:, iv: pinned_iv, expires: expires&.utc&.iso8601(3) }
end

current = write(:encrypted, session_name, session, iv:)
add.("session, current SHA256 key", kind: :encrypted, name: session_name, raw: current, value: session, expected: session, pinned_iv: iv)

rotated = write(:encrypted, session_name, session, iv:, digest: OpenSSL::Digest::SHA1)
add.("session, rotated SHA1 key", kind: :encrypted, name: session_name, raw: rotated, value: session, expected: session, pinned_iv: iv)

expired = write(:encrypted, session_name, session, iv:, expires: Time.utc(2001, 1, 1))
add.("session, expired", kind: :encrypted, name: session_name, raw: expired, value: session, expected: nil, pinned_iv: iv, expires: Time.utc(2001, 1, 1))

no_expiry = write(:encrypted, session_name, session, iv:, expires: nil)
add.("session, no expiry", kind: :encrypted, name: session_name, raw: no_expiry, value: session, expected: session, pinned_iv: iv, expires: nil)

seller = write(:encrypted, "current_seller_id", 1234, iv:)
add.("current_seller_id", kind: :encrypted, name: "current_seller_id", raw: seller, value: 1234, expected: 1234, pinned_iv: iv)
add.("current_seller_id replayed as the session", kind: :encrypted, name: session_name, raw: seller, value: 1234, expected: nil)

tampered = current.dup
tampered[5] = tampered[5] == "A" ? "B" : "A"
add.("session, tampered ciphertext", kind: :encrypted, name: session_name, raw: tampered, value: nil, expected: nil)
add.("session, garbage", kind: :encrypted, name: session_name, raw: "not-a-cookie", value: nil, expected: nil)

# Written before use_cookies_with_metadata: no purpose envelope. Rails still reads these.
$pinned_iv = [iv].pack("H*")
primary = key_generator(OpenSSL::Digest::SHA256).generate_key("authenticated encrypted cookie", 32)
bare = ActiveSupport::MessageEncryptor.new(primary, cipher: "aes-256-gcm", serializer: ActiveSupport::MessageEncryptor::NullSerializer)
  .encrypt_and_sign(ActiveSupport::JSON.encode(session))
$pinned_iv = nil
add.("session, no metadata envelope", kind: :encrypted, name: session_name, raw: bare, value: session, expected: session)

signed = write(:signed, "remember_user_token", remember, iv: nil)
add.("remember token, current SHA256 key", kind: :signed, name: "remember_user_token", raw: signed, value: remember, expected: remember)
signed_sha1 = write(:signed, "remember_user_token", remember, iv: nil, digest: OpenSSL::Digest::SHA1)
add.("remember token, rotated SHA1 key", kind: :signed, name: "remember_user_token", raw: signed_sha1, value: remember, expected: remember)
forged = signed.sub(/--\h+\z/) { |sig| "--" + sig[2..].reverse }
add.("remember token, bad signature", kind: :signed, name: "remember_user_token", raw: forged, value: nil, expected: nil)

# Devise::Encryptor.digest/compare: bcrypt over "#{password}#{pepper}".
# Devise's own Encryptor, loaded without activating the rest of the gem.
module Devise
  def self.secure_compare(a, b)
    return false if a.blank? || b.blank? || a.bytesize != b.bytesize
    ActiveSupport::SecurityUtils.fixed_length_secure_compare(a, b)
  end
end
require File.join(Gem::Specification.find_by_name("devise", "4.9.4").gem_dir, "lib/devise/encryptor")

bcrypt = [
  ["correct horse", "pepper-1", 4, ["correct horse", "Correct horse", "correct horse ", ""]],
  ["correct horse", nil, 4, ["correct horse", "correct horsf"]],
  ["pässwörd ✓", "pepper-1", 5, ["pässwörd ✓", "passwor d"]],
  # bcrypt reads 72 bytes, so the pepper of a long password is never hashed.
  ["x" * 80, "pepper-1", 4, ["x" * 80, "x" * 72, "x" * 72 + "anything", "x" * 71]],
  ["x" * 66, "pepper-1", 4, ["x" * 66, "x" * 67, "x" * 66 + "p"]],
].map do |password, pepper, cost, attempts|
  klass = Struct.new(:pepper, :stretches).new(pepper, cost)
  hash = Devise::Encryptor.digest(klass, password)
  { password:, pepper:, cost:, hash:, compare: attempts.to_h { |a| [a, Devise::Encryptor.compare(klass, hash, a)] } }
end

puts JSON.pretty_generate(secret_key_base: SECRET_KEY_BASE, cookies: vectors, bcrypt:)
